import { net, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LibraryStore } from "./store";
import {
  defaultSettings,
  sourceInputSchema,
  sourceConfig,
  promptSchema,
  type SettingsState,
  type ModelOption,
  type SourceConfig,
  type CustomSource,
} from "../shared/settings";
import { discoverModels } from "../providers/models";
import { ProviderError } from "../providers/provider";
import { id } from "../shared/validation";

export class SettingsService {
  private catalogs = new Map<string, ModelOption[]>();
  constructor(private store: LibraryStore) {}
  snapshot(): SettingsState {
    const config = this.store.config("settings");
    const result = config
      ? JSON.parse(config)
      : defaultSettings(this.store.preferences().language);
    if (result.recognition.parser === "guessit")
      result.recognition.parser = "release";
    if (result.recognition.parser === "anitopy")
      result.recognition.parser = "anitomy";
    return result;
  }
  save(value: SettingsState) {
    this.store.setConfig("settings", JSON.stringify(value));
  }
  private protect(value: string): string {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new ProviderError("secureStorageUnavailable");
    return safeStorage.encryptString(value).toString("base64");
  }
  secret(id: string, kind: "key" | "search"): string {
    const value = this.store.config(`source:${id}:${kind}`);
    if (!value) return "";
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
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
  async request(type: string, value: unknown) {
    const settings = this.snapshot();
    switch (type) {
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
        if (previous && previous.provider !== source.provider)
          throw new ProviderError("invalidInput");
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
            net.fetch.bind(net) as typeof fetch,
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
        this.store.setConfigs({
          [`source:${source.id}:key`]: encryptedKey,
          [`source:${source.id}:search`]: encryptedSearch,
          settings: JSON.stringify(settings),
        });
        return;
      }
      case "remove-source": {
        const sourceId = id.parse(value);
        settings.recognition.sources = settings.recognition.sources.filter(
          (s) => s.id !== sourceId,
        );
        if (settings.recognition.defaultSourceId === sourceId)
          settings.recognition.defaultSourceId = "bangumi";
        this.store.setConfigs({
          [`source:${sourceId}:key`]: "",
          [`source:${sourceId}:search`]: "",
          settings: JSON.stringify(settings),
        });
        return;
      }
      default:
        throw new ProviderError("invalidInput");
    }
  }
}
