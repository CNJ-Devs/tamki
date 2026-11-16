import test from "node:test";
import { authorize, waitForAuthorization } from "./fixtures/authorization";
import assert from "node:assert/strict";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  OpenAIOAuth,
  type OAuthRecord,
  type OAuthRegistration,
} from "../src/providers/openai-oauth";
import { openAIStream } from "../src/providers/openai-stream";
import { discoverModels } from "../src/providers/models";
import { aiRecognition } from "../src/providers/ai-recognition";
import {
  newSource,
  sourceSchema,
  sourceConfig,
  searchSettingsKey,
} from "../src/shared/settings";
import { SettingsService } from "../src/library/settings";
import { recognitionSourceConfig } from "../src/shared/recognition-source";
import { LibraryStore } from "../src/library/store";
import { encryptedStorage } from "./fixtures/secure-storage";
import type { OpenAIProfiles } from "../src/shared/openai-profiles";
import {
  connectionConfig,
  newAIConnection,
} from "../src/shared/ai-connections";

const keys = generateKeyPair("RS256");
const granted =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
async function harness(loginTimeoutMs = 3000) {
  const { privateKey, publicKey } = await keys;
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  const records = new Map<string, OAuthRecord>();
  const registrations = new Map<string, OAuthRegistration>();
  let host: string | undefined;
  const h = {
    now: Date.now(),
    auth: new URL("https://example.test"),
    codeCalls: 0,
    browserCalls: 0,
    refreshCalls: 0,
    apiCalls: 0,
    revokeCalls: 0,
    scopes: granted,
    subject: "fixture-user",
    clientId: "oaiapp_fixture",
    invalid: "",
    tokenFailure: "",
    pendingToken: false,
    pendingRefresh: false,
    callback: async (url: URL) => {
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("client_id", h.clientId);
      assert.equal((await fetch(redirect)).status, 200);
    },
    api: async (_init: RequestInit) =>
      Response.json({
        models: [
          { slug: "second", display_name: "Z model", visibility: "list" },
          { slug: "hidden", display_name: "Hidden", visibility: "hide" },
          { slug: "first", display_name: "A model", visibility: "list" },
        ],
      }),
  };
  const request = (async (input, init = {}) => {
    const url = String(input);
    assert.equal(init.redirect, "error");
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer: "https://auth.openai.com",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        revocation_endpoint:
          "https://auth.openai.com/api/accounts/oauth/revoke",
      });
    if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("resource"), "https://api.openai.com/v1");
      assert.equal(form.get("client_id"), h.clientId);
      assert.equal(form.has("client_secret"), false);
      if (form.get("grant_type") === "refresh_token") {
        h.refreshCalls++;
        assert.equal(form.has("scope"), false);
        if (h.pendingRefresh)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 25);
            init.signal!.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
      } else {
        h.codeCalls++;
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
        if (h.pendingToken)
          await new Promise((_, reject) =>
            init.signal!.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          );
      }
      if (h.tokenFailure === "network")
        throw new Error("fixture network failure");
      if (h.tokenFailure)
        return Response.json({ error: h.tokenFailure }, { status: 400 });
      const time = Math.floor(h.now / 1000);
      const token = await new SignJWT({
        email: "user@example.test",
        nonce:
          h.invalid === "nonce" ? "wrong" : h.auth.searchParams.get("nonce"),
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setSubject(h.subject)
        .setIssuer(
          h.invalid === "issuer"
            ? "https://evil.example"
            : "https://auth.openai.com",
        )
        .setAudience(h.invalid === "audience" ? "other-client" : h.clientId)
        .setIssuedAt(time)
        .setExpirationTime(h.invalid === "expired" ? time - 60 : time + 3600)
        .sign(privateKey);
      return Response.json({
        access_token: `access-${h.refreshCalls}`,
        refresh_token: `refresh-${h.refreshCalls}`,
        id_token:
          h.invalid === "signature"
            ? token.slice(0, -20) + "a".repeat(20)
            : token,
        token_type: "Bearer",
        expires_in: 3600,
        scope: h.scopes,
      });
    }
    if (url.endsWith("/oauth/revoke")) {
      h.revokeCalls++;
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("token_type_hint"), "refresh_token");
      assert.equal(form.get("client_id"), h.clientId);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith("https://api.openai.com/v1/")) {
      h.apiCalls++;
      assert.match(
        new Headers(init.headers).get("Authorization")!,
        /^Bearer access-/,
      );
      return h.api(init);
    }
    throw new Error("Unexpected fixture URL");
  }) as typeof fetch;
  const openBrowser = async (value: string) => {
    h.browserCalls++;
    h.auth = new URL(value);
    await h.callback(h.auth);
  };
  const oauth = new OpenAIOAuth({
    storage: {
      host: () => host,
      setHost: (v) => {
        host = v;
      },
      registration: (id) => registrations.get(id),
      register: (id, value) => {
        registrations.set(id, value);
      },
      read: (id) => records.get(id),
      write: (id, value) => {
        if (value) records.set(id, value);
        else records.delete(id);
      },
    },
    request,
    now: () => h.now,
    loginTimeoutMs,
    callbackText: { success: "received", failed: "invalid" },
    openBrowser,
  });
  return {
    h,
    oauth,
    records,
    registrations,
    request,
    openBrowser,
    host: () => host,
  };
}

