import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { ProviderError } from "./provider";
import { boundedJSON } from "./openai-stream";
import type { OAuthAccount, SourceConfig } from "../shared/settings";
import type { AuthorizationState } from "../shared/authorization";

const cloudScope = "https://www.googleapis.com/auth/cloud-platform";
const scope = `openid email ${cloudScope}`;
const token = z
  .string()
  .min(1)
  .max(32768)
  .refine((v) => !/[\r\n\0]/.test(v));
const tokens = z.object({
  access_token: token,
  refresh_token: token.optional(),
  id_token: token.optional(),
  expires_in: z.number().positive().max(86400),
  token_type: z.literal("Bearer"),
  scope: z.string().max(4096).optional(),
});
export interface GoogleRecord {
  clientId: string;
  clientSecret?: string;
  subject: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  search?: OAuthAccount["search"];
}
interface Options {
  read(id: string): GoogleRecord | undefined;
  write(id: string, record: GoogleRecord | undefined): void;
  request: typeof fetch;
  openBrowser(url: string): Promise<void>;
  callbackText: { success: string; failed: string };
  now?: () => number;
  loginTimeoutMs?: number;
}

/** Google desktop OAuth. Tokens stay in main; requests are restricted to known APIs. */
export class GoogleOAuth {
  private pending = new Map<string, AbortController>();
  private authorizations = new Map<string, AuthorizationState>();
  private sessions = new Map<string, AbortController>();
  private refreshing = new Map<string, Promise<string>>();
  constructor(private options: Options) {}
  private now() {
    return (this.options.now || Date.now)();
  }
  status(id: string): OAuthAccount {
    const record = this.options.read(id);
    return {
      email: record?.email || "",
      status: record?.refreshToken ? "connected" : "signedOut",
      billing: "api",
      search: record?.search,
    };
  }
  cancel(id: string) {
    this.pending.get(id)?.abort();
    this.authorizations.delete(id);
  }
  authorization(id: string): AuthorizationState | null {
    const value = this.authorizations.get(id);
    return value &&
      value.expiresAt > this.now() &&
      !this.pending.get(id)?.signal.aborted
      ? { ...value }
      : null;
  }
  async openAuthorization(id: string, authorizationId: string) {
    const current = this.authorization(id),
      stored = this.authorizations.get(id);
    if (!current?.url || current.id !== authorizationId || !stored)
      throw new ProviderError("authExpired");
    try {
      await this.options.openBrowser(current.url);
      stored.browserError = false;
    } catch {
      stored.browserError = true;
      throw new ProviderError("oauthBrowserOpenFailed");
    }
  }
  private session(id: string) {
    if (!this.sessions.has(id)) this.sessions.set(id, new AbortController());
    return this.sessions.get(id)!;
  }
  private stop(id: string) {
    this.sessions.get(id)?.abort();
    this.sessions.delete(id);
    this.refreshing.delete(id);
  }
  close() {
    for (const c of this.pending.values()) c.abort();
    for (const c of this.sessions.values()) c.abort();
    this.sessions.clear();
    this.authorizations.clear();
  }
  private async exchange(form: Record<string, string>, signal: AbortSignal) {
    const response = await this.options.request(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      },
    );
    const data = await boundedJSON(response);
    if (!response.ok)
      throw new ProviderError(
        data?.error === "invalid_grant"
          ? "accountSignInRequired"
          : data?.error === "invalid_client"
            ? "googleClientInvalid"
            : "accountUnavailable",
      );
    return tokens.parse(data);
  }
  async signIn(
    source: SourceConfig,
    clientSecret?: string,
  ): Promise<OAuthAccount> {
    const id = source.id,
      clientId = source.oauthClientId;
    if (!clientId) throw new ProviderError("googleClientRequired");
    if (this.pending.has(id) || this.pending.size >= 4)
      throw new ProviderError("oauthBusy");
    const previous = this.options.read(id);
    if (previous && previous.clientId !== clientId)
      throw new ProviderError("googleClientChanged");
    const secret = clientSecret || previous?.clientSecret || "";
    const controller = new AbortController(),
      signal = controller.signal;
    this.pending.set(id, controller);
    const authorization: AuthorizationState = {
      id: randomUUID(),
      status: "preparing",
      expiresAt: this.now() + (this.options.loginTimeoutMs || 300000),
    };
    this.authorizations.set(id, authorization);
    const timer = setTimeout(
      () => controller.abort("timeout"),
      this.options.loginTimeoutMs || 300000,
    );
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    let redirect = "",
      accepted = false;
    let resolve!: (code: string) => void, reject!: (e: Error) => void;
    const callback = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void callback.catch(() => {});
    const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'",
      );
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      const fail = () => {
        res.writeHead(400);
        res.end(this.options.callbackText.failed);
      };
      if (
        !redirect ||
        req.method !== "GET" ||
        req.headers.host !== new URL(redirect).host ||
        (req.url?.length || 0) > 12000
      )
        return fail();
      const url = new URL(req.url || "/", redirect);
      if (
        accepted ||
        signal.aborted ||
        url.origin !== new URL(redirect).origin ||
        url.pathname !== "/oauth/callback"
      )
        return fail();
      for (const key of ["state", "code", "error"])
        if (url.searchParams.getAll(key).length > 1) return fail();
      if (url.searchParams.get("state") !== state) return fail();
      accepted = true;
      authorization.status = "finishing";
      delete authorization.url;
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || code.length > 8192) {
        fail();
        reject(
          new ProviderError(
            url.searchParams.get("error") === "access_denied"
              ? "oauthDeclined"
              : "authorizationFailed",
          ),
        );
        return;
      }
      res.end(this.options.callbackText.success);
      resolve(code);
    });
    const abort = () =>
      reject(
        new ProviderError(
          signal.reason === "timeout" ? "authExpired" : "oauthCancelled",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((yes, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", yes);
      });
      signal.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === "string")
        throw new ProviderError("authorizationFailed");
      redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope,
        state,
        nonce,
        access_type: "offline",
        prompt: "consent",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      });
      if (previous?.email) params.set("login_hint", previous.email);
      authorization.url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
      authorization.status = "waiting";
      // Creating a session never opens a browser; opening is an explicit UI action.
      const data = await this.exchange(
        {
          client_id: clientId,
          ...(secret ? { client_secret: secret } : {}),
          code: await callback,
          redirect_uri: redirect,
          grant_type: "authorization_code",
          code_verifier: verifier,
        },
        signal,
      );
      if (
        !data.id_token ||
        !data.scope?.split(/\s+/).includes(cloudScope) ||
        !data.refresh_token
      )
        throw new ProviderError("googleScopeRequired");
      const jwksResponse = await this.options.request(
        "https://www.googleapis.com/oauth2/v3/certs",
        { redirect: "error", signal },
      );
      if (!jwksResponse.ok) {
        await jwksResponse.body?.cancel();
        throw new ProviderError("authorizationFailed");
      }
      const { payload } = await jwtVerify(
        data.id_token,
        createLocalJWKSet((await boundedJSON(jwksResponse)) as JSONWebKeySet),
        {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: clientId,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat"],
          currentDate: new Date(this.now()),
          clockTolerance: 5,
        },
      );
      if (
        payload.nonce !== nonce ||
        !payload.sub ||
        (payload.azp !== undefined && payload.azp !== clientId) ||
        (Array.isArray(payload.aud) &&
          payload.aud.length > 1 &&
          payload.azp !== clientId)
      )
        throw new ProviderError("authorizationFailed");
      if (previous && previous.subject !== payload.sub)
        throw new ProviderError("oauthAccountMismatch");
      signal.throwIfAborted();
      this.stop(id);
      this.options.write(id, {
        clientId,
        clientSecret: secret,
        subject: payload.sub,
        email:
          typeof payload.email === "string" ? payload.email.slice(0, 320) : "",
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: this.now() + data.expires_in * 1000,
      });
      return this.status(id);
    } catch (e) {
      if (signal.aborted)
        throw new ProviderError(
          signal.reason === "timeout" ? "authExpired" : "oauthCancelled",
        );
      throw e instanceof ProviderError
        ? e
        : new ProviderError("authorizationFailed");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      server.close();
      server.closeAllConnections();
      this.pending.delete(id);
      this.authorizations.delete(id);
    }
  }
  private async access(id: string, force = false): Promise<string> {
    const record = this.options.read(id);
    if (!record?.refreshToken) throw new ProviderError("accountSignInRequired");
    if (!force && record.expiresAt > this.now() + 60000)
      return record.accessToken;
    const existing = this.refreshing.get(id);
    if (existing) return existing;
    const session = this.session(id);
    const promise = (async () => {
      const signal = AbortSignal.any([
        session.signal,
        AbortSignal.timeout(30000),
      ]);
      try {
        const next = await this.exchange(
          {
            client_id: record.clientId,
            ...(record.clientSecret
              ? { client_secret: record.clientSecret }
              : {}),
            refresh_token: record.refreshToken,
            grant_type: "refresh_token",
          },
          signal,
        );
        if (next.scope && !next.scope.split(/\s+/).includes(cloudScope))
          throw new ProviderError("accountSignInRequired");
        signal.throwIfAborted();
        this.options.write(id, {
          ...record,
          accessToken: next.access_token,
          refreshToken: next.refresh_token || record.refreshToken,
          expiresAt: this.now() + next.expires_in * 1000,
        });
        return next.access_token;
      } catch (e) {
        if (
          !session.signal.aborted &&
          e instanceof ProviderError &&
          e.code === "accountSignInRequired"
        )
          this.options.write(id, undefined);
        throw e instanceof ProviderError
          ? e
          : new ProviderError("accountUnavailable");
      }
    })();
    this.refreshing.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.refreshing.get(id) === promise) this.refreshing.delete(id);
    }
  }
  request(source: SourceConfig): typeof fetch {
    return (async (input, init = {}) => {
      const url = new URL(String(input));
      const modelAPI =
        url.origin === "https://generativelanguage.googleapis.com" &&
        /^\/v1beta\/models(?:\/[\w.-]+:generateContent)?$/.test(url.pathname);
      const projectAPI =
        url.origin === "https://cloudresourcemanager.googleapis.com" &&
        url.pathname === "/v1/projects";
      if (
        (!modelAPI && !projectAPI) ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.has("key")
      )
        throw new ProviderError("invalidInput");
      if (modelAPI && !source.project)
        throw new ProviderError("googleProjectRequired");
      const record = this.options.read(source.id);
      if (!record || record.clientId !== source.oauthClientId)
        throw new ProviderError("accountSignInRequired");
      const signal = AbortSignal.any([
        this.session(source.id).signal,
        ...(init.signal ? [init.signal] : []),
      ]);
      let access = await this.access(source.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const headers = new Headers(init.headers);
        headers.delete("x-goog-api-key");
        headers.set("Authorization", `Bearer ${access}`);
        if (modelAPI) headers.set("x-goog-user-project", source.project);
        const response = await this.options.request(url, {
          ...init,
          headers,
          signal,
          redirect: "error",
        });
        signal.throwIfAborted();
        if (response.status === 401 && !attempt) {
          await response.body?.cancel();
          const latest = this.options.read(source.id)?.accessToken;
          access =
            latest && latest !== access
              ? latest
              : await this.access(source.id, true);
          continue;
        }
        if (!response.ok) {
          const body = await boundedJSON(response).catch(() => ({}));
          signal.throwIfAborted();
          if (
            response.status === 401 &&
            this.options.read(source.id)?.accessToken === access
          ) {
            this.options.write(source.id, undefined);
            this.stop(source.id);
          }
          const reasons = (body?.error?.details || []).map(
            (d: { reason?: string }) => d.reason,
          );
          throw new ProviderError(
            response.status === 401
              ? "accountSignInRequired"
              : reasons.includes("SERVICE_DISABLED")
                ? "googleAPIDisabled"
                : reasons.some((r: string) =>
                      /BILLING|CONSUMER_INVALID/.test(r),
                    )
                  ? "googleBillingRequired"
                  : response.status === 403
                    ? "googleProjectDenied"
                    : response.status === 429
                      ? "sourceRateLimited"
                      : "accountUnavailable",
          );
        }
        return response;
      }
      throw new ProviderError("accountSignInRequired");
    }) as typeof fetch;
  }
  async projects(source: SourceConfig) {
    const result: { id: string; name: string }[] = [],
      seen = new Set<string>();
    let pageToken = "";
    for (let page = 0; page < 50; page++) {
      const url = new URL(
        "https://cloudresourcemanager.googleapis.com/v1/projects",
      );
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const data = z
        .object({
          projects: z
            .array(
              z.object({
                projectId: z.string().max(200),
                name: z.string().max(300).optional(),
                lifecycleState: z.string().optional(),
              }),
            )
            .optional(),
          nextPageToken: z.string().optional(),
        })
        .parse(
          await boundedJSON(
            await this.request(source)(url, {
              signal: AbortSignal.timeout(30000),
            }),
          ),
        );
      for (const p of data.projects || [])
        if (p.lifecycleState === "ACTIVE")
          result.push({
            id: p.projectId,
            name: p.name ? `${p.name} · ${p.projectId}` : p.projectId,
          });
      pageToken = data.nextPageToken || "";
      if (!pageToken) return result;
      if (seen.has(pageToken)) break;
      seen.add(pageToken);
    }
    throw new ProviderError("googleProjectsFailed");
  }
  recordSearch(id: string, search: OAuthAccount["search"]) {
    const record = this.options.read(id);
    if (!record) throw new ProviderError("accountSignInRequired");
    this.options.write(id, { ...record, search });
  }
  async signOut(id: string): Promise<boolean> {
    this.cancel(id);
    this.stop(id);
    const record = this.options.read(id);
    this.options.write(id, undefined);
    if (!record?.refreshToken) return true;
    try {
      const response = await this.options.request(
        "https://oauth2.googleapis.com/revoke",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: record.refreshToken }).toString(),
        },
      );
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }
}
