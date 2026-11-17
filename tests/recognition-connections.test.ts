import test from "node:test";
import assert from "node:assert/strict";
import { SettingsService } from "../src/library/settings";
import { LibraryStore } from "../src/library/store";
import {
  connectionConfig,
  newAIConnection,
} from "../src/shared/ai-connections";
import {
  defaultSettings,
  newSource,
  type CustomSource,
} from "../src/shared/settings";
import { recognitionSourceConfig } from "../src/shared/recognition-source";
import { encryptedStorage } from "./fixtures/secure-storage";
import { googleHarness } from "./fixtures/google-oauth";
import { authorize } from "./fixtures/authorization";

const feature = (connectionId: string, name = "Recognition") => ({
  ...recognitionSourceConfig({
    ...newSource("openai-compatible"),
    hasKey: false,
    hasSearchKey: false,
    models: [],
  }),
  connectionId,
  name,
  model: "fixture",
  maxOutputTokens: 8192,
});
const noBrowser = async () => {
  throw new Error("Unexpected browser");
};

test("recognition sources share named connections but keep feature options, names and credential ownership independent", async () => {
  const store = new LibraryStore(":memory:", "en");
  const calls: { url: string; key: string | null }[] = [];
  const service = new SettingsService(store, {
    secureStorage: encryptedStorage(),
    openBrowser: noBrowser,
    request: (async (url, init) => {
      calls.push({
        url: String(url),
        key: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ data: [{ id: "fixture" }, { id: "other" }] });
    }) as typeof fetch,
  });
  const first = {
    ...connectionConfig(newAIConnection("openai-compatible")),
    name: "Account A",
    endpoint: "https://a.test/v1",
  };
  const second = {
    ...first,
    id: crypto.randomUUID(),
    name: "Account B",
    endpoint: "https://b.test/v1",
  };
  const a = feature(first.id, "Animation"),
    b = { ...feature(first.id, "Films"), model: "other", timeoutSeconds: 180 };
  try {
    await service.request("ai-connection-save", {
      connection: first,
      apiKey: "a-secret",
    });
    await service.request("ai-connection-save", {
      connection: second,
      apiKey: "b-secret",
    });
    await service.request("recognition-source-models", { source: a });
    await service.request("save-recognition-source", { source: a });
    await service.request("save-recognition-source", { source: b });
    assert.deepEqual(calls, [
      { url: "https://a.test/v1/models", key: "Bearer a-secret" },
    ]);
    const sources = service.snapshot().recognition.sources;
    assert.deepEqual(
      sources.map((s) => [s.name, s.model, s.connectionId]),
      [
        ["Animation", "fixture", first.id],
        ["Films", "other", first.id],
      ],
    );
    assert.equal(service.recognitionRuntime(sources[1]).id, first.id);
    assert.equal(service.secret(b.id, "key"), "");
    await service.request("ai-connection-save", {
      connection: { ...first, name: "Renamed account" },
    });
    assert.equal(service.snapshot().recognition.sources[0].name, "Animation");
    assert.equal(service.snapshot().recognition.sources[0].model, "fixture");
    await assert.rejects(
      service.request("ai-connection-remove", first.id),
      /aiConnectionInUse/,
    );
    const moved = { ...a, connectionId: second.id };
    await assert.rejects(
      service.request("save-recognition-source", { source: moved }),
      /chooseModel/,
    );
    await service.request("recognition-source-models", { source: moved });
    await service.request("save-recognition-source", { source: moved });
    assert.equal(
      service.recognitionRuntime(service.snapshot().recognition.sources[0])
        .endpoint,
      second.endpoint,
    );
    await service.request("ai-connection-save", {
      connection: { ...second, endpoint: "https://new.test/v1" },
      apiKey: "new-secret",
    });
    assert.equal(service.snapshot().recognition.sources[0].model, "");
    assert.equal(service.snapshot().recognition.sources[1].model, "other");
    await service.request("recognition-preferences", { defaultSourceId: b.id });
    await service.request("remove-source", b.id);
    assert.equal(service.snapshot().recognition.defaultSourceId, "bangumi");
    assert.equal(service.secret(first.id, "key"), "a-secret");
    await service.request("ai-connection-remove", first.id);
    assert.equal(service.secret(second.id, "key"), "new-secret");
  } finally {
    service.close();
    store.close();
  }
});

