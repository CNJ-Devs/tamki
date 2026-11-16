import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { ProviderError } from "./provider";
import { boundedJSON, openAIError } from "./openai-stream";
import type { OAuthAccount } from "../shared/settings";
import type { AuthorizationState } from "../shared/authorization";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const tokenString = z
  .string()
  .min(1)
  .max(32768)
  .refine((v) => !/[\r\n\0]/.test(v));
const tokensSchema = z.object({
  access_token: tokenString,
  refresh_token: tokenString.optional(),
  id_token: tokenString.optional(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().positive().max(86400),
  scope: z.string().max(4096).optional(),
});
export interface OAuthRegistration {
  clientId: string;
  subject?: string;
  email: string;
}
export interface OAuthRecord extends OAuthRegistration {
  subject: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  scopes: string[];
  search?: OAuthAccount["search"];
}
export interface OAuthStorage {
  host(): string | undefined;
  setHost(value: string): void;
  read(id: string): OAuthRecord | undefined;
  write(id: string, record: OAuthRecord | undefined): void;
  registration(id: string): OAuthRegistration | undefined;
  register(id: string, registration: OAuthRegistration): void;
  key?(id: string): string;
}
interface Options {
  storage: OAuthStorage;
  request: typeof fetch;
  openBrowser(url: string): Promise<void>;
  callbackText: { success: string; failed: string };
  now?: () => number;
  loginTimeoutMs?: number;
}

/** Tokens stay in main; only the current public authorization URL may reach trusted UI. */
export class OpenAIOAuth {
  private pending = new Map<string, AbortController>();
  private authorizations = new Map<string, AuthorizationState>();
  private sessions = new Map<string, AbortController>();
  private refreshing = new Map<string, Promise<string>>();
  private documents?: Promise<{
    jwks_uri: string;
    revocation_endpoint: string;
  }>;
  private now: () => number;
  constructor(private options: Options) {
    this.now = options.now || Date.now;
  }
  private key(id: string) {
    return this.options.storage.key?.(id) || id;
  }
  busy(id: string) {
    return [...this.pending.keys()].some(
      (other) => this.key(other) === this.key(id),
    );
  }

  private async discovery() {
    if (!this.documents)
      this.documents = (async () => {
        const response = await this.options.request(
          `${issuer}/.well-known/openid-configuration`,
          {
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderError("oauthUnavailable");
        }
        const data = z
          .object({
            issuer: z.literal(issuer),
            jwks_uri: z.string().url(),
            revocation_endpoint: z.string().url(),
          })
          .parse(await boundedJSON(response));
        for (const value of [data.jwks_uri, data.revocation_endpoint]) {
          const url = new URL(value);
          if (
            url.origin !== issuer ||
            url.username ||
            url.password ||
            url.hash ||
            url.search
          )
            throw new ProviderError("authorizationFailed");
        }
        return data;
      })().catch((e) => {
        this.documents = undefined;
        throw e;
      });
    return this.documents;
  }

  private async identity(
    token: string,
    clientId: string,
    signal: AbortSignal,
    nonce?: string,
  ) {
    const { jwks_uri } = await this.discovery();
    const response = await this.options.request(jwks_uri, {
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError("oauthUnavailable");
    }
    const jwks = (await boundedJSON(response)) as JSONWebKeySet;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
      currentDate: new Date(this.now()),
      clockTolerance: 5,
    });
    if (
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId) ||
      (payload.azp !== undefined && payload.azp !== clientId)
    )
      throw new ProviderError("authorizationFailed");
    return {
      subject: payload.sub,
      email:
        typeof payload.email === "string" ? payload.email.slice(0, 320) : "",
    };
  }

  private async token(form: Record<string, string>, signal: AbortSignal) {
    const response = await this.options.request(
      `${issuer}/api/accounts/oauth/token`,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ ...form, resource }).toString(),
      },
    );
    const data = await boundedJSON(response);
    if (!response.ok) {
      const code =
        typeof data?.error === "string" ? data.error : data?.error?.code;
      if (
        [
          "invalid_grant",
          "invalid_refresh_token",
          "token_expired",
          "refresh_token_expired",
          "refresh_token_invalidated",
          "refresh_token_reused",
        ].includes(code)
      )
        throw new ProviderError("oauthSignInRequired");
      if (code === "invalid_client")
        throw new ProviderError("oauthClientInvalid");
      throw openAIError(data, response.status);
    }
    return tokensSchema.parse(data);
  }

  status(id: string): OAuthAccount {
    const record = this.options.storage.read(id);
    return {
      email: record?.email || "",
      status: !record?.accessToken
        ? "signedOut"
        : !record.scopes.includes("chatgpt.tokens.use.direct")
          ? "planRequired"
          : "connected",
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
    id = this.key(id);
    let controller = this.sessions.get(id);
    if (!controller) {
      controller = new AbortController();
      this.sessions.set(id, controller);
    }
    return controller;
  }
  private stop(id: string) {
    id = this.key(id);
    this.sessions.get(id)?.abort();
    this.sessions.delete(id);
    this.refreshing.delete(id);
  }
  close() {
    for (const controller of this.pending.values()) controller.abort();
    for (const controller of this.sessions.values()) controller.abort();
    this.sessions.clear();
    this.authorizations.clear();
  }

  async signIn(id: string): Promise<OAuthAccount> {
    if (this.busy(id) || this.pending.size >= 4)
      throw new ProviderError("oauthBusy");
    const previous = this.options.storage.registration(id);
    const previousSession = this.options.storage.read(id);
    let host = this.options.storage.host();
    if (!host) {
      host = `urn:uuid:${randomUUID()}`;
      this.options.storage.setHost(host);
    }
    const controller = new AbortController();
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
    const signal = controller.signal;
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    let redirectURI = "",
      accepted = false;
    let resolveCallback!: (value: { code: string; clientId: string }) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<{ code: string; clientId: string }>(
      (resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      },
    );
    // A denied callback can arrive while openBrowser is still resolving.
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
        !redirectURI ||
        req.method !== "GET" ||
        req.headers.host !== new URL(redirectURI).host ||
        (req.url?.length || 0) > 12000
      )
        return fail();
      const url = new URL(req.url || "/", redirectURI);
      if (
        url.origin !== new URL(redirectURI).origin ||
        url.pathname !== "/auth/callback" ||
        accepted ||
        signal.aborted
      )
        return fail();
      for (const name of ["state", "code", "client_id", "error"])
        if (url.searchParams.getAll(name).length > 1) return fail();
      if (url.searchParams.get("state") !== state) return fail();
      accepted = true;
      authorization.status = "finishing";
      delete authorization.url;
      const error = url.searchParams.get("error");
      const clientId = url.searchParams.get("client_id") || previous?.clientId;
      const code = url.searchParams.get("code");
      if (
        error ||
        !code ||
        code.length > 8192 ||
        !clientId ||
        clientId === "dynamic_agent_client" ||
        !/^[\w-]{1,256}$/.test(clientId) ||
        (previous && clientId !== previous.clientId)
      ) {
        fail();
        rejectCallback(
          new ProviderError(
            error === "access_denied" ? "oauthDeclined" : "authorizationFailed",
          ),
        );
        return;
      }
      // Registration succeeds before code exchange. Persist the issued ID now,
      // even if exchange, identity validation, cancellation or a restart follows.
      // An unverified registration never grants access to a session.
      try {
        this.options.storage.register(id, previous || { clientId, email: "" });
      } catch {
        fail();
        rejectCallback(new ProviderError("authorizationFailed"));
        return;
      }
      res.end(this.options.callbackText.success);
      resolveCallback({ code, clientId });
    });
    const abort = () =>
      rejectCallback(
        new ProviderError(
          signal.reason === "timeout" ? "authExpired" : "oauthCancelled",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      signal.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === "string")
        throw new ProviderError("authorizationFailed");
      redirectURI = `http://127.0.0.1:${address.port}/auth/callback`;
      const params = new URLSearchParams({
        client_id: previous?.clientId || "dynamic_agent_client",
        ext_agent_host_id: host,
        response_type: "code",
        redirect_uri: redirectURI,
        scope: scopes,
        resource,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      });
      if (!previous) params.set("agent_name_hint", "Tamki");
      // The reusable browser link must not contain a stored identity token.
      if (previous?.email) params.set("login_hint", previous.email);
      if (
        previousSession?.accessToken &&
        !previousSession.scopes.includes("chatgpt.tokens.use.direct")
      )
        params.set("prompt", "consent");
      authorization.url = `${issuer}/api/accounts/authorize?${params}`;
      authorization.status = "waiting";
      // Creating a session never opens a browser; opening is an explicit UI action.
      const result = await callback;
      const tokens = await this.token(
        {
          grant_type: "authorization_code",
          client_id: result.clientId,
          code: result.code,
          code_verifier: verifier,
          redirect_uri: redirectURI,
        },
        signal,
      );
      if (!tokens.id_token || !tokens.scope)
        throw new ProviderError("authorizationFailed");
      const identity = await this.identity(
        tokens.id_token,
        result.clientId,
        signal,
        nonce,
      );
      if (previous?.subject && identity.subject !== previous.subject)
        throw new ProviderError("oauthAccountMismatch");
      const granted = tokens.scope.split(/\s+/);
      if (granted.includes("offline_access") && !tokens.refresh_token)
        throw new ProviderError("authorizationFailed");
      signal.throwIfAborted();
      this.stop(id);
      this.options.storage.register(id, {
        ...identity,
        clientId: result.clientId,
      });
      this.options.storage.write(id, {
        ...identity,
        clientId: result.clientId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: this.now() + tokens.expires_in * 1000,
        scopes: granted,
      });
      return this.status(id);
    } catch (error) {
      if (signal.aborted)
        throw new ProviderError(
          signal.reason === "timeout" ? "authExpired" : "oauthCancelled",
        );
      throw error instanceof ProviderError
        ? error
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
    // Resolve the account once. Removing a connection while refresh is in flight
    // must still commit the rotated credentials for the remaining connections.
    id = this.key(id);
    const record = this.options.storage.read(id);
    if (!record?.accessToken) throw new ProviderError("oauthSignInRequired");
    if (!record.scopes.includes("chatgpt.tokens.use.direct"))
      throw new ProviderError("oauthPlanRequired");
    if (!force && record.expiresAt > this.now() + 60000)
      return record.accessToken;
    const key = this.key(id);
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const controller = this.session(id);
    const promise = (async () => {
      try {
        if (!record.refreshToken)
          throw new ProviderError("oauthSignInRequired");
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30000),
        ]);
        const tokens = await this.token(
          {
            grant_type: "refresh_token",
            client_id: record.clientId,
            refresh_token: record.refreshToken,
          },
          signal,
        );
        if (!tokens.refresh_token)
          throw new ProviderError("authorizationFailed");
        if (tokens.id_token) {
          const identity = await this.identity(
            tokens.id_token,
            record.clientId,
            signal,
          );
          if (identity.subject !== record.subject)
            throw new ProviderError("oauthAccountMismatch");
        }
        signal.throwIfAborted();
        const next: OAuthRecord = {
          ...record,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token || record.idToken,
          expiresAt: this.now() + tokens.expires_in * 1000,
          scopes: tokens.scope?.split(/\s+/) || record.scopes,
        };
        this.options.storage.write(id, next);
        if (!next.scopes.includes("chatgpt.tokens.use.direct"))
          throw new ProviderError("oauthPlanRequired");
        return tokens.access_token;
      } catch (error) {
        if (
          !controller.signal.aborted &&
          error instanceof ProviderError &&
          error.code === "oauthSignInRequired"
        )
          this.options.storage.write(id, {
            clientId: record.clientId,
            subject: record.subject,
            email: record.email,
            scopes: [],
            expiresAt: 0,
          });
        throw error instanceof ProviderError
          ? error
          : new ProviderError("oauthUnavailable");
      }
    })();
    this.refreshing.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.refreshing.get(key) === promise) this.refreshing.delete(key);
    }
  }

  request(id: string): typeof fetch {
    return (async (input, init = {}) => {
      const accountId = this.key(id);
      const url = new URL(String(input));
      if (
        url.origin !== "https://api.openai.com" ||
        !["/v1/models", "/v1/responses"].includes(url.pathname) ||
        url.username ||
        url.password
      )
        throw new ProviderError("invalidInput");
      const controller = this.session(accountId);
      const signal = AbortSignal.any([
        controller.signal,
        ...(init.signal ? [init.signal] : []),
      ]);
      let access = await this.access(accountId);
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${access}`);
        const response = await this.options.request(input, {
          ...init,
          headers,
          signal,
          redirect: "error",
        });
        if (response.status !== 401 || attempt) return response;
        await response.body?.cancel();
        // Another request may already have rotated the rejected access token.
        const latest = this.options.storage.read(accountId)?.accessToken;
        access =
          latest && latest !== access
            ? latest
            : await this.access(accountId, true);
      }
      throw new ProviderError("oauthSignInRequired");
    }) as typeof fetch;
  }

  recordSearch(id: string, search: OAuthAccount["search"]) {
    const record = this.options.storage.read(id);
    if (!record?.accessToken) throw new ProviderError("oauthSignInRequired");
    this.options.storage.write(id, { ...record, search });
  }
  async signOut(id: string): Promise<boolean> {
    for (const other of this.pending.keys())
      if (this.key(other) === this.key(id)) this.cancel(other);
    this.stop(id);
    const record = this.options.storage.read(id);
    // Clear locally before network work so pending requests cannot resurrect tokens.
    this.options.storage.write(
      id,
      record
        ? {
            clientId: record.clientId,
            subject: record.subject,
            email: record.email,
            scopes: [],
            expiresAt: 0,
          }
        : undefined,
    );
    if (!record?.refreshToken) return true;
    try {
      const { revocation_endpoint } = await this.discovery();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await this.options.request(revocation_endpoint, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: record.refreshToken,
              token_type_hint: "refresh_token",
              client_id: record.clientId,
            }).toString(),
          });
          await response.body?.cancel();
          if (response.status === 200) return true;
          if (response.status < 500) return false;
        } catch {
          /* Retry a transient network failure once. */
        }
        if (!attempt) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch {
      /* Local sign-out still succeeds; UI reports unconfirmed revocation. */
    }
    return false;
  }
}
