import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  GoogleOAuth,
  type GoogleRecord,
} from "../../src/providers/google-oauth";
import { newSource } from "../../src/shared/settings";
const keys = generateKeyPair("RS256");
export async function googleHarness() {
  const { privateKey, publicKey } = await keys;
  const records = new Map<string, GoogleRecord>();
  const source = {
    ...newSource("gemini-oauth"),
    oauthClientId: "fixture.apps.googleusercontent.com",
    project: "fixture-project",
    model: "fixture",
  };
  const h = {
    now: Date.now(),
    auth: new URL("https://example.test"),
    invalid: "",
    refreshCalls: 0,
    apiCalls: 0,
    browserCalls: 0,
    refreshError: "",
    refreshWait: false,
    apiStatus: 200,
    reason: "",
    revoke: true,
    search: true,
  };
  const request = (async (url, init = {}) => {
    assert.equal(init.redirect, "error");
    const u = new URL(String(url));
    if (u.pathname === "/token") {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("client_id"), source.oauthClientId);
      assert.equal(form.get("client_secret"), "fixture-secret");
      const refresh = form.get("grant_type") === "refresh_token";
      if (refresh) {
        h.refreshCalls++;
        if (h.refreshWait) await new Promise((r) => setTimeout(r, 40));
        if (h.refreshError)
          return Response.json({ error: h.refreshError }, { status: 400 });
      } else {
        assert.equal(
          form.get("redirect_uri"),
          h.auth.searchParams.get("redirect_uri"),
        );
        assert.equal(
          createHash("sha256")
            .update(form.get("code_verifier")!)
            .digest("base64url"),
          h.auth.searchParams.get("code_challenge"),
        );
      }
      return Response.json({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: refresh ? "refreshed" : "access",
        ...(!refresh
          ? {
              refresh_token: "refresh",
              id_token: await new SignJWT({
                nonce:
                  h.invalid === "nonce"
                    ? "wrong"
                    : h.auth.searchParams.get("nonce"),
                email: "fixture@example.test",
              })
                .setProtectedHeader({ alg: "RS256", kid: "test" })
                .setIssuer("https://accounts.google.com")
                .setAudience(
                  h.invalid === "audience"
                    ? "wrong-client"
                    : source.oauthClientId,
                )
                .setSubject("user")
                .setIssuedAt(Math.floor(h.now / 1000))
                .setExpirationTime(Math.floor(h.now / 1000) + 3600)
                .sign(privateKey),
            }
          : {}),
        scope:
          h.invalid === "scope"
            ? "openid email"
            : "openid email https://www.googleapis.com/auth/cloud-platform",
      });
    }
    if (u.pathname === "/oauth2/v3/certs")
      return Response.json({
        keys: [
          {
            ...(await exportJWK(publicKey)),
            kid: "test",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    if (u.pathname === "/revoke") {
      assert.equal(
        new URLSearchParams(String(init.body)).get("token"),
        "refresh",
      );
      return new Response("", { status: h.revoke ? 200 : 503 });
    }
    h.apiCalls++;
    const headers = new Headers(init.headers);
    assert.match(headers.get("Authorization")!, /^Bearer (access|refreshed)$/);
    assert.equal(headers.has("x-goog-api-key"), false);
    if (u.hostname === "cloudresourcemanager.googleapis.com") {
      assert.equal(headers.has("x-goog-user-project"), false);
      return Response.json({
        projects: [
          {
            projectId: "fixture-project",
            name: "Test",
            lifecycleState: "ACTIVE",
          },
        ],
      });
    }
    assert.equal(headers.get("x-goog-user-project"), source.project);
    if (h.apiStatus !== 200)
      return Response.json(
        {
          error: {
            message: "private account detail",
            details: [{ reason: h.reason }],
          },
        },
        { status: h.apiStatus },
      );
    if (u.pathname.endsWith(":generateContent")) {
      const body = JSON.parse(String(init.body));
      assert(body.tools.some((t: any) => t.google_search));
      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    work: null,
                    files: [
                      {
                        id: "stable",
                        number: "1",
                        title: "Title",
                        description: null,
                      },
                    ],
                  }),
                },
              ],
            },
            ...(h.search
              ? {
                  groundingMetadata: {
                    webSearchQueries: ["fixture"],
                    groundingChunks: [
                      {
                        web: {
                          uri: "https://example.test/title",
                          title: "Title",
                        },
                      },
                    ],
                  },
                }
              : {}),
          },
        ],
      });
    }
    return Response.json({
      models: [
        {
          name: "models/fixture",
          displayName: "Fixture",
          supportedGenerationMethods: ["generateContent"],
          outputTokenLimit: 65536,
        },
      ],
    });
  }) as typeof fetch;
  let callback: (url: URL) => Promise<void> = async (url) => {
    const target = new URL(url.searchParams.get("redirect_uri")!);
    const wrong = new URL(target);
    wrong.searchParams.set("state", "wrong");
    wrong.searchParams.set("code", "bad");
    assert.equal((await fetch(wrong)).status, 400);
    target.searchParams.set("state", url.searchParams.get("state")!);
    target.searchParams.set("code", "code");
    assert.equal((await fetch(target)).status, 200);
  };
  const options = {
    request,
    now: () => h.now,
    openBrowser: async (url: string) => {
      h.browserCalls++;
      h.auth = new URL(url);
      await callback(h.auth);
    },
    read: (id: string) => records.get(id),
    write: (id: string, record: GoogleRecord | undefined) => {
      if (record) records.set(id, record);
      else records.delete(id);
    },
    callbackText: { success: "ok", failed: "failed" },
    loginTimeoutMs: 1000,
  };
  const oauth = new GoogleOAuth(options);
  return {
    h,
    source,
    oauth,
    records,
    options,
    callback: (fn: typeof callback) => {
      callback = fn;
    },
  };
}