test("ChatGPT OAuth validates loopback state, PKCE, identity and persists one host per installation", async () => {
  const { h, oauth, records, host } = await harness();
  const callback = h.callback;
  h.callback = async (url) => {
    assert.equal(url.searchParams.get("agent_name_hint"), "Tamki");
    assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
    const wrong = new URL(url.searchParams.get("redirect_uri")!);
    wrong.searchParams.set("state", "wrong");
    assert.equal((await fetch(wrong)).status, 400);
    await callback(url);
  };
  try {
    assert.deepEqual(await authorize(oauth.signIn("source"), oauth, "source"), {
      email: "user@example.test",
      status: "connected",
      search: undefined,
    });
    assert.equal(h.codeCalls, 1);
    assert.equal(records.get("source")?.clientId, "oaiapp_fixture");
    assert(!JSON.stringify(oauth.status("source")).includes("access-"));
    const firstHost = host(),
      firstState = h.auth.searchParams.get("state");
    h.callback = async (url) => {
      assert.equal(url.searchParams.get("client_id"), "oaiapp_fixture");
      assert.equal(url.searchParams.has("agent_name_hint"), false);
      assert.equal(url.searchParams.has("id_token_hint"), false);
      assert.equal(url.searchParams.get("ext_agent_host_id"), firstHost);
      assert.notEqual(url.searchParams.get("state"), firstState);
      await callback(url);
    };
    await authorize(oauth.signIn("source"), oauth, "source");
    const redirect = h.auth.searchParams.get("redirect_uri")!;
    await assert.rejects(fetch(redirect)); // Listener is closed after authorization.
  } finally {
    oauth.close();
  }
});

test("OAuth rejects invalid ID tokens and account changes without replacing an existing session", async () => {
  for (const invalid of [
    "signature",
    "issuer",
    "audience",
    "nonce",
    "expired",
  ]) {
    const { h, oauth, records } = await harness();
    try {
      h.invalid = invalid;
      await assert.rejects(
        authorize(oauth.signIn("source"), oauth, "source"),
        /^Error: authorizationFailed$/,
      );
      assert.equal(records.size, 0);
    } finally {
      oauth.close();
    }
  }
  const { h, oauth, records } = await harness();
  try {
    await authorize(oauth.signIn("source"), oauth, "source");
    const original = records.get("source");
    h.subject = "different-user";
    await assert.rejects(
      authorize(oauth.signIn("source"), oauth, "source"),
      /oauthAccountMismatch/,
    );
    assert.deepEqual(records.get("source"), original);
  } finally {
    oauth.close();
  }
});

test("identity-only authorization cannot infer or search; consent can be requested again", async () => {
  const { h, oauth } = await harness();
  try {
    h.scopes = "openid profile email offline_access";
    assert.equal(
      (await authorize(oauth.signIn("source"), oauth, "source")).status,
      "planRequired",
    );
    await assert.rejects(
      oauth.request("source")("https://api.openai.com/v1/models"),
      /oauthPlanRequired/,
    );
    const callback = h.callback;
    h.callback = async (url) => {
      assert.equal(url.searchParams.get("prompt"), "consent");
      await callback(url);
    };
    h.scopes = granted;
    assert.equal(
      (await authorize(oauth.signIn("source"), oauth, "source")).status,
      "connected",
    );
  } finally {
    oauth.close();
  }
});

test("OAuth uses account-specific model ordering and never sends credentials to another endpoint", async () => {
  const { oauth } = await harness();
  try {
    await authorize(oauth.signIn("source"), oauth, "source");
    assert.deepEqual(
      await discoverModels(
        newSource("openai-oauth"),
        "managed",
        oauth.request("source"),
      ),
      [
        { id: "second", name: "Z model" },
        { id: "first", name: "A model" },
      ],
    );
    await assert.rejects(
      oauth.request("source")("https://other.example/v1/models"),
      /invalidInput/,
    );
    await assert.rejects(
      oauth.request("source")("https://api.openai.com/v1/files"),
      /invalidInput/,
    );
  } finally {
    oauth.close();
  }
});