test("sources cannot supply transport or authentication, and external-search secrets remain feature-owned", async () => {
  const store = new LibraryStore(":memory:", "en");
  const service = new SettingsService(store, {
    secureStorage: encryptedStorage(),
    openBrowser: noBrowser,
    request: (async () =>
      Response.json({ data: [{ id: "fixture" }] })) as typeof fetch,
  });
  const c = {
    ...connectionConfig(newAIConnection("openai-compatible")),
    endpoint: "https://example.test/v1",
  };
  const source = feature(c.id);
  try {
    await service.request("ai-connection-save", {
      connection: c,
      apiKey: "main-key",
    });
    for (const field of [
      "endpoint",
      "provider",
      "protocol",
      "apiKey",
      "project",
      "oauthClientId",
      "runtimePath",
    ])
      await assert.rejects(
        service.request("recognition-source-models", {
          source: { ...source, [field]: "forbidden" },
        }),
        /unrecognized/i,
      );
    await assert.rejects(
      service.request("save-recognition-source", {
        source,
        apiKey: "forbidden",
      }),
      /unrecognized/i,
    );
    await assert.rejects(
      service.request("recognition-source-models", {
        source: { ...source, connectionId: "missing" },
      }),
      /aiConnectionMissing/,
    );
    await service.request("recognition-source-models", { source });
    const external = {
      ...source,
      searchMode: "external",
      searchEndpoint: "https://search.test",
    };
    await assert.rejects(
      service.request("save-recognition-source", { source: external }),
      /searchKeyRequired/,
    );
    await service.request("save-recognition-source", {
      source: external,
      searchKey: "search-secret",
    });
    await service.request("save-recognition-source", { source: external });
    assert.equal(service.secret(source.id, "search"), "search-secret");
    assert.equal(service.secret(source.id, "key"), "");
    await assert.rejects(
      service.request("save-recognition-source", {
        source: { ...external, searchEndpoint: "https://other.test" },
      }),
      /searchKeyRequired/,
    );
    await service.request("remove-source", source.id);
    assert.equal(service.secret(source.id, "search"), "");
    assert.equal(service.secret(c.id, "key"), "main-key");
  } finally {
    service.close();
    store.close();
  }
});

test("migration links standalone sources even after connections were initialized, without copying credentials or recreating deleted links", () => {
  const store = new LibraryStore(":memory:", "en"),
    secureStorage = encryptedStorage();
  const source: CustomSource = {
    ...newSource("openai"),
    name: "Legacy",
    model: "fixture",
    hasKey: true,
    hasSearchKey: false,
    models: [{ id: "fixture", name: "Fixture" }],
  };
  const settings = defaultSettings("en");
  settings.recognition.sources = [source];
  settings.recognition.defaultSourceId = source.id;
  const encrypted = secureStorage
    .encryptString("legacy-secret")
    .toString("base64");
  store.setConfigs({
    settings: JSON.stringify(settings),
    [`source:${source.id}:key`]: encrypted,
  });
  const deps = {
    secureStorage,
    openBrowser: noBrowser,
    request: (async () => {
      throw new Error("No request expected");
    }) as typeof fetch,
  };
  let service = new SettingsService(store, deps);
  try {
    assert.equal(
      service.snapshot().recognition.sources[0].connectionId,
      source.id,
    );
    assert.equal(service.snapshot().aiConnections.length, 1);
    assert.equal(store.config(`source:${source.id}:key`), encrypted);
    service.close();
    service = new SettingsService(store, deps);
    assert.equal(service.snapshot().aiConnections.length, 1);
    const saved = service.snapshot();
    saved.aiConnections = [];
    service.save(saved);
    assert.equal(service.snapshot().aiConnections.length, 0);
    assert.throws(
      () =>
        service.recognitionRuntime(service.snapshot().recognition.sources[0]),
      /aiConnectionMissing/,
    );
  } finally {
    service.close();
    store.close();
  }
});

