import { createHash } from "node:crypto";
import { z } from "zod";
import type { LibraryStore } from "./store";
import {
  defaultSettings,
  sourceInputSchema,
  sourceConfig,
  promptSchema,
  sourceSchema,
  newSource,
  searchSettingsKey,
  type SettingsState,
  type ModelOption,
  type SourceConfig,
  type CustomSource,
} from "../shared/settings";
import { discoverModels } from "../providers/models";
import { ProviderError } from "../providers/provider";
import { id } from "../shared/validation";
import { OpenAIOAuth } from "../providers/openai-oauth";
import { OpenAIProfiles } from "./openai-profiles";
import { openAIStream, usedWebSearch } from "../providers/openai-stream";
import { oauthMessages } from "../shared/oauth-messages";
import { AccountSources } from "./account-sources";
import type { RuntimeRunner } from "../providers/claude-code";
import {
  aiConnectionInput,
  connectionConfig,
  connectionFromSource,
  connectionIdentity,
  connectionSource,
  type AIConnection,
  type AIConnectionConfig,
} from "../shared/ai-connections";
import { usesAccount } from "../shared/settings";
import { aiStructured, type StructuredTask } from "../providers/ai-recognition";
import {
  recognitionSourceInput,
  recognitionSourceConfig,
  resolveRecognitionSource,
} from "../shared/recognition-source";

interface SettingsDependencies {
  request: typeof fetch;
  openBrowser(url: string): Promise<void>;
  writeClipboard?(value: string): void;
  runtimeRoot?: string;
  runtimeRunner?: RuntimeRunner;
  resolveRuntime?: (path: string) => Promise<string>;
  secureStorage: {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend(): string;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  };
}