test("refresh is serialized, rotating credentials are replaced together, network failures retain the session", async () => {
  const { h, oauth, records } = await harness();
  try {
    await authorize(oauth.signIn("source"), oauth, "source");
    h.now += 3600 * 1000;
    h.pendingRefresh = true;
    await Promise.all([
      oauth.request("source")("https://api.openai.com/v1/models"),
      oauth.request("source")("https://api.openai.com/v1/models"),
    ]);
    assert.equal(h.refreshCalls, 1);
    assert.equal(records.get("source")?.refreshToken, "refresh-1");
    h.now += 3600 * 1000;
    h.tokenFailure = "network";
    await assert.rejects(
      oauth.request("source")("https://api.openai.com/v1/models"),
      /oauthUnavailable/,
    );
    assert.equal(records.get("source")?.refreshToken, "refresh-1");
    h.tokenFailure = "invalid_grant";
    await assert.rejects(
      oauth.request("source")("https://api.openai.com/v1/models"),
      /oauthSignInRequired/,
    );
    assert.equal(records.get("source")?.refreshToken, undefined);
    assert.equal(records.get("source")?.clientId, "oaiapp_fixture");
  } finally {
    oauth.close();
  }
});

test("401 renews once; sign-out revokes and preserves registration without tokens", async () => {
  const { h, oauth, records } = await harness();
  try {
    await authorize(oauth.signIn("source"), oauth, "source");
    h.api = async () =>
      h.apiCalls === 1
        ? new Response(null, { status: 401 })
        : Response.json({ ok: true });
    assert(
      (await oauth.request("source")("https://api.openai.com/v1/models")).ok,
    );
    assert.equal(h.refreshCalls, 1);
    assert(await oauth.signOut("source"));
    assert.equal(h.revokeCalls, 1);
    assert.equal(oauth.status("source").status, "signedOut");
    assert.equal(records.get("source")?.clientId, "oaiapp_fixture");
    assert(!JSON.stringify(records.get("source")).includes("Token"));
    await assert.rejects(
      oauth.request("source")("https://api.openai.com/v1/models"),
      /oauthSignInRequired/,
    );
  } finally {
    oauth.close();
  }
});

test("cancel closes the listener and a late token exchange cannot resurrect a discarded source", async () => {
  const { h, oauth, records } = await harness();
  try {
    h.pendingToken = true;
    const signIn = authorize(oauth.signIn("source"), oauth, "source");
    const rejected = assert.rejects(signIn, /oauthCancelled/);
    while (!h.codeCalls) await new Promise((r) => setTimeout(r, 5));
    await oauth.signOut("source");
    await rejected;
    assert.equal(records.size, 0);
    await assert.rejects(fetch(h.auth.searchParams.get("redirect_uri")!));
  } finally {
    oauth.close();
  }
});

test("sign-out during refresh cannot write a replacement token afterwards", async () => {
  const { h, oauth, records } = await harness();
  try {
    await authorize(oauth.signIn("source"), oauth, "source");
    h.now += 3600 * 1000;
    h.pendingRefresh = true;
    const request = oauth.request("source")("https://api.openai.com/v1/models");
    const rejected = assert.rejects(request);
    while (!h.refreshCalls) await new Promise((r) => setTimeout(r, 1));
    await oauth.signOut("source");
    await rejected;
    assert.equal(records.get("source")?.accessToken, undefined);
  } finally {
    oauth.close();
  }
});

function stream(events: unknown[], chunkSize = 7) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, (offset += chunkSize)));
        if (offset > bytes.length) offset = bytes.length;
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const completed = (output: unknown[]) => ({
  type: "response.completed",
  response: { status: "completed", output },
});
test("subscription streams require completed events and detect late failures, truncation and interrupted bodies", async () => {
  for (const [event, code] of [
    [
      {
        type: "response.failed",
        response: {
          error: {
            code: "subscription_sharing_usage_limit_exceeded",
            message: "private contents",
          },
        },
      },
      "oauthUsageLimit",
    ],
    [
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
      "recognitionTruncated",
    ],
    [
      { type: "error", code: "subscription_sharing_unsupported_capability" },
      "oauthCapabilityUnsupported",
    ],
    [{ type: "response.output_text.done" }, "oauthStreamInterrupted"],
  ] as const) {
    await assert.rejects(
      openAIStream({}, new AbortController().signal, (async () =>
        stream([
          { type: "response.output_text.delta", delta: "片库" },
          event,
        ])) as typeof fetch),
      new RegExp(`^Error: ${code}$`),
    );
  }
  assert.deepEqual(
    await openAIStream({}, new AbortController().signal, (async () =>
      stream([
        completed([
          { type: "message", content: [{ type: "output_text", text: "测试" }] },
        ]),
      ])) as typeof fetch),
    {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "测试" }] },
      ],
    },
  );
});