test("late model discovery cannot restore a removed connection or cache a prior credential's catalog", async () => {
  const store = new LibraryStore(":memory:", "en");
  let release: (value: Response) => void = () => {};
  const service = new SettingsService(store, {
    secureStorage: encryptedStorage(),
    openBrowser: noBrowser,
    request: (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as typeof fetch,
  });
  const c = {
      ...connectionConfig(newAIConnection("openai-compatible")),
      endpoint: "https://example.test/v1",
    },
    source = feature(c.id);
  try {
    await service.request("ai-connection-save", {
      connection: c,
      apiKey: "old-key",
    });
    const pending = service.request("recognition-source-models", { source });
    const rejected = assert.rejects(pending, /aiConnectionChanged/);
    await service.request("ai-connection-save", {
      connection: c,
      apiKey: "new-key",
    });
    release(Response.json({ data: [{ id: "fixture" }] }));
    await rejected;
    assert.deepEqual(service.snapshot().aiConnections[0].models, []);
    const removed = service.request("recognition-source-models", { source });
    const removedRejection = assert.rejects(removed, /aiConnectionChanged/);
    await service.request("ai-connection-remove", c.id);
    release(Response.json({ data: [{ id: "fixture" }] }));
    await removedRejection;
    assert.equal(service.snapshot().aiConnections.length, 0);
  } finally {
    service.close();
    store.close();
  }
});

test("Google feature sources use the saved connection session, project and model catalog across restart", async () => {
  const fixture = await googleHarness(),
    store = new LibraryStore(":memory:", "en");
  const deps = {
    secureStorage: encryptedStorage(),
    request: fixture.options.request,
    openBrowser: fixture.options.openBrowser,
  };
  let service = new SettingsService(store, deps);
  const c = connectionConfig(fixture.source),
    source = { ...feature(c.id), searchMode: "native" };
  try {
    await authorize(
      service.request("ai-connection-login", {
        connection: c,
        oauthClientSecret: "fixture-secret",
      }),
      service.accounts.google,
      c.id,
    );
    await service.request("ai-connection-save", { connection: c });
    await service.request("recognition-source-models", { source });
    await service.request("save-recognition-source", { source });
    const encrypted = store.config(`source:${c.id}:account`);
    assert.equal(store.config(`source:${source.id}:account`), undefined);
    service.close();
    service = new SettingsService(store, deps);
    const saved = service.snapshot().recognition.sources[0];
    assert.equal(saved.account?.status, "connected");
    const runtime = service.recognitionRuntime(saved);
    assert.equal(runtime.id, c.id);
    assert.equal(runtime.project, c.project);
    const recognized = await service.accounts.recognize(
      runtime,
      {
        title: "Fixture",
        scope: "file",
        files: [{ id: "stable", filename: "file.mkv", duration: 24, order: 1 }],
      },
      "Identify this file.",
      new AbortController().signal,
    );
    assert.equal(recognized.kind, "result");
    await service.request("remove-source", source.id);
    assert.equal(
      service.snapshot().aiConnections[0].account?.status,
      "connected",
    );
    assert(encrypted);
    assert(service.secret(c.id, "account"));
  } finally {
    service.close();
    fixture.oauth.close();
    store.close();
  }
});

test("manual recognition uses shared connections without creating source copies", () => {
  const store = new LibraryStore(":memory:");
  const service = new SettingsService(store, {
    secureStorage: encryptedStorage(),
    request: fetch,
    openBrowser: noBrowser,
  });
  try {
    const settings = defaultSettings("en");
    const first = {
      ...newAIConnection("openai-compatible"),
      id: "zoe",
      name: "Zoe",
      auth: "none" as const,
      endpoint: "https://first.test/v1",
      models: [
        { id: "small", name: "Small" },
        { id: "large", name: "Large", outputLimit: 4096 },
      ],
    };
    const second = {
      ...first,
      id: "jz",
      name: "JZ",
      endpoint: "https://second.test/v1",
    };
    settings.aiConnections = [first, second];
    settings.recognition.sources = [
      {
        ...newSource("openai-compatible"),
        id: "profile",
        name: "Old name",
        connectionId: first.id,
        model: "small",
        searchMode: "none",
        timeoutSeconds: 180,
        maxOutputTokens: 8192,
        hasKey: false,
        hasSearchKey: false,
        models: first.models,
      },
    ];
    service.save(settings);
    const before = store.config("settings");
    const selected = service.recognitionSelection("connection:jz", "large")!;
    assert.equal(selected.connectionId, "jz");
    assert.equal(service.recognitionRuntime(selected).id, "jz");
    assert.equal(
      service.recognitionRuntime(selected).endpoint,
      second.endpoint,
    );
    assert.equal(selected.maxOutputTokens, 4096);
    assert.equal(
      store.config("settings"),
      before,
      "selection must not copy or migrate configuration",
    );
    const existing = service.recognitionSelection("profile", "large")!;
    assert.equal(existing.timeoutSeconds, 180);
    assert.equal(existing.maxOutputTokens, 4096);
    assert.equal(service.recognitionRuntime(existing).id, "zoe");
    assert.throws(
      () => service.recognitionSelection("connection:missing", "large"),
      /aiConnectionMissing/,
    );
    assert.throws(
      () => service.recognitionSelection("connection:jz", "invented"),
      /chooseModel/,
    );
    assert.throws(
      () => service.recognitionSelection("profile", "invented"),
      /chooseModel/,
    );
    second.name = "Renamed";
    second.endpoint = "https://changed.test/v1";
    service.save(settings);
    assert.equal(
      service.recognitionRuntime(selected).endpoint,
      second.endpoint,
      "runtime re-resolves saved connection",
    );
    assert.equal(service.snapshot().recognition.sources.length, 1);
  } finally {
    service.close();
    store.close();
  }
});
