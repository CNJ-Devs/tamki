import test from "node:test";
import { authorize } from "./fixtures/authorization";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  aiConnectionSchema,
  connectionConfig,
  newAIConnection,
} from "../src/shared/ai-connections";
import {
  defaultSettings,
  newSource,
  providers,
  type CustomSource,
} from "../src/shared/settings";
import { LibraryStore } from "../src/library/store";
import { SettingsService } from "../src/library/settings";
import { encryptedStorage } from "./fixtures/secure-storage";
import { googleHarness } from "./fixtures/google-oauth";
import { runtimeFixture } from "./fixtures/claude-runtime";

const noBrowser = async () => {
  throw new Error("Unexpected browser");
};
const noRequest = (async () => {
  throw new Error("Unexpected request");
}) as typeof fetch;

test("AI connections accept only provider-specific transport, authentication and billing fields", () => {
  for (const provider of providers) {
    const connection = connectionConfig(newAIConnection(provider.id));
    if (provider.id === "openai-compatible")
      connection.endpoint = "https://example.test/v1";
    assert(aiConnectionSchema.safeParse(connection).success, provider.id);
    for (const [key, value] of Object.entries({
      model: "test",
      timeoutSeconds: 30,
      maxOutputTokens: 8192,
      searchMode: "native",
      readPages: true,
      aiPrompt: "prompt",
      apiKey: "secret",
      searchEndpoint: "https://example.test",
    }))
      assert(
        !aiConnectionSchema.safeParse({ ...connection, [key]: value }).success,
        key,
      );
  }
  const openai = connectionConfig(newAIConnection("openai"));
  assert(
    !aiConnectionSchema.safeParse({ ...openai, runtimePath: "/tmp/executable" })
      .success,
  );
  assert(
    !aiConnectionSchema.safeParse({ ...openai, endpoint: "https://other.test" })
      .success,
  );
  assert(
    !aiConnectionSchema.safeParse({
      ...connectionConfig(newAIConnection("deepseek")),
      project: "project",
    }).success,
  );
});

test("API connections save without a model or inference, retain independent names/keys and survive restart", async () => {
  const store = new LibraryStore(":memory:", "en"),
    secureStorage = encryptedStorage();
  const deps = { request: noRequest, openBrowser: noBrowser, secureStorage };
  let settings = new SettingsService(store, deps);
  const first = {
    ...connectionConfig(newAIConnection("deepseek")),
    name: "Personal",
  };
  const second = {
    ...connectionConfig(newAIConnection("deepseek")),
    name: "Work",
  };
  try {
    await settings.request("ai-connection-save", {
      connection: first,
      apiKey: "first-secret",
    });
    await settings.request("ai-connection-save", {
      connection: second,
      apiKey: "second-secret",
    });
    await assert.rejects(
      settings.request("ai-connection-save", {
        connection: { ...second, name: "Personal" },
      }),
      /aiConnectionNameTaken/,
    );
    const snapshot = settings.snapshot();
    assert.equal(snapshot.aiConnections.length, 2);
    assert.equal(snapshot.recognition.sources.length, 0);
    assert(!JSON.stringify(snapshot).includes("secret"));
    assert.equal(settings.secret(first.id, "key"), "first-secret");
    assert.equal(settings.secret(second.id, "key"), "second-secret");
    assert(
      !Buffer.from(store.config(`source:${first.id}:key`)!, "base64").includes(
        Buffer.from("first-secret"),
      ),
    );
    settings.close();
    settings = new SettingsService(store, deps);
    await settings.request("ai-connection-save", {
      connection: { ...first, name: "Renamed" },
    });
    assert.equal(settings.secret(first.id, "key"), "first-secret");
    await settings.request("ai-connection-discard", first.id);
    assert.equal(settings.snapshot().aiConnections[0].name, "Renamed");
    await settings.request("ai-connection-remove", first.id);
    assert.equal(settings.secret(first.id, "key"), "");
    assert.equal(settings.secret(second.id, "key"), "second-secret");
  } finally {
    settings.close();
    store.close();
  }
});