test("OAuth recognition omits unsupported fields, requires a real search and preserves stable file IDs", async () => {
  const source = { ...newSource("openai-oauth"), model: "fixture-model" };
  const input = {
    title: "Fixture",
    scope: "file" as const,
    files: [{ id: "stable", filename: "episode.mkv", duration: 120, order: 1 }],
  };
  let includeSearch = true;
  const request = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert(Array.isArray(body.input));
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.max_tool_calls, undefined);
    assert.equal(body.tool_choice.type, "web_search");
    return stream([
      completed([
        ...(includeSearch
          ? [
              {
                type: "web_search_call",
                status: "completed",
                action: { type: "search", query: "Fixture" },
              },
            ]
          : []),
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                work: null,
                files: [
                  {
                    id: "stable",
                    number: "1",
                    title: "First",
                    description: null,
                  },
                ],
              }),
            },
          ],
        },
      ]),
    ]);
  }) as typeof fetch;
  const result = await aiRecognition(
    source,
    "managed",
    "",
    input,
    "{{title}}",
    new AbortController().signal,
    request,
  );
  assert.equal(result.kind, "result");
  includeSearch = false;
  await assert.rejects(
    aiRecognition(
      source,
      "managed",
      "",
      input,
      "{{title}}",
      new AbortController().signal,
      request,
    ),
    /oauthSearchUnverified/,
  );
});

test("OAuth is a separate provider; account information stays outside editable source config", () => {
  const source = newSource("openai-oauth");
  assert(sourceSchema.safeParse(source).success);
  for (const patch of [
    { endpoint: "https://other.example/v1" },
    { auth: "none" },
    { searchMode: "external" },
    { project: "private-project" },
  ])
    assert(!sourceSchema.safeParse({ ...source, ...patch }).success);
  assert.deepEqual(
    sourceConfig({
      ...source,
      hasKey: false,
      hasSearchKey: false,
      models: [],
      account: { status: "connected", email: "user@example.test" },
    }),
    source,
  );
  assert.notEqual(
    searchSettingsKey(source),
    searchSettingsKey({ ...source, model: "other" }),
  );
});

test("settings integrate draft login, search, encrypted persistence, restart, sign-out and source removal", async () => {
  const fixture = await harness();
  const store = new LibraryStore(":memory:", "en");
  const key = randomBytes(32);
  const secureStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (value: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (value: Buffer) => {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        decipher.update(value.subarray(28)),
        decipher.final(),
      ]).toString();
    },
  };
  const deps = {
    request: fixture.request,
    openBrowser: fixture.openBrowser,
    secureStorage,
  };
  let settings = new SettingsService(store, deps);
  const source = newSource("openai-oauth");
  try {
    const login = (await authorize(
      settings.request("source-oauth-login", source),
      settings.oauth,
      source.id,
    )) as any;
    assert.equal(login.account.status, "connected");
    assert.equal(login.firstUse, true);
    assert.equal(store.config(`source:${source.id}:oauth`), undefined);
    assert.equal(settings.snapshot().recognition.sources.length, 0);
    const models = (await settings.request("source-models", {
      source,
    })) as any[];
    source.model = models[0].id;
    fixture.h.api = async () =>
      stream([
        completed([
          {
            type: "web_search_call",
            status: "completed",
            action: { type: "search" },
          },
        ]),
      ]);
    const tested = (await settings.request(
      "source-oauth-search",
      source,
    )) as any;
    assert.equal(tested.search.settingsKey, searchSettingsKey(source));
    await settings.request("save-source", { source });
    const profiles = (await settings.request("source-oauth-profiles", {
      source,
    })) as any;
    const encrypted = store.config(
      `openaiOAuthSession:${profiles.selectedId}`,
    )!;
    assert(!encrypted.includes("access-0"));
    assert(!Buffer.from(encrypted, "base64").includes(Buffer.from("access-0")));
    assert(!JSON.stringify(settings.snapshot()).includes("access-0"));
    await settings.request("source-oauth-discard", source.id);
    assert.equal(fixture.h.revokeCalls, 0); // Closing a saved source is not sign-out.
    settings.close();
    settings = new SettingsService(store, deps);
    assert.equal(
      settings.snapshot().recognition.sources[0].account?.status,
      "connected",
    );
    assert.equal(
      settings.snapshot().recognition.sources[0].account?.search?.model,
      source.model,
    );
    fixture.h.api = async () => stream([completed([])]);
    await assert.rejects(
      settings.request("source-oauth-search", source),
      /oauthSearchUnverified/,
    );
    assert.equal(
      settings.snapshot().recognition.sources[0].account?.search,
      undefined,
    );
    fixture.h.api = async () => {
      throw new TypeError("network failed");
    };
    await assert.rejects(
      settings.request("source-oauth-search", source),
      /oauthUnavailable/,
    );
    await settings.request("source-oauth-logout", source.id);
    assert.equal(
      settings.snapshot().recognition.sources[0].account?.status,
      "signedOut",
    );
    await assert.rejects(
      settings.request("save-source", { source }),
      /oauthSignInRequired/,
    );
    await settings.request("remove-source", source.id);
    assert.equal(settings.snapshot().recognition.sources.length, 0);
    assert.equal(settings.snapshot().aiConnections.length, 1);
    await settings.request("ai-connection-remove", source.id);
    assert(!store.config(`source:${source.id}:oauth`));
    // Cancel an unsaved source revokes its grant, without adding a settings row.
    const draft = newSource("openai-oauth");
    await authorize(
      settings.request("source-oauth-login", draft),
      settings.oauth,
      draft.id,
    );
    const before = fixture.h.revokeCalls;
    await settings.request("source-oauth-discard", draft.id);
    assert.equal(fixture.h.revokeCalls, before + 1);
    assert.equal(settings.snapshot().recognition.sources.length, 0);
    const connection = connectionConfig(newAIConnection("openai-oauth"));
    const apiCalls = fixture.h.apiCalls;
    await authorize(
      settings.request("ai-connection-login", { connection }),
      settings.oauth,
      connection.id,
    );
    await settings.request("ai-connection-save", { connection });
    assert.equal(fixture.h.apiCalls, apiCalls);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    assert.equal(settings.snapshot().recognition.sources.length, 0);
    await settings.request("ai-connection-discard", connection.id);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    await settings.request("ai-connection-remove", connection.id);
    assert.equal(settings.snapshot().aiConnections.length, 0);
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});

