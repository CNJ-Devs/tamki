import type {
  SourceConfig,
  CustomSource,
  OAuthAccount,
  ModelOption,
} from "../shared/settings";
import { searchSettingsKey } from "../shared/settings";
import { GoogleOAuth, type GoogleRecord } from "../providers/google-oauth";
import { ClaudeCode, type RuntimeRunner } from "../providers/claude-code";
import { discoverModels } from "../providers/models";
import {
  aiRecognition,
  aiRecognitionBatches,
  aiStructured,
  type StructuredTask,
} from "../providers/ai-recognition";
import type { RecognitionInput } from "../shared/recognition";
import { ProviderError } from "../providers/provider";

type Record =
  | { provider: "gemini-oauth"; google: GoogleRecord }
  | { provider: "claude-code"; runtimePath: string; account: OAuthAccount };
interface Options {
  read(id: string): Record | undefined;
  write(id: string, record: Record | undefined): void;
  saved(id: string): CustomSource | undefined;
  secure(): void;
  root: string;
  request: typeof fetch;
  openBrowser(url: string): Promise<void>;
  callbackText: { success: string; failed: string };
  runner?: RuntimeRunner;
  resolveRuntime?: (path: string) => Promise<string>;
}
export class AccountSources {
  readonly google: GoogleOAuth;
  readonly claude: ClaudeCode;
  private drafts = new Map<string, Record>();
  private sources = new Map<string, SourceConfig>();
  private catalogs = new Map<string, { key: string; models: ModelOption[] }>();
  private probes = new Map<string, AbortController>();
  private active = new Set<string>();
  private closed = false;
  constructor(private options: Options) {
    this.google = new GoogleOAuth({
      ...options,
      read: (id) => {
        const r = this.read(id);
        return r?.provider === "gemini-oauth" ? r.google : undefined;
      },
      write: (id, google) =>
        this.write(
          id,
          google ? { provider: "gemini-oauth", google } : undefined,
        ),
    });
    this.claude = new ClaudeCode({
      root: options.root,
      runner: options.runner,
      resolve: options.resolveRuntime,
    });
  }
  private read(id: string) {
    return this.drafts.get(id) || this.options.read(id);
  }
  private write(id: string, record: Record | undefined) {
    if (this.closed) return;
    if (this.options.saved(id)) this.options.write(id, record);
    else if (record) this.drafts.set(id, record);
    else this.drafts.delete(id);
  }
  private validate(source: SourceConfig) {
    if (this.closed) throw new ProviderError("oauthCancelled");
    if (!["gemini-oauth", "claude-code"].includes(source.provider))
      throw new ProviderError("invalidInput");
    const saved = this.options.saved(source.id),
      remembered = this.sources.get(source.id);
    if (
      (saved && saved.provider !== source.provider) ||
      (remembered && remembered.provider !== source.provider)
    )
      throw new ProviderError("invalidInput");
    if (
      !saved &&
      !remembered &&
      [...this.sources.keys()].filter((id) => !this.options.saved(id)).length >=
        16
    )
      throw new ProviderError("oauthBusy");
    this.sources.set(source.id, source);
    const record = this.read(source.id);
    if (
      record?.provider === "gemini-oauth" &&
      record.google.clientId !== source.oauthClientId
    )
      throw new ProviderError("googleClientChanged");
    if (
      record?.provider === "claude-code" &&
      record.runtimePath !== source.runtimePath
    )
      throw new ProviderError("claudeRuntimeChanged");
  }
  status(source: SourceConfig): OAuthAccount {
    const record = this.read(source.id);
    return source.provider === "gemini-oauth"
      ? this.google.status(source.id)
      : record?.provider === "claude-code"
        ? record.account
        : { email: "", status: "signedOut" };
  }
  private key(source: SourceConfig) {
    return JSON.stringify([
      source.provider,
      source.project,
      source.oauthClientId,
      source.runtimePath,
      this.status(source).email,
    ]);
  }
  async login(source: SourceConfig, clientSecret?: string) {
    this.validate(source);
    if (this.active.has(source.id)) throw new ProviderError("oauthBusy");
    this.options.secure();
    this.active.add(source.id);
    this.probes.get(source.id)?.abort();
    this.catalogs.delete(source.id);
    try {
      const account =
        source.provider === "gemini-oauth"
          ? await this.google.signIn(source, clientSecret)
          : await this.claude.signIn(source);
      if (source.provider === "claude-code")
        this.write(source.id, {
          provider: "claude-code",
          runtimePath: source.runtimePath,
          account,
        });
      return { account, firstUse: false };
    } finally {
      this.active.delete(source.id);
    }
  }
  async refreshStatus(source: SourceConfig) {
    this.validate(source);
    if (source.provider === "claude-code")
      this.write(source.id, {
        provider: "claude-code",
        runtimePath: source.runtimePath,
        account: await this.claude.status(source),
      });
    return this.status(source);
  }
  async projects(source: SourceConfig) {
    this.validate(source);
    if (source.provider !== "gemini-oauth")
      throw new ProviderError("invalidInput");
    return this.google.projects(source);
  }
  async models(source: SourceConfig) {
    this.validate(source);
    const models =
      source.provider === "gemini-oauth"
        ? await discoverModels(
            source,
            "oauth-managed",
            this.google.request(source),
          )
        : await this.claude.models(source);
    this.catalogs.set(source.id, { key: this.key(source), models });
    return models;
  }
  prepareSave(source: SourceConfig) {
    this.validate(source);
    if (this.status(source).status !== "connected")
      throw new ProviderError("accountSignInRequired");
    if (source.provider === "gemini-oauth" && !source.project)
      throw new ProviderError("googleProjectRequired");
    const cached = this.catalogs.get(source.id),
      saved = this.options.saved(source.id);
    const models =
      cached?.key === this.key(source)
        ? cached.models
        : saved && this.key(saved) === this.key(source)
          ? saved.models
          : [];
    const model = models.find((m) => m.id === source.model);
    if (!model) throw new ProviderError("chooseModel");
    if (model.outputLimit && source.maxOutputTokens > model.outputLimit)
      throw new ProviderError("outputLimitExceeded");
    return { models, record: this.read(source.id)! };
  }
  prepareConnectionSave(source: SourceConfig) {
    this.validate(source);
    if (this.status(source).status !== "connected")
      throw new ProviderError("accountSignInRequired");
    if (source.provider === "gemini-oauth" && !source.project)
      throw new ProviderError("googleProjectRequired");
    return this.read(source.id)!;
  }
  committed(id: string) {
    this.drafts.delete(id);
    this.sources.delete(id);
  }
  async logout(id: string, discard = false) {
    this.google.cancel(id);
    this.claude.cancel(id);
    this.probes.get(id)?.abort();
    this.catalogs.delete(id);
    // A draft closure cancels but does not log an already saved source out.
    if (discard && this.options.saved(id)) {
      this.sources.delete(id);
      return { revoked: true };
    }
    const source = this.sources.get(id) || this.options.saved(id);
    let revoked = true;
    if (source?.provider === "claude-code")
      revoked = await this.claude.signOut(source);
    else if (source?.provider === "gemini-oauth")
      revoked = await this.google.signOut(id);
    this.write(id, undefined);
    this.sources.delete(id);
    return {
      revoked,
      account: { email: "", status: "signedOut" } as OAuthAccount,
    };
  }
  async recognize(
    source: SourceConfig,
    input: RecognitionInput,
    template: string,
    signal: AbortSignal,
  ) {
    this.validate(source);
    if (this.status(source).status !== "connected")
      throw new ProviderError("accountSignInRequired");
    return aiRecognitionBatches(
      source,
      "oauth-managed",
      "",
      input,
      template,
      signal,
      source.provider === "gemini-oauth"
        ? this.google.request(source)
        : this.options.request,
      source.provider === "claude-code"
        ? (part) => this.claude.recognize(source, part, template, signal)
        : undefined,
    );
  }
  async structured(
    source: SourceConfig,
    task: StructuredTask,
    signal: AbortSignal,
  ) {
    this.validate(source);
    if (this.status(source).status !== "connected")
      throw new ProviderError("accountSignInRequired");
    return source.provider === "claude-code"
      ? this.claude.structured(source, task, signal)
      : aiStructured(
          source,
          "oauth-managed",
          "",
          task,
          signal,
          this.google.request(source),
        );
  }
  async search(source: SourceConfig) {
    this.prepareSave(source);
    if (source.searchMode !== "native") throw new ProviderError("invalidInput");
    if (this.probes.has(source.id) || this.active.has(source.id))
      throw new ProviderError("oauthBusy");
    const controller = new AbortController();
    this.probes.set(source.id, controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.min(source.timeoutSeconds, 90) * 1000),
    ]);
    const recordSearch = (search: OAuthAccount["search"]) => {
      if (source.provider === "gemini-oauth")
        this.google.recordSearch(source.id, search);
      else {
        const record = this.read(source.id);
        if (record?.provider === "claude-code")
          this.write(source.id, {
            ...record,
            account: { ...record.account, search },
          });
      }
    };
    recordSearch(undefined);
    try {
      const input: RecognitionInput = {
        title: "Spirited Away (2001)",
        scope: "work",
        files: [],
      };
      const prompt =
        "Use web search to verify the film title and synopsis from a reliable source. Unknown fields must be null.";
      const result =
        source.provider === "claude-code"
          ? await this.claude.recognize(source, input, prompt, signal)
          : await aiRecognition(
              source,
              "oauth-managed",
              "",
              input,
              prompt,
              signal,
              this.google.request(source),
            );
      if (result.kind !== "result" || !result.citations.length)
        throw new ProviderError("oauthSearchUnverified");
      signal.throwIfAborted();
      recordSearch({
        model: source.model,
        settingsKey: searchSettingsKey(source),
        checkedAt: Date.now(),
      });
      return this.status(source);
    } catch (e) {
      if (signal.aborted)
        throw new ProviderError(
          controller.signal.aborted ? "oauthCancelled" : "requestTimeout",
        );
      throw e;
    } finally {
      this.probes.delete(source.id);
    }
  }
  close() {
    this.closed = true;
    this.google.close();
    this.claude.close();
    for (const c of this.probes.values()) c.abort();
    this.drafts.clear();
    this.sources.clear();
  }
}