export class SettingsService {
  private catalogs = new Map<string, ModelOption[]>();
  private oauthCatalogs = new Map<string, ModelOption[]>();
  private oauthProfiles: OpenAIProfiles;
  private probes = new Map<string, AbortController>();
  private connectionDrafts = new Map<string, AIConnectionConfig>();
  private oauthSelections = new Map<string, symbol>();
  readonly oauth: OpenAIOAuth;
  readonly accounts: AccountSources;
  constructor(
    private store: LibraryStore,
    private dependencies: SettingsDependencies,
  ) {
    const text = oauthMessages[store.preferences().language];
    this.oauthProfiles = new OpenAIProfiles(
      store,
      (value) => this.protect(value),
      (value) =>
        dependencies.secureStorage.decryptString(Buffer.from(value, "base64")),
      (sourceId) => !!this.savedSource(sourceId),
    );
    this.oauth = new OpenAIOAuth({
      request: dependencies.request,
      openBrowser: dependencies.openBrowser,
      callbackText: {
        success: text.oauthCallbackReceived,
        failed: text.oauthCallbackFailed,
      },
      storage: this.oauthProfiles,
    });
    this.accounts = new AccountSources({
      request: dependencies.request,
      openBrowser: dependencies.openBrowser,
      root: dependencies.runtimeRoot || "",
      runner: dependencies.runtimeRunner,
      resolveRuntime: dependencies.resolveRuntime,
      secure: () => {
        this.protect("account-storage-check");
      },
      saved: (id) => this.savedSource(id),
      read: (id) => {
        const value = this.secret(id, "account");
        return value ? JSON.parse(value) : undefined;
      },
      write: (id, record) =>
        store.setConfig(
          `source:${id}:account`,
          record ? this.protect(JSON.stringify(record)) : "",
        ),
      callbackText: {
        success: text.oauthCallbackReceived,
        failed: text.oauthCallbackFailed,
      },
    });
  }
  private savedSource(sourceId: string): CustomSource | undefined {
    const value = this.store.config("settings");
    if (!value) return undefined;
    const settings = JSON.parse(value) as SettingsState;
    const connection = settings.aiConnections?.find((c) => c.id === sourceId);
    if (connection)
      return {
        ...connectionSource(connection),
        hasKey: connection.hasKey,
        hasSearchKey: false,
        models: connection.models,
      };
    return settings.recognition.sources.find((s) => s.id === sourceId);
  }
  close() {
    this.oauth.close();
    this.accounts.close();
    for (const controller of this.probes.values()) controller.abort();
    this.oauthProfiles.close();
    this.connectionDrafts.clear();
    this.oauthSelections.clear();
  }
  snapshot(): SettingsState {
    const config = this.store.config("settings");
    const result = config
      ? JSON.parse(config)
      : defaultSettings(this.store.preferences().language);
    if (result.recognition.parser === "guessit")
      result.recognition.parser = "release";
    if (result.recognition.parser === "anitopy")
      result.recognition.parser = "anitomy";
    let migrated = !result.aiConnections;
    result.aiConnections ||= [];
    for (const source of result.recognition.sources as CustomSource[]) {
      if (source.connectionId) continue;
      // Reuse stable IDs and encrypted credentials, including standalone sources
      // created after the first extraction. Never merge different accounts.
      if (!result.aiConnections.some((c: AIConnection) => c.id === source.id))
        result.aiConnections.push(connectionFromSource(source));
      source.connectionId = source.id;
      migrated = true;
    }
    if (migrated) this.save(result);
    result.aiConnections = result.aiConnections.map(
      (connection: AIConnection) => ({
        ...connection,
        account:
          connection.provider === "openai-oauth"
            ? this.oauth.status(connection.id)
            : ["gemini-oauth", "claude-code"].includes(connection.provider)
              ? this.accounts.status(connectionSource(connection))
              : undefined,
      }),
    );
    result.recognition.sources = result.recognition.sources.map(
      (source: CustomSource) => {
        const connection = result.aiConnections.find(
          (c: AIConnection) => c.id === source.connectionId,
        );
        return connection
          ? {
              ...source,
              ...connectionConfig(connection),
              id: source.id,
              name: source.name,
              hasKey: connection.hasKey,
              account: connection.account,
            }
          : {
              ...source,
              model: "",
              models: [],
              hasKey: false,
              account: undefined,
            };
      },
    );
    return result;
  }
  save(value: SettingsState) {
    this.store.setConfig("settings", JSON.stringify(value));
  }
  async featureModels(connectionId: string) {
    const connection = this.snapshot().aiConnections.find(
      (c) => c.id === connectionId,
    );
    if (!connection) throw new ProviderError("aiConnectionMissing");
    const source = recognitionSourceConfig({
      ...newSource(connection.provider),
      connectionId,
      hasKey: connection.hasKey,
      hasSearchKey: false,
      models: [],
    });
    return this.recognitionSourceRequest("recognition-source-models", {
      source,
    });
  }
  featureRuntime(
    connectionId: string,
    model: string,
    webSearch: boolean,
  ): SourceConfig {
    const connection = this.snapshot().aiConnections.find(
      (c) => c.id === connectionId,
    );
    if (!connection) throw new ProviderError("aiConnectionMissing");
    if (
      usesAccount(connection.provider) &&
      connection.account?.status !== "connected"
    )
      throw new ProviderError("accountSignInRequired");
    const selected = connection.models.find((m) => m.id === model);
    if (!selected) throw new ProviderError("chooseModel");
    return sourceSchema.parse({
      ...newSource(connection.provider),
      ...connectionConfig(connection),
      model,
      searchMode: webSearch ? "native" : "none",
      maxOutputTokens: Math.min(32768, selected.outputLimit || 32768),
    });
  }
  async structured(
    source: SourceConfig,
    task: StructuredTask,
    signal: AbortSignal,
  ) {
    // Resolve the current saved identity again before each request.
    const runtime = this.featureRuntime(
      source.id,
      source.model,
      source.searchMode === "native",
    );
    if (
      connectionIdentity(connectionConfig(runtime)) !==
      connectionIdentity(connectionConfig(source))
    )
      throw new ProviderError("aiConnectionChanged");
    return ["gemini-oauth", "claude-code"].includes(runtime.provider)
      ? this.accounts.structured(runtime, task, signal)
      : aiStructured(
          runtime,
          runtime.provider === "openai-oauth"
            ? "oauth-managed"
            : this.secret(runtime.id, "key"),
          "",
          task,
          signal,
          runtime.provider === "openai-oauth"
            ? this.oauth.request(runtime.id)
            : this.dependencies.request,
        );
  }
  recognitionSelection(
    sourceId: string,
    model?: string,
  ): CustomSource | undefined {
    const settings = this.snapshot();
    const saved = settings.recognition.sources.find((s) => s.id === sourceId);
    if (saved) {
      if (!model || model === saved.model) return saved;
      const connection = settings.aiConnections.find(
        (c) => c.id === saved.connectionId,
      );
      const selected = connection?.models.find((m) => m.id === model);
      if (!selected) throw new ProviderError("chooseModel");
      return {
        ...saved,
        model,
        maxOutputTokens: Math.min(
          saved.maxOutputTokens,
          selected.outputLimit || saved.maxOutputTokens,
        ),
      };
    }
    if (!sourceId.startsWith("connection:")) return undefined;
    const connectionId = sourceId.slice("connection:".length);
    const connection = settings.aiConnections.find(
      (c) => c.id === connectionId,
    );
    if (!connection) throw new ProviderError("aiConnectionMissing");
    // Resolve the shared saved identity; never create or copy an account/profile.
    const runtime = this.featureRuntime(
      connectionId,
      model || "",
      connection.provider !== "openai-compatible",
    );
    return {
      ...runtime,
      connectionId,
      hasKey: connection.hasKey,
      account: connection.account,
      models: connection.models,
      hasSearchKey: false,
    };
  }
  recognitionRuntime(source: CustomSource): SourceConfig {
    const connection = this.snapshot().aiConnections.find(
      (c) => c.id === source.connectionId,
    );
    if (!connection) throw new ProviderError("aiConnectionMissing");
    const resolved = resolveRecognitionSource(
      recognitionSourceConfig(source),
      connection,
    );
    // The providers' account/session handles are connection IDs, not feature IDs.
    return { ...resolved, id: connection.id };
  }
  private connectionStamp(connection: AIConnection): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          connectionIdentity(connection),
          usesAccount(connection.provider)
            ? connection.account
            : this.secret(connection.id, "key"),
        ]),
      )
      .digest("hex");
  }
  private async recognitionSourceRequest(
    type: string,
    value: unknown,
  ): Promise<unknown> {
    const input = recognitionSourceInput.parse(value);
    const settings = this.snapshot();
    const connection = settings.aiConnections.find(
      (c) => c.id === input.source.connectionId,
    );
    if (!connection) throw new ProviderError("aiConnectionMissing");
    const previous = settings.recognition.sources.find(
      (s) => s.id === input.source.id,
    );
    if (
      !previous &&
      settings.aiConnections.some((c) => c.id === input.source.id)
    )
      throw new ProviderError("invalidInput");
    const source = resolveRecognitionSource(input.source, connection);
    const runtime = { ...source, id: connection.id };
    const account = usesAccount(connection.provider);
    if (account && connection.account?.status !== "connected")
      throw new ProviderError(
        connection.account?.status === "planRequired"
          ? "oauthPlanRequired"
          : "accountSignInRequired",
      );
    const key = account ? "" : this.secret(connection.id, "key");
    if (!account && connection.auth !== "none" && !key)
      throw new ProviderError("keyRequired");
    if (input.searchKey && source.searchMode !== "external")
      throw new ProviderError("invalidInput");
    if (type === "recognition-source-models") {
      const stamp = this.connectionStamp(connection);
      const models =
        connection.provider === "openai-oauth"
          ? await discoverModels(
              runtime,
              "oauth-managed",
              this.oauth.request(connection.id),
            )
          : ["gemini-oauth", "claude-code"].includes(connection.provider)
            ? await this.accounts.models(runtime)
            : await discoverModels(runtime, key, this.dependencies.request);
      const current = this.snapshot();
      const latest = current.aiConnections.find((c) => c.id === connection.id);
      if (!latest || this.connectionStamp(latest) !== stamp)
        throw new ProviderError("aiConnectionChanged");
      latest.models = models;
      this.save(current);
      if (connection.provider === "openai-oauth")
        this.oauthCatalogs.set(connection.id, models);
      return models;
    }
    const model = connection.models.find((m) => m.id === source.model);
    if (!model) throw new ProviderError("chooseModel");
    if (
      model.outputLimit &&
      source.maxOutputTokens > model.outputLimit &&
      !["openai-oauth", "claude-code"].includes(source.provider)
    )
      throw new ProviderError("outputLimitExceeded");
    if (type === "recognition-source-search") {
      if (!account || source.searchMode !== "native")
        throw new ProviderError("invalidInput");
      return connection.provider === "openai-oauth"
        ? this.request("source-oauth-search", runtime)
        : this.accounts.search(runtime);
    }
    const searchKey =
      source.searchMode === "external"
        ? input.searchKey?.trim() ||
          (previous?.searchEndpoint === source.searchEndpoint
            ? this.secret(source.id, "search")
            : "")
        : "";
    if (source.searchMode === "external" && !searchKey)
      throw new ProviderError("searchKeyRequired");
    const saved: CustomSource = {
      ...source,
      connectionId: connection.id,
      hasKey: connection.hasKey,
      hasSearchKey: !!searchKey,
      models: connection.models,
    };
    settings.recognition.sources = previous
      ? settings.recognition.sources.map((s) =>
          s.id === source.id ? saved : s,
        )
      : [...settings.recognition.sources, saved];
    this.store.setConfigs({
      [`source:${source.id}:search`]: searchKey ? this.protect(searchKey) : "",
      settings: JSON.stringify(settings),
    });
  }
  private protect(value: string): string {
    const safeStorage = this.dependencies.secureStorage;
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new ProviderError("secureStorageUnavailable");
    return safeStorage.encryptString(value).toString("base64");
  }
  secret(id: string, kind: "key" | "search" | "oauth" | "account"): string {
    const value = this.store.config(`source:${id}:${kind}`);
    if (!value) return "";
    try {
      return this.dependencies.secureStorage.decryptString(
        Buffer.from(value, "base64"),
      );
    } catch {
      throw new ProviderError("secureStorageUnavailable");
    }
  }
  private fingerprint(source: SourceConfig, key: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          source.provider,
          source.endpoint,
          source.auth,
          source.project,
          source.organization,
          key,
        ]),
      )
      .digest("hex");
  }
  private syncLegacyConnection(settings: SettingsState, source: CustomSource) {
    source.connectionId = source.id;
    const previous = settings.aiConnections.find((c) => c.id === source.id);
    const connection = connectionFromSource(source);
    // A recognition source and its reusable connection can have different names.
    if (previous) connection.name = previous.name;
    settings.aiConnections = previous
      ? settings.aiConnections.map((c) => (c.id === source.id ? connection : c))
      : [...settings.aiConnections, connection];
  }
  private async connectionRequest(
    type: string,
    value: unknown,
  ): Promise<unknown> {
    if (
      [
        "ai-connection-remove",
        "ai-connection-logout",
        "ai-connection-discard",
      ].includes(type)
    ) {
      const connectionId = id.parse(value),
        settings = this.snapshot();
      this.oauthSelections.delete(connectionId);
      const saved = settings.aiConnections.find((c) => c.id === connectionId);
      if (
        type === "ai-connection-remove" &&
        settings.recognition.sources.some(
          (s) => s.connectionId === connectionId,
        )
      )
        throw new ProviderError("aiConnectionInUse");
      const connection = saved || this.connectionDrafts.get(connectionId);
      let revoked = true;
      if (
        connection?.provider === "openai-oauth" ||
        this.oauthProfiles.has(connectionId)
      ) {
        this.oauth.cancel(connectionId);
        if (
          type === "ai-connection-logout" ||
          ((type !== "ai-connection-discard" || !saved) &&
            !this.oauthProfiles.hasPeers(connectionId))
        )
          revoked = await this.oauth.signOut(connectionId);
        if (
          type === "ai-connection-remove" ||
          (type === "ai-connection-discard" && !saved)
        )
          this.oauthProfiles.release(connectionId);
      } else if (
        connection &&
        ["gemini-oauth", "claude-code"].includes(connection.provider)
      ) {
        revoked = (
          await this.accounts.logout(
            connectionId,
            type === "ai-connection-discard",
          )
        ).revoked;
      }
      this.connectionDrafts.delete(connectionId);
      if (type === "ai-connection-remove") {
        const current = this.snapshot();
        current.aiConnections = current.aiConnections.filter(
          (c) => c.id !== connectionId,
        );
        this.store.setConfigs({
          [`source:${connectionId}:key`]: "",
          [`source:${connectionId}:oauth`]: "",
          [`source:${connectionId}:account`]: "",
          settings: JSON.stringify(current),
        });
      }
      return { revoked, account: { email: "", status: "signedOut" } };
    }
    const input = aiConnectionInput.parse(value),
      connection = input.connection;
    const source = connectionSource(connection),
      previous = this.snapshot().aiConnections.find(
        (c) => c.id === connection.id,
      );
    if (previous && previous.provider !== connection.provider)
      throw new ProviderError("invalidInput");
    const draft = this.connectionDrafts.get(connection.id);
    if (draft && draft.provider !== connection.provider)
      throw new ProviderError("invalidInput");
    if (
      !previous &&
      !this.connectionDrafts.has(connection.id) &&
      [...this.connectionDrafts.keys()].filter((id) => !this.savedSource(id))
        .length >= 16
    )
      throw new ProviderError("oauthBusy");
    this.connectionDrafts.set(connection.id, connection);
    if (input.oauthClientSecret && connection.provider !== "gemini-oauth")
      throw new ProviderError("invalidInput");
    if (usesAccount(connection.provider) && input.apiKey)
      throw new ProviderError("invalidInput");
    if (connection.auth === "none" && input.apiKey)
      throw new ProviderError("invalidInput");
    if (type === "ai-connection-login") {
      if (connection.provider === "openai-oauth")
        return this.request("source-oauth-login", source);
      if (["gemini-oauth", "claude-code"].includes(connection.provider))
        return this.accounts.login(source, input.oauthClientSecret);
      throw new ProviderError("invalidInput");
    }
    if (type === "ai-connection-projects")
      return this.accounts.projects(source);
    const sameEndpoint =
      previous?.endpoint === connection.endpoint &&
      previous?.auth === connection.auth;
    const key =
      input.apiKey?.trim() ||
      (sameEndpoint ? this.secret(connection.id, "key") : "");
    if (!usesAccount(connection.provider) && connection.auth !== "none" && !key)
      throw new ProviderError("keyRequired");
    if (type === "ai-connection-test") {
      const models =
        connection.provider === "openai-oauth"
          ? await discoverModels(
              source,
              "oauth-managed",
              this.oauth.request(connection.id),
            )
          : ["gemini-oauth", "claude-code"].includes(connection.provider)
            ? await this.accounts.models(source)
            : await discoverModels(source, key, this.dependencies.request);
      // Catalog access tests authentication without sending inference or search requests.
      return { modelCount: models.length };
    }
    if (type !== "ai-connection-save") throw new ProviderError("invalidInput");
    if (
      (!previous || previous.name !== connection.name) &&
      this.snapshot().aiConnections.some(
        (c) =>
          c.id !== connection.id &&
          c.name.toLocaleLowerCase() === connection.name.toLocaleLowerCase(),
      )
    )
      throw new ProviderError("aiConnectionNameTaken");
    const secrets: Record<string, string> = {};
    if (connection.provider === "openai-oauth") {
      const account = this.oauth.status(connection.id);
      if (account.status !== "connected")
        throw new ProviderError(
          account.status === "planRequired"
            ? "oauthPlanRequired"
            : "oauthSignInRequired",
        );
      Object.assign(secrets, this.oauthProfiles.prepareCommit(connection.id));
    } else if (["gemini-oauth", "claude-code"].includes(connection.provider)) {
      secrets[`source:${connection.id}:account`] = this.protect(
        JSON.stringify(this.accounts.prepareConnectionSave(source)),
      );
    } else
      secrets[`source:${connection.id}:key`] = key ? this.protect(key) : "";
    const changed =
      previous &&
      (connectionIdentity(previous) !== connectionIdentity(connection) ||
        (!usesAccount(connection.provider) &&
          key !== this.secret(connection.id, "key")));
    const saved: AIConnection = {
      ...connection,
      hasKey: !!key,
      models: changed ? [] : previous?.models || [],
    };
    const current = this.snapshot();
    current.aiConnections = current.aiConnections.some((c) => c.id === saved.id)
      ? current.aiConnections.map((c) => (c.id === saved.id ? saved : c))
      : [...current.aiConnections, saved];
    // Connection edits reach every consumer without overwriting source names.
    current.recognition.sources = current.recognition.sources.map((s) =>
      s.connectionId === saved.id
        ? {
            ...s,
            ...connectionConfig(saved),
            id: s.id,
            name: s.name,
            hasKey: saved.hasKey,
            ...(changed ? { model: "", models: [] } : {}),
          }
        : s,
    );
    this.store.setConfigs({ ...secrets, settings: JSON.stringify(current) });
    this.oauthProfiles.committed(connection.id);
    this.accounts.committed(connection.id);
    this.connectionDrafts.delete(connection.id);
  }
  async request(type: string, value: unknown) {
    if (
      [
        "recognition-source-models",
        "recognition-source-search",
        "save-recognition-source",
      ].includes(type)
    )
      return this.recognitionSourceRequest(type, value);
    if (type === "source-authorization") {
      const sourceId = id.parse(value);
      return (
        this.oauth.authorization(sourceId) ||
        this.accounts.google.authorization(sourceId)
      );
    }
    if (
      [
        "source-authorization-open",
        "source-authorization-copy",
        "source-authorization-cancel",
      ].includes(type)
    ) {
      const input = z
        .object({ sourceId: id, authorizationId: z.uuid().optional() })
        .strict()
        .parse(value);
      const owner = this.oauth.authorization(input.sourceId)
        ? this.oauth
        : this.accounts.google;
      const pending = owner.authorization(input.sourceId);
      if (type === "source-authorization-cancel") {
        // A delayed cancellation of an earlier attempt cannot cancel a new login.
        if (input.authorizationId && pending?.id !== input.authorizationId)
          return;
        this.oauth.cancel(input.sourceId);
        this.accounts.google.cancel(input.sourceId);
        this.accounts.claude.cancel(input.sourceId);
        return;
      }
      if (!pending?.url || pending.id !== input.authorizationId)
        throw new ProviderError("authExpired");
      if (type === "source-authorization-open")
        return owner.openAuthorization(input.sourceId, pending.id);
      if (!this.dependencies.writeClipboard)
        throw new ProviderError("oauthCopyFailed");
      try {
        this.dependencies.writeClipboard(pending.url);
      } catch {
        throw new ProviderError("oauthCopyFailed");
      }
      return;
    }
    if (type.startsWith("ai-connection-"))
      return this.connectionRequest(type, value);
    const settings = this.snapshot();
    switch (type) {
      case "source-oauth-profiles":
      case "source-oauth-select": {
        const input = z
          .object({
            source: sourceSchema,
            profileId: z.uuid().nullable().optional(),
          })
          .strict()
          .parse(value);
        const source = input.source,
          saved = this.savedSource(source.id);
        if (
          source.provider !== "openai-oauth" ||
          (saved && saved.provider !== source.provider)
        )
          throw new ProviderError("invalidInput");
        if (this.oauth.busy(source.id) || this.oauthSelections.has(source.id))
          throw new ProviderError("oauthBusy");
        this.protect("oauth-storage-check");
        let revoked = true;
        if (type === "source-oauth-select") {
          if (saved || input.profileId === undefined)
            throw new ProviderError("invalidInput");
          if (
            input.profileId &&
            !this.oauthProfiles.profiles().some((p) => p.id === input.profileId)
          )
            throw new ProviderError("invalidInput");
          const selection = Symbol();
          this.oauthSelections.set(source.id, selection);
          try {
            if (input.profileId !== this.oauthProfiles.key(source.id)) {
              if (
                this.oauthProfiles.has(source.id) &&
                !this.oauthProfiles.hasPeers(source.id)
              )
                revoked = await this.oauth.signOut(source.id);
              if (this.oauthSelections.get(source.id) !== selection)
                throw new ProviderError("oauthCancelled");
              this.oauthProfiles.select(
                source.id,
                source.name,
                input.profileId,
              );
              this.oauthCatalogs.delete(source.id);
            }
          } finally {
            if (this.oauthSelections.get(source.id) === selection)
              this.oauthSelections.delete(source.id);
          }
        } else this.oauthProfiles.ensure(source.id, source.name);
        return {
          selectedId: this.oauthProfiles.key(source.id),
          profiles: this.oauthProfiles.profiles(),
          account: this.oauth.status(source.id),
          revoked,
        };
      }
      case "source-account-login": {
        const input = sourceInputSchema.parse(value);
        if (input.apiKey || input.searchKey)
          throw new ProviderError("invalidInput");
        return this.accounts.login(input.source, input.oauthClientSecret);
      }
      case "source-account-status":
        return this.accounts.refreshStatus(sourceSchema.parse(value));
      case "source-account-projects":
        return this.accounts.projects(sourceSchema.parse(value));
      case "source-account-search":
        return this.accounts.search(sourceSchema.parse(value));
      case "source-account-logout":
      case "source-account-discard":
        return this.accounts.logout(
          id.parse(value),
          type === "source-account-discard",
        );
      case "source-oauth-login": {
        const source = sourceSchema.parse(value);
        if (this.oauthSelections.has(source.id))
          throw new ProviderError("oauthBusy");
        if (
          source.provider !== "openai-oauth" ||
          (this.savedSource(source.id) &&
            this.savedSource(source.id)?.provider !== "openai-oauth")
        )
          throw new ProviderError("invalidInput");
        // Fail before opening the browser if this machine cannot protect credentials.
        this.protect("oauth-storage-check");
        this.oauthProfiles.ensure(source.id, source.name);
        this.probes.get(source.id)?.abort();
        const account = await this.oauth.signIn(source.id);
        this.oauthCatalogs.delete(source.id);
        return {
          account,
          firstUse:
            account.status === "connected" &&
            !this.store.config("openaiOAuthWelcomed"),
        };
      }
      case "source-oauth-welcome":
        this.store.setConfig("openaiOAuthWelcomed", "1");
        return;
      case "source-oauth-cancel":
        this.oauth.cancel(id.parse(value));
        return;
      case "source-oauth-discard": {
        const sourceId = id.parse(value);
        this.oauthSelections.delete(sourceId);
        this.oauth.cancel(sourceId);
        this.probes.get(sourceId)?.abort();
        if (!this.savedSource(sourceId)) {
          this.oauthCatalogs.delete(sourceId);
          const revoked = this.oauthProfiles.hasPeers(sourceId)
            ? true
            : await this.oauth.signOut(sourceId);
          this.oauthProfiles.release(sourceId);
          return { revoked };
        }
        return { revoked: true };
      }
      case "source-oauth-logout": {
        const sourceId = id.parse(value);
        const saved = this.savedSource(sourceId);
        if (saved && saved.provider !== "openai-oauth")
          throw new ProviderError("invalidInput");
        this.probes.get(sourceId)?.abort();
        this.oauthCatalogs.delete(sourceId);
        const revoked = await this.oauth.signOut(sourceId);
        return { account: this.oauth.status(sourceId), revoked };
      }
      case "source-oauth-search": {
        const source = sourceSchema.parse(value);
        if (
          source.provider !== "openai-oauth" ||
          source.searchMode !== "native"
        )
          throw new ProviderError("invalidInput");
        this.oauthModel(source);
        if (this.probes.has(source.id)) throw new ProviderError("oauthBusy");
        const controller = new AbortController();
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(Math.min(source.timeoutSeconds, 90) * 1000),
        ]);
        this.probes.set(source.id, controller);
        this.oauth.recordSearch(source.id, undefined);
        try {
          const response = await openAIStream(
            {
              model: source.model,
              instructions:
                "Use the web search tool once. Return one short sentence and its source URL.",
              input: [
                {
                  role: "user",
                  content: "Find the official OpenAI website using web search.",
                },
              ],
              tools: [
                {
                  type: "web_search",
                  external_web_access: source.liveAccess,
                  ...(source.domainMode !== "all"
                    ? {
                        filters: {
                          [source.domainMode === "allow"
                            ? "allowed_domains"
                            : "blocked_domains"]: source.domains,
                        },
                      }
                    : {}),
                  ...(source.country
                    ? {
                        user_location: {
                          type: "approximate",
                          country: source.country.toUpperCase(),
                        },
                      }
                    : {}),
                },
              ],
              tool_choice: { type: "web_search" },
            },
            signal,
            this.oauth.request(source.id),
          );
          if (!usedWebSearch(response))
            throw new ProviderError("oauthSearchUnverified");
          controller.signal.throwIfAborted();
          this.oauth.recordSearch(source.id, {
            model: source.model,
            settingsKey: searchSettingsKey(source),
            checkedAt: Date.now(),
          });
          return this.oauth.status(source.id);
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          throw new ProviderError(
            controller.signal.aborted
              ? "oauthCancelled"
              : signal.aborted
                ? "requestTimeout"
                : "oauthUnavailable",
          );
        } finally {
          this.probes.delete(source.id);
        }
      }
      case "tmdb-credentials": {
        const token = z
          .string()
          .trim()
          .max(8192)
          .refine((v) => !/[\r\n\0]/.test(v))
          .parse(value);
        settings.recognition.tmdbConfigured = !!token;
        if (!token && settings.recognition.defaultSourceId === "tmdb")
          settings.recognition.defaultSourceId = "bangumi";
        this.store.setConfigs({
          "source:tmdb:key": token ? this.protect(token) : "",
          settings: JSON.stringify(settings),
        });
        return;
      }
      case "recognition-preferences": {
        const patch = z
          .object({
            automatic: z.boolean().optional(),
            parser: z.enum(["release", "anitomy"]).optional(),
            defaultSourceId: id.optional(),
            aiPrompt: promptSchema.optional(),
          })
          .strict()
          .parse(value);
        if (
          patch.defaultSourceId &&
          ![
            "filename",
            "tmdb",
            "bangumi",
            ...settings.recognition.sources.map((s) => s.id),
          ].includes(patch.defaultSourceId)
        )
          throw new ProviderError("invalidInput");
        if (
          patch.defaultSourceId === "tmdb" &&
          !settings.recognition.tmdbConfigured
        )
          throw new ProviderError("tmdbKeyRequired");
        settings.recognition = { ...settings.recognition, ...patch };
        this.save(settings);
        return;
      }
      case "source-models":
      case "save-source": {
        const input = sourceInputSchema.parse(value),
          source = input.source;
        const previous = settings.recognition.sources.find(
          (s) => s.id === source.id,
        );
        const identity = this.savedSource(source.id);
        if (identity && identity.provider !== source.provider)
          throw new ProviderError("invalidInput");
        if (previous && previous.provider !== source.provider)
          throw new ProviderError("invalidInput");
        if (["gemini-oauth", "claude-code"].includes(source.provider)) {
          if (input.apiKey || input.searchKey)
            throw new ProviderError("invalidInput");
          if (type === "source-models") return this.accounts.models(source);
          const { record, models } = this.accounts.prepareSave(source);
          const current = this.snapshot();
          const saved: CustomSource = {
            ...source,
            hasKey: false,
            hasSearchKey: false,
            models,
          };
          current.recognition.sources = previous
            ? current.recognition.sources.map((s) =>
                s.id === source.id ? saved : s,
              )
            : [...current.recognition.sources, saved];
          this.syncLegacyConnection(current, saved);
          this.store.setConfigs({
            [`source:${source.id}:account`]: this.protect(
              JSON.stringify(record),
            ),
            settings: JSON.stringify(current),
          });
          this.accounts.committed(source.id);
          return;
        }
        if (input.oauthClientSecret) throw new ProviderError("invalidInput");
        if (source.provider === "openai-oauth") {
          if (input.apiKey || input.searchKey)
            throw new ProviderError("invalidInput");
          if (type === "source-models") {
            const models = await discoverModels(
              source,
              "oauth-managed",
              this.oauth.request(source.id),
            );
            this.oauthCatalogs.set(source.id, models);
            return models;
          }
          const models = this.oauthModel(source);
          const current = this.snapshot();
          const saved: CustomSource = {
            ...source,
            hasKey: false,
            hasSearchKey: false,
            models,
          };
          current.recognition.sources = previous
            ? current.recognition.sources.map((s) =>
                s.id === source.id ? saved : s,
              )
            : [...current.recognition.sources, saved];
          this.syncLegacyConnection(current, saved);
          this.store.setConfigs({
            ...this.oauthProfiles.prepareCommit(source.id),
            settings: JSON.stringify(current),
          });
          this.oauthProfiles.committed(source.id);
          return;
        }
        const sameEndpoint =
          previous &&
          previous.endpoint === source.endpoint &&
          previous.auth === source.auth;
        // Retained credentials are scoped to the original provider/endpoint and auth scheme.
        const key =
          input.apiKey?.trim() ||
          (sameEndpoint ? this.secret(source.id, "key") : "");
        const searchKey =
          input.searchKey?.trim() ||
          (previous?.searchEndpoint === source.searchEndpoint
            ? this.secret(source.id, "search")
            : "");
        if (
          (source.provider !== "openai-compatible" || source.auth !== "none") &&
          !key
        )
          throw new ProviderError("keyRequired");
        const fingerprint = this.fingerprint(source, key);
        if (type === "source-models") {
          const models = await discoverModels(
            source,
            key,
            this.dependencies.request,
          );
          if (this.catalogs.size > 100) this.catalogs.clear();
          this.catalogs.set(fingerprint, models);
          return models;
        }
        if (source.searchMode === "external" && !searchKey)
          throw new ProviderError("searchKeyRequired");
        const previousFingerprint = previous
          ? this.fingerprint(
              sourceConfig(previous),
              this.secret(previous.id, "key"),
            )
          : null;
        const models =
          this.catalogs.get(fingerprint) ||
          (fingerprint === previousFingerprint ? previous!.models : []);
        const model = models.find((m) => m.id === source.model);
        if (!model) throw new ProviderError("chooseModel");
        if (model.outputLimit && source.maxOutputTokens > model.outputLimit)
          throw new ProviderError("outputLimitExceeded");
        const encryptedKey = key ? this.protect(key) : "",
          encryptedSearch = searchKey ? this.protect(searchKey) : "";
        const saved: CustomSource = {
          ...source,
          hasKey: !!key,
          hasSearchKey: !!searchKey,
          models,
        };
        settings.recognition.sources = previous
          ? settings.recognition.sources.map((s) =>
              s.id === source.id ? saved : s,
            )
          : [...settings.recognition.sources, saved];
        this.syncLegacyConnection(settings, saved);
        this.store.setConfigs({
          [`source:${source.id}:key`]: encryptedKey,
          [`source:${source.id}:search`]: encryptedSearch,
          settings: JSON.stringify(settings),
        });
        return;
      }
      case "remove-source": {
        const sourceId = id.parse(value);
        if (
          settings.recognition.sources.some(
            (s) => s.id === sourceId && s.connectionId,
          )
        ) {
          settings.recognition.sources = settings.recognition.sources.filter(
            (s) => s.id !== sourceId,
          );
          if (settings.recognition.defaultSourceId === sourceId)
            settings.recognition.defaultSourceId = "bangumi";
          this.store.setConfigs({
            [`source:${sourceId}:search`]: "",
            settings: JSON.stringify(settings),
          });
          return { revoked: true };
        }
        let revoked = true;
        if (
          ["gemini-oauth", "claude-code"].includes(
            this.savedSource(sourceId)?.provider || "",
          )
        )
          revoked = (await this.accounts.logout(sourceId)).revoked;
        if (this.savedSource(sourceId)?.provider === "openai-oauth") {
          this.probes.get(sourceId)?.abort();
          this.oauthCatalogs.delete(sourceId);
          if (!this.oauthProfiles.hasPeers(sourceId))
            revoked = await this.oauth.signOut(sourceId);
          this.oauthProfiles.release(sourceId);
        }
        const current = this.snapshot();
        current.recognition.sources = current.recognition.sources.filter(
          (s) => s.id !== sourceId,
        );
        if (current.recognition.defaultSourceId === sourceId)
          current.recognition.defaultSourceId = "bangumi";
        this.store.setConfigs({
          [`source:${sourceId}:key`]: "",
          [`source:${sourceId}:search`]: "",
          [`source:${sourceId}:oauth`]: "",
          [`source:${sourceId}:account`]: "",
          settings: JSON.stringify(current),
        });
        return { revoked };
      }
      default:
        throw new ProviderError("invalidInput");
    }
  }
  private oauthModel(source: SourceConfig): ModelOption[] {
    const account = this.oauth.status(source.id);
    if (account.status !== "connected")
      throw new ProviderError(
        account.status === "planRequired"
          ? "oauthPlanRequired"
          : "oauthSignInRequired",
      );
    const models =
      this.oauthCatalogs.get(source.id) ||
      this.savedSource(source.id)?.models ||
      [];
    if (!models.some((model) => model.id === source.model))
      throw new ProviderError("chooseModel");
    return models;
  }
}