test("authorization links remain reusable until callback/cancel, contain no tokens and are renewed for a retry", async () => {
  const { h, oauth, records } = await harness();
  const callback = h.callback;
  h.callback = async () => {};
  try {
    const first = oauth.signIn("source");
    void first.catch(() => {});
    const state = await waitForAuthorization(oauth, "source");
    const url = new URL(state.url!);
    assert.equal(url.origin, "https://auth.openai.com");
    for (const name of [
      "access_token",
      "refresh_token",
      "id_token_hint",
      "code_verifier",
    ])
      assert.equal(url.searchParams.has(name), false);
    assert.equal(state.status, "waiting");
    assert.equal(h.browserCalls, 0);
    await oauth.openAuthorization("source", state.id);
    assert.equal(h.auth.href, state.url);
    assert.equal(oauth.authorization("source")?.id, state.id);
    oauth.cancel("source");
    await assert.rejects(first, /oauthCancelled/);
    assert.equal(oauth.authorization("source"), null);
    assert.equal(records.size, 0);
    await assert.rejects(
      oauth.openAuthorization("source", state.id),
      /authExpired/,
    );
    await assert.rejects(fetch(url.searchParams.get("redirect_uri")!));
    const second = oauth.signIn("source");
    void second.catch(() => {});
    const retry = await waitForAuthorization(oauth, "source");
    assert.notEqual(retry.id, state.id);
    assert.notEqual(retry.url, state.url);
    h.callback = callback;
    await oauth.openAuthorization("source", retry.id);
    assert.equal((await second).status, "connected");
    assert.equal(oauth.authorization("source"), null);
  } finally {
    oauth.close();
  }
});

test("browser launch failure preserves a usable link and a hung launcher cannot prevent expiry", async () => {
  const fixture = await harness();
  fixture.h.callback = async () => {
    throw new Error("Browser unavailable");
  };
  try {
    const login = fixture.oauth.signIn("source");
    void login.catch(() => {});
    const state = await waitForAuthorization(fixture.oauth, "source");
    assert.equal(fixture.h.browserCalls, 0);
    await assert.rejects(
      fixture.oauth.openAuthorization("source", state.id),
      /oauthBrowserOpenFailed/,
    );
    assert.equal(fixture.oauth.authorization("source")?.browserError, true);
    fixture.h.callback = async () => {};
    await fixture.oauth.openAuthorization("source", state.id);
    assert.equal(fixture.oauth.authorization("source")?.browserError, false);
    fixture.oauth.cancel("source");
    await assert.rejects(login, /oauthCancelled/);
  } finally {
    fixture.oauth.close();
  }
  const expired = await harness(80);
  expired.h.callback = async () => new Promise(() => {});
  try {
    const login = expired.oauth.signIn("source");
    void login.catch(() => {});
    const state = await waitForAuthorization(expired.oauth, "source");
    void expired.oauth.openAuthorization("source", state.id);
    await assert.rejects(login, /authExpired/);
    assert.equal(expired.oauth.authorization("source"), null);
    assert.equal(expired.records.size, 0);
  } finally {
    expired.oauth.close();
  }
});

