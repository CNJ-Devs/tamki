import test from "node:test";
import { authorize } from "./fixtures/authorization";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { LibraryStore } from "../src/library/store";
import { SettingsService } from "../src/library/settings";
import { AccountSources } from "../src/library/account-sources";
import {
  newSource,
  sourceConfig,
  type CustomSource,
} from "../src/shared/settings";
import { googleHarness } from "./fixtures/google-oauth";
import { runtimeFixture } from "./fixtures/claude-runtime";

function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString(value: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value: Buffer) {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        cipher.update(value.subarray(28)),
        cipher.final(),
      ]).toString();
    },
  };
}

test("saved sources do not consume the bounded pending-draft allowance", async () => {
  const saved = new Map<string, CustomSource>();
  const accounts = new AccountSources({
    read: () => undefined,
    write: () => {},
    saved: (id) => saved.get(id),
    secure: () => {},
    root: "",
    request: (async () => {
      throw new Error("No network expected");
    }) as typeof fetch,
    openBrowser: async () => {},
    callbackText: { success: "ok", failed: "failed" },
  });
  try {
    for (let i = 0; i < 20; i++) {
      const source = newSource("gemini-oauth");
      saved.set(source.id, {
        ...source,
        hasKey: false,
        hasSearchKey: false,
        models: [],
      });
      await accounts.refreshStatus(source);
    }
    const drafts = Array.from({ length: 16 }, () => newSource("gemini-oauth"));
    for (const source of drafts) await accounts.refreshStatus(source);
    await assert.rejects(
      accounts.refreshStatus(newSource("gemini-oauth")),
      /oauthBusy/,
    );
    await accounts.logout(drafts[0].id, true);
    await accounts.refreshStatus(newSource("gemini-oauth"));
  } finally {
    accounts.close();
  }
});

test("Google sources persist encrypted account credentials, invalidate model catalogs by project and survive restart", async () => {
  const fixture = await googleHarness();
  const store = new LibraryStore(":memory:", "en");
  const deps = {
    request: fixture.options.request,
    openBrowser: fixture.options.openBrowser,
    secureStorage: encryption(),
  };
  let settings = new SettingsService(store, deps);
  const source = fixture.source;
  try {
    await authorize(
      settings.request("source-account-login", {
        source,
        oauthClientSecret: "fixture-secret",
      }),
      settings.accounts.google,
      source.id,
    );
    assert.equal(store.config(`source:${source.id}:account`), undefined);
    assert.equal(settings.snapshot().recognition.sources.length, 0);
    const models = await settings.request("source-models", { source });
    assert.equal((models as any[]).length, 1);
    await assert.rejects(
      settings.request("save-source", {
        source: { ...source, project: "other-project" },
      }),
      /chooseModel/,
    );
    await settings.request("save-source", { source });
    const encrypted = store.config(`source:${source.id}:account`);
    assert(encrypted);
    assert(
      !Buffer.from(encrypted!, "base64").toString().includes("fixture-secret"),
    );
    assert(!JSON.stringify(settings.snapshot()).includes("fixture-secret"));
    await settings.request("source-account-discard", source.id);
    assert.equal(
      settings.snapshot().recognition.sources[0].account?.status,
      "connected",
    );
    settings.close();
    settings = new SettingsService(store, deps);
    assert.equal(
      settings.snapshot().recognition.sources[0].account?.status,
      "connected",
    );
    await settings.request("source-models", { source });
    await assert.rejects(
      settings.request("source-account-login", {
        source: {
          ...source,
          provider: "claude-code",
          protocol: "claude-code",
          endpoint: "",
          oauthClientId: "",
        },
      }),
      /invalidInput/,
    );
    await settings.request("source-account-logout", source.id);
    assert.equal(
      settings.snapshot().recognition.sources[0].account?.status,
      "signedOut",
    );
    await assert.rejects(
      settings.request("save-source", { source }),
      /accountSignInRequired/,
    );
    await settings.request("remove-source", source.id);
    assert.equal(store.config(`source:${source.id}:account`), "");
    assert.equal(settings.snapshot().recognition.sources.length, 0);
  } finally {
    settings.close();
    fixture.oauth.close();
    store.close();
  }
});

test("Claude source login, dynamic models, search proof, batched recognition and removal use only the official process interface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tamki-account-test-"));
  const runtime = runtimeFixture();
  const store = new LibraryStore(":memory:", "en");
  const settings = new SettingsService(store, {
    request: (async () => {
      throw new Error("No direct Claude HTTP allowed");
    }) as typeof fetch,
    openBrowser: async () => {
      throw new Error("Official CLI owns auth");
    },
    secureStorage: encryption(),
    runtimeRoot: root,
    runtimeRunner: runtime.runner,
    resolveRuntime: async () => "/fixture/claude",
  });
  const source = { ...newSource("claude-code"), model: "fixture-model" };
  try {
    await settings.request("source-account-login", { source });
    await settings.request("source-models", { source });
    await settings.request("source-account-search", source);
    await settings.request("save-source", { source });
    const saved = settings.snapshot().recognition.sources[0];
    assert.equal(saved.account?.status, "connected");
    assert(saved.account?.search);
    assert.equal(settings.secret(source.id, "key"), "");
    const input = {
      title: "Fixture",
      scope: "work" as const,
      files: Array.from({ length: 30 }, (_, i) => ({
        id: `file-${i}`,
        filename: `Episode ${i}.mkv`,
        duration: 120,
        order: i + 1,
      })),
    };
    const beforeRequests = runtime.calls.filter((c) =>
      c.args.includes("--json-schema"),
    ).length;
    const result = await settings.accounts.recognize(
      sourceConfig(saved),
      input,
      "{{title}}",
      AbortSignal.timeout(2000),
    );
    assert.equal(result.kind, "result");
    if (result.kind === "result") assert.equal(result.result.files.length, 30);
    assert.equal(
      runtime.calls.filter((c) => c.args.includes("--json-schema")).length -
        beforeRequests,
      1,
    );
    await settings.request("source-account-discard", source.id);
    assert.equal(runtime.h.loggedIn, true);
    await settings.request("remove-source", source.id);
    assert.equal(runtime.h.loggedIn, true);
    await settings.request("ai-connection-remove", source.id);
    assert.equal(runtime.h.loggedIn, false);
    assert.equal(settings.snapshot().recognition.sources.length, 0);
  } finally {
    settings.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing a new Claude source discards official login and no source is saved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tamki-account-test-"));
  const runtime = runtimeFixture(),
    store = new LibraryStore(":memory:", "en");
  const settings = new SettingsService(store, {
    request: fetch,
    openBrowser: async () => {},
    secureStorage: encryption(),
    runtimeRoot: root,
    runtimeRunner: runtime.runner,
    resolveRuntime: async () => "/fixture/claude",
  });
  const source = newSource("claude-code");
  try {
    await settings.request("source-account-login", { source });
    await settings.request("source-account-discard", source.id);
    assert.equal(runtime.h.loggedIn, false);
    assert.equal(settings.snapshot().recognition.sources.length, 0);
  } finally {
    settings.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