test("legacy extraction preserves recognition options and reuses the credential record; shared connection deletion is guarded", async () => {
  const store = new LibraryStore(":memory:", "zh"),
    secureStorage = encryptedStorage();
  const source: CustomSource = {
    ...newSource("anthropic"),
    name: "旧来源",
    model: "fixture-model",
    maxOutputTokens: 8192,
    timeoutSeconds: 180,
    domains: ["example.test"],
    hasKey: true,
    hasSearchKey: false,
    models: [{ id: "fixture-model", name: "Fixture" }],
  };
  const old = defaultSettings("zh");
  old.recognition.sources = [source];
  old.recognition.defaultSourceId = source.id;
  const { aiConnections: _, ...legacy } = old;
  const ciphertext = secureStorage
    .encryptString("legacy-key")
    .toString("base64");
  store.setConfigs({
    settings: JSON.stringify(legacy),
    [`source:${source.id}:key`]: ciphertext,
  });
  const settings = new SettingsService(store, {
    request: noRequest,
    openBrowser: noBrowser,
    secureStorage,
  });
  try {
    const before = settings.snapshot();
    assert.deepEqual(before.recognition.sources[0], {
      ...source,
      connectionId: source.id,
      auth: "x-api-key",
      account: undefined,
    });
    assert.equal(before.aiConnections[0].id, source.id);
    assert.equal(store.config(`source:${source.id}:key`), ciphertext);
    assert(!("maxOutputTokens" in before.aiConnections[0]));
    await settings.request("ai-connection-save", {
      connection: {
        ...connectionConfig(before.aiConnections[0]),
        name: "账号 A",
      },
    });
    const after = settings.snapshot();
    assert.equal(after.aiConnections[0].name, "账号 A");
    assert.equal(after.recognition.sources[0].name, "旧来源");
    for (const field of [
      "model",
      "maxOutputTokens",
      "timeoutSeconds",
      "domains",
      "searchMode",
    ] as const)
      assert.deepEqual(after.recognition.sources[0][field], source[field]);
    await assert.rejects(
      settings.request("ai-connection-remove", source.id),
      /aiConnectionInUse/,
    );
    await settings.request("remove-source", source.id);
    assert.equal(settings.snapshot().aiConnections.length, 1);
    assert.equal(settings.secret(source.id, "key"), "legacy-key");
    await settings.request("ai-connection-remove", source.id);
    assert.equal(settings.secret(source.id, "key"), "");
  } finally {
    settings.close();
    store.close();
  }
});

test("connection tests use model discovery, never inference; endpoint edits cannot reuse a key for another host", async () => {
  const store = new LibraryStore(":memory:", "en"),
    secureStorage = encryptedStorage();
  const calls: string[] = [];
  const request = (async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method || "GET", "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer first-key",
    );
    return Response.json({ data: [{ id: "fixture" }] });
  }) as typeof fetch;
  const settings = new SettingsService(store, {
    request,
    secureStorage,
    openBrowser: noBrowser,
  });
  const connection = {
    ...connectionConfig(newAIConnection("openai-compatible")),
    endpoint: "https://first.test/v1",
  };
  try {
    await settings.request("ai-connection-save", {
      connection,
      apiKey: "first-key",
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(
      await settings.request("ai-connection-test", { connection }),
      { modelCount: 1 },
    );
    assert.deepEqual(calls, ["https://first.test/v1/models"]);
    await assert.rejects(
      settings.request("ai-connection-test", {
        connection: { ...connection, endpoint: "https://second.test/v1" },
      }),
      /keyRequired/,
    );
    assert.equal(calls.length, 1);
    await assert.rejects(
      settings.request("ai-connection-save", {
        connection: { ...connection, model: "forbidden" },
      }),
      /unrecognized/i,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test("Google connections authenticate and save without selecting a model; cancellation and deletion retain correct ownership", async () => {
  const fixture = await googleHarness(),
    store = new LibraryStore(":memory:", "en"),
    secureStorage = encryptedStorage();
  const deps = {
    request: fixture.options.request,
    openBrowser: fixture.options.openBrowser,
    secureStorage,
  };
  let settings = new SettingsService(store, deps);
  const connection = connectionConfig(fixture.source);
  try {
    await authorize(
      settings.request("ai-connection-login", {
        connection,
        oauthClientSecret: "fixture-secret",
      }),
      settings.accounts.google,
      connection.id,
    );
    assert.equal(settings.snapshot().aiConnections.length, 0);
    await settings.request("ai-connection-save", { connection });
    assert.equal(fixture.h.apiCalls, 0);
    assert.equal(settings.snapshot().recognition.sources.length, 0);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    await settings.request("ai-connection-discard", connection.id);
    settings.close();
    settings = new SettingsService(store, deps);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    await settings.request("ai-connection-test", { connection });
    await settings.request("ai-connection-remove", connection.id);
    assert.equal(settings.snapshot().aiConnections.length, 0);
    assert.equal(settings.secret(connection.id, "account"), "");
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});

test("Claude connection saves only official account metadata and no model request is sent on login/save", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tamki-ai-connection-"));
  const runtime = runtimeFixture(),
    store = new LibraryStore(":memory:", "en");
  const settings = new SettingsService(store, {
    request: noRequest,
    openBrowser: noBrowser,
    secureStorage: encryptedStorage(),
    runtimeRoot: root,
    runtimeRunner: runtime.runner,
    resolveRuntime: async () => "/fixture/claude",
  });
  const connection = connectionConfig(newAIConnection("claude-code"));
  try {
    await settings.request("ai-connection-login", { connection });
    await settings.request("ai-connection-save", { connection });
    assert(runtime.calls.every((c) => c.args[0] === "auth"));
    assert.equal(settings.snapshot().recognition.sources.length, 0);
    assert.equal(
      settings.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    await settings.request("ai-connection-test", { connection });
    assert(!runtime.calls.some((c) => c.args.includes("--json-schema")));
    await settings.request("ai-connection-remove", connection.id);
    assert.equal(runtime.h.loggedIn, false);
  } finally {
    settings.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