test("authorization IPC copies/opens only the active session and stale cancellation cannot stop a newer attempt", async () => {
  const fixture = await harness(),
    store = new LibraryStore(":memory:", "en");
  fixture.h.callback = async () => {};
  const copied: string[] = [];
  const settings = new SettingsService(store, {
    request: fixture.request,
    openBrowser: fixture.openBrowser,
    secureStorage: encryptedStorage(),
    writeClipboard: (value) => copied.push(value),
  });
  const connection = connectionConfig(newAIConnection("openai-oauth"));
  try {
    const login = settings.request("ai-connection-login", { connection });
    void login.catch(() => {});
    const state = await waitForAuthorization(settings.oauth, connection.id);
    assert.deepEqual(
      await settings.request("source-authorization", connection.id),
      state,
    );
    const input = { sourceId: connection.id, authorizationId: state.id };
    await settings.request("source-authorization-copy", input);
    assert.deepEqual(copied, [state.url]);
    await settings.request("source-authorization-open", input);
    assert.equal(fixture.h.auth.href, state.url);
    await assert.rejects(
      settings.request("source-authorization-open", {
        ...input,
        url: "https://evil.test",
      }),
    );
    await settings.request("source-authorization-cancel", input);
    await assert.rejects(login, /oauthCancelled/);
    const next = settings.request("ai-connection-login", { connection });
    void next.catch(() => {});
    const fresh = await waitForAuthorization(settings.oauth, connection.id);
    await settings.request("source-authorization-cancel", input);
    assert.equal(settings.oauth.authorization(connection.id)?.id, fresh.id);
    await assert.rejects(
      settings.request("source-authorization-copy", input),
      /authExpired/,
    );
    await settings.request("source-authorization-cancel", {
      sourceId: connection.id,
      authorizationId: fresh.id,
    });
    await assert.rejects(next, /oauthCancelled/);
    assert.equal(settings.snapshot().aiConnections.length, 0);
    assert(!store.config(`source:${connection.id}:oauth`));
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});

for (const failure of [
  "invalid_grant",
  "network",
  "invalid_client",
  "identity",
  "cancel",
] as const) {
  test(`registration survives ${failure}, draft dismissal and restart without another registration`, async () => {
    const fixture = await harness();
    const store = new LibraryStore(":memory:", "en");
    const deps = {
      request: fixture.request,
      openBrowser: fixture.openBrowser,
      secureStorage: encryptedStorage(),
    };
    let settings = new SettingsService(store, deps);
    const connection = connectionConfig(newAIConnection("openai-oauth"));
    try {
      if (failure === "identity") fixture.h.invalid = "signature";
      else if (failure === "cancel") fixture.h.pendingToken = true;
      else fixture.h.tokenFailure = failure;
      const login = authorize(
        settings.request("ai-connection-login", { connection }),
        settings.oauth,
        connection.id,
      );
      const rejected = assert.rejects(login);
      if (failure === "cancel") {
        while (!fixture.h.codeCalls)
          await new Promise((resolve) => setTimeout(resolve, 2));
        await settings.request("ai-connection-discard", connection.id);
      }
      await rejected;
      const firstHost = store.config("openaiOAuthHost");
      const source = { ...newSource("openai-oauth"), ...connection };
      const profiles = (await settings.request("source-oauth-profiles", {
        source,
      })) as OpenAIProfiles;
      assert.equal(profiles.profiles.length, 1);
      assert.equal(profiles.profiles[0].verified, false);
      assert.equal(profiles.account.status, "signedOut");
      await assert.rejects(
        settings.oauth.request(connection.id)(
          "https://api.openai.com/v1/models",
        ),
        /oauthSignInRequired/,
      );
      assert(!store.config(`openaiOAuthSession:${profiles.selectedId}`));
      await settings.request("ai-connection-discard", connection.id);
      settings.close();
      settings = new SettingsService(store, deps);
      fixture.h.invalid = fixture.h.tokenFailure = "";
      fixture.h.pendingToken = false;
      const retry = connectionConfig(newAIConnection("openai-oauth"));
      const callback = fixture.h.callback;
      fixture.h.callback = async (url) => {
        assert.equal(url.searchParams.get("client_id"), "oaiapp_fixture");
        assert.equal(url.searchParams.has("agent_name_hint"), false);
        assert.equal(url.searchParams.get("ext_agent_host_id"), firstHost);
        await callback(url);
      };
      await authorize(
        settings.request("ai-connection-login", { connection: retry }),
        settings.oauth,
        retry.id,
      );
      await settings.request("ai-connection-save", { connection: retry });
      await settings.request("ai-connection-logout", retry.id);
      await authorize(
        settings.request("ai-connection-login", { connection: retry }),
        settings.oauth,
        retry.id,
      );
      const renewed = (await settings.request("source-oauth-profiles", {
        source: { ...source, ...retry },
      })) as OpenAIProfiles;
      assert.equal(renewed.profiles.length, 1);
      assert.equal(renewed.profiles[0].verified, true);
      assert.equal(renewed.selectedId, profiles.selectedId);
    } finally {
      settings.close();
      fixture.oauth.close();
      store.close();
    }
  });
}

test("saved connections share one rotating session; removal and re-addition retain the identity", async () => {
  const fixture = await harness();
  const store = new LibraryStore(":memory:", "en");
  const deps = {
    request: fixture.request,
    openBrowser: fixture.openBrowser,
    secureStorage: encryptedStorage(),
  };
  let settings = new SettingsService(store, deps);
  const first = connectionConfig(newAIConnection("openai-oauth"));
  const second = {
    ...connectionConfig(newAIConnection("openai-oauth")),
    name: "Second connection",
  };
  const source = (connection: typeof first) => ({
    ...newSource("openai-oauth"),
    ...connection,
  });
  try {
    await authorize(
      settings.request("ai-connection-login", { connection: first }),
      settings.oauth,
      first.id,
    );
    await settings.request("ai-connection-save", { connection: first });
    const original = (await settings.request("source-oauth-profiles", {
      source: source(first),
    })) as OpenAIProfiles;
    const shared = (await settings.request("source-oauth-profiles", {
      source: source(second),
    })) as OpenAIProfiles;
    assert.equal(shared.selectedId, original.selectedId);
    assert.equal(shared.account.status, "connected");
    await settings.request("ai-connection-save", { connection: second });
    const key = `openaiOAuthSession:${shared.selectedId}`;
    const record = JSON.parse(
      deps.secureStorage.decryptString(
        Buffer.from(store.config(key)!, "base64"),
      ),
    );
    record.expiresAt = 0;
    store.setConfig(
      key,
      deps.secureStorage
        .encryptString(JSON.stringify(record))
        .toString("base64"),
    );
    fixture.h.pendingRefresh = true;
    await Promise.all(
      [first, second].map((connection) =>
        settings.oauth.request(connection.id)(
          "https://api.openai.com/v1/models",
        ),
      ),
    );
    assert.equal(fixture.h.refreshCalls, 1);
    const callback = fixture.h.callback;
    fixture.h.callback = async () => {};
    const pending = settings.oauth.signIn(first.id);
    const cancelled = assert.rejects(pending, /oauthCancelled/);
    await waitForAuthorization(settings.oauth, first.id);
    await assert.rejects(settings.oauth.signIn(second.id), /oauthBusy/);
    settings.oauth.cancel(first.id);
    await cancelled;
    fixture.h.callback = callback;
    const currentRecord = JSON.parse(
      deps.secureStorage.decryptString(
        Buffer.from(store.config(key)!, "base64"),
      ),
    );
    currentRecord.expiresAt = 0;
    store.setConfig(
      key,
      deps.secureStorage
        .encryptString(JSON.stringify(currentRecord))
        .toString("base64"),
    );
    const refreshing = settings.oauth.request(first.id)(
      "https://api.openai.com/v1/models",
    );
    while (fixture.h.refreshCalls < 2)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await settings.request("ai-connection-remove", first.id);
    assert((await refreshing).ok);
    assert(
      (
        await settings.oauth.request(second.id)(
          "https://api.openai.com/v1/models",
        )
      ).ok,
    );
    assert.equal(fixture.h.refreshCalls, 2);
    assert.equal(fixture.h.revokeCalls, 0);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    settings.close();
    settings = new SettingsService(store, deps);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    await settings.request("ai-connection-remove", second.id);
    assert.equal(fixture.h.revokeCalls, 1);
    assert(!store.config(key));
    const next = connectionConfig(newAIConnection("openai-oauth"));
    const restored = (await settings.request("source-oauth-profiles", {
      source: source(next),
    })) as OpenAIProfiles;
    assert.equal(restored.selectedId, original.selectedId);
    assert.equal(restored.account.status, "signedOut");
    fixture.h.callback = async (url) => {
      assert.equal(url.searchParams.get("client_id"), "oaiapp_fixture");
      await callback(url);
    };
    await authorize(
      settings.request("ai-connection-login", { connection: next }),
      settings.oauth,
      next.id,
    );
    assert.equal(
      (
        (await settings.request("source-oauth-profiles", {
          source: source(next),
        })) as OpenAIProfiles
      ).profiles.length,
      1,
    );
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});

test("additional accounts are explicit and identity changes cannot replace a saved profile", async () => {
  const fixture = await harness();
  const store = new LibraryStore(":memory:", "en");
  const settings = new SettingsService(store, {
    request: fixture.request,
    openBrowser: fixture.openBrowser,
    secureStorage: encryptedStorage(),
  });
  const a = newSource("openai-oauth"),
    b = newSource("openai-oauth");
  try {
    await authorize(
      settings.request("source-oauth-login", a),
      settings.oauth,
      a.id,
    );
    const original = (await settings.request("source-oauth-profiles", {
      source: a,
    })) as OpenAIProfiles;
    await assert.rejects(
      settings.request("source-oauth-select", {
        source: a,
        profileId: "11111111-1111-4111-8111-111111111111",
      }),
      /invalidInput/,
    );
    assert.equal(settings.oauth.status(a.id).status, "connected");
    await settings.request("source-oauth-select", {
      source: b,
      profileId: null,
    });
    fixture.h.clientId = "oaiapp_second";
    fixture.h.subject = "second-user";
    await authorize(
      settings.request("source-oauth-login", b),
      settings.oauth,
      b.id,
    );
    assert.equal(
      fixture.h.auth.searchParams.get("client_id"),
      "dynamic_agent_client",
    );
    const additional = (await settings.request("source-oauth-profiles", {
      source: b,
    })) as OpenAIProfiles;
    assert.equal(additional.profiles.length, 2);
    fixture.h.clientId = "oaiapp_fixture";
    await assert.rejects(
      authorize(
        settings.request("source-oauth-login", a),
        settings.oauth,
        a.id,
      ),
      /oauthAccountMismatch/,
    );
    assert.equal(settings.oauth.status(a.id).status, "connected");
    assert.equal(
      (
        (await settings.request("source-oauth-profiles", {
          source: a,
        })) as OpenAIProfiles
      ).selectedId,
      original.selectedId,
    );
    const c = newSource("openai-oauth");
    await settings.request("source-oauth-select", {
      source: c,
      profileId: original.selectedId,
    });
    assert.equal(settings.oauth.status(c.id).status, "connected");
    // Malformed IDs cannot access Object.prototype or create a new account implicitly.
    const special = { ...newSource("openai-oauth"), id: "__proto__" };
    const selection = (await settings.request("source-oauth-profiles", {
      source: special,
    })) as OpenAIProfiles;
    assert.equal(typeof selection.selectedId, "string");
    assert.equal(selection.profiles.length, 2);
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});

test("legacy credentials migrate in place with their issued client and stable host", async () => {
  const fixture = await harness();
  await authorize(fixture.oauth.signIn("legacy"), fixture.oauth, "legacy");
  const store = new LibraryStore(":memory:", "en");
  const secure = encryptedStorage();
  const deps = {
    request: fixture.request,
    openBrowser: fixture.openBrowser,
    secureStorage: secure,
  };
  let settings = new SettingsService(store, deps);
  const connection = newAIConnection("openai-oauth");
  const state = settings.snapshot();
  state.aiConnections = [connection];
  settings.save(state);
  store.setConfig(
    `source:${connection.id}:oauth`,
    secure
      .encryptString(JSON.stringify(fixture.records.get("legacy")))
      .toString("base64"),
  );
  store.setConfig("openaiOAuthHost", fixture.host()!);
  settings.close();
  settings = new SettingsService(store, deps);
  try {
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    assert.equal(store.config(`source:${connection.id}:oauth`), "");
    await settings.request("ai-connection-logout", connection.id);
    await authorize(
      settings.request("ai-connection-login", {
        connection: connectionConfig(connection),
      }),
      settings.oauth,
      connection.id,
    );
    assert.equal(
      fixture.h.auth.searchParams.get("client_id"),
      "oaiapp_fixture",
    );
    assert.equal(
      fixture.h.auth.searchParams.get("ext_agent_host_id"),
      fixture.host(),
    );
    const publicState = JSON.stringify(settings.snapshot());
    assert(!publicState.includes("access-"));
    assert(!publicState.includes("oaiapp_"));
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});

test("linked recognition sources reuse one ChatGPT identity without creating or revoking feature grants", async () => {
  const fixture = await harness(),
    store = new LibraryStore(":memory:", "en");
  const deps = {
    request: fixture.request,
    openBrowser: fixture.openBrowser,
    secureStorage: encryptedStorage(),
  };
  let settings = new SettingsService(store, deps);
  const connection = connectionConfig(newAIConnection("openai-oauth"));
  const source = {
    ...recognitionSourceConfig({
      ...newSource("openai-oauth"),
      hasKey: false,
      hasSearchKey: false,
      models: [],
    }),
    connectionId: connection.id,
  };
  try {
    await authorize(
      settings.request("ai-connection-login", { connection }),
      settings.oauth,
      connection.id,
    );
    await settings.request("ai-connection-save", { connection });
    const models = (await settings.request("recognition-source-models", {
      source,
    })) as { id: string }[];
    source.model = models[0].id;
    fixture.h.api = async () =>
      stream([
        completed([
          {
            type: "web_search_call",
            status: "completed",
            action: { type: "search" },
          },
        ]),
      ]);
    const result = (await settings.request("recognition-source-search", {
      source,
    })) as any;
    assert.equal(result.status, "connected");
    assert(result.search);
    await settings.request("save-recognition-source", { source });
    const second = {
      ...source,
      id: crypto.randomUUID(),
      name: "Other recognition",
    };
    await settings.request("save-recognition-source", { source: second });
    const revocations = fixture.h.revokeCalls;
    assert.equal(store.config(`source:${source.id}:oauth`), undefined);
    settings.close();
    settings = new SettingsService(store, deps);
    assert(
      settings
        .snapshot()
        .recognition.sources.every((s) => s.account?.status === "connected"),
    );
    assert.equal(
      settings.recognitionRuntime(settings.snapshot().recognition.sources[0])
        .id,
      connection.id,
    );
    await settings.request("remove-source", source.id);
    await settings.request("remove-source", second.id);
    assert.equal(fixture.h.revokeCalls, revocations);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});
