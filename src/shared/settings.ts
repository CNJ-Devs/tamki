import { z } from "zod";

export const providers = [
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    protocol: "chat-completions",
    auth: "bearer",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    endpoint: "https://api.anthropic.com",
    protocol: "anthropic-messages",
    auth: "x-api-key",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com",
    protocol: "gemini-generate-content",
    auth: "x-goog-api-key",
  },
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    protocol: "responses",
    auth: "bearer",
  },
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    endpoint: "",
    protocol: "chat-completions",
    auth: "bearer",
  },
] as const;
export const promptVariables = ["title", "files", "scope"] as const;
export const defaultPrompts = {
  en: "Follow {{scope}} and use {{title}} and {{files}} to identify the requested information.\nPrefer reliable sources for names and synopses. Leave uncertain information empty.",
  zh: "请按照“{{scope}}”，结合“{{title}}”与“{{files}}”，补全对应的信息。\n优先采用可靠来源的中文名称与简介；无法确认的信息留空。",
};
export const promptSchema = z
  .string()
  .trim()
  .min(1)
  .max(16000)
  .refine((value) =>
    [...value.matchAll(/\{\{(.*?)\}\}/g)].every((match) =>
      promptVariables.includes(match[1] as (typeof promptVariables)[number]),
    ),
  );
export const endpointSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
      );
    } catch {
      return false;
    }
  });
const key = z
  .string()
  .max(8192)
  .refine((v) => !/[\r\n\0]/.test(v));
export const sourceSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(100),
    provider: z.enum([
      "deepseek",
      "anthropic",
      "gemini",
      "openai",
      "openai-compatible",
    ]),
    protocol: z.enum([
      "chat-completions",
      "responses",
      "anthropic-messages",
      "gemini-generate-content",
    ]),
    endpoint: z.string().max(2048),
    auth: z.enum(["bearer", "x-api-key", "none"]),
    model: z.string().max(200),
    searchMode: z.enum(["none", "native", "external"]),
    searchEndpoint: endpointSchema,
    resultCount: z.number().int().min(1).max(50),
    readPages: z.boolean(),
    maxSearches: z.number().int().min(1).max(20),
    maxPages: z.number().int().min(1).max(20),
    liveAccess: z.boolean(),
    domainMode: z.enum(["all", "allow", "block"]),
    domains: z
      .array(
        z
          .string()
          .max(253)
          .regex(/^([a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}$/i),
      )
      .max(100),
    country: z.string().regex(/^([a-z]{2})?$/i),
    timeoutSeconds: z.number().int().min(5).max(600),
    maxOutputTokens: z.number().int().min(128).max(131072),
    project: z
      .string()
      .max(200)
      .regex(/^[\w-]*$/),
    organization: z
      .string()
      .max(200)
      .regex(/^[\w-]*$/),
  })
  .strict()
  .superRefine((source, ctx) => {
    const provider = providers.find((p) => p.id === source.provider)!;
    const fail = (path: string) =>
      ctx.addIssue({ code: "custom", path: [path], message: "invalidInput" });
    if (source.provider === "openai-compatible") {
      if (!endpointSchema.safeParse(source.endpoint).success) fail("endpoint");
      if (!["chat-completions", "responses"].includes(source.protocol))
        fail("protocol");
      if (source.searchMode === "native" && source.protocol !== "responses")
        fail("searchMode");
    } else {
      if (source.endpoint !== provider.endpoint) fail("endpoint");
      if (source.protocol !== provider.protocol) fail("protocol");
      if (source.searchMode === "external") fail("searchMode");
    }
    if (source.domainMode !== "all" && !source.domains.length) fail("domains");
  });
export type SourceConfig = z.infer<typeof sourceSchema>;
export interface ModelOption {
  id: string;
  name: string;
  outputLimit?: number;
}
export interface CustomSource extends SourceConfig {
  hasKey: boolean;
  hasSearchKey: boolean;
  models: ModelOption[];
}
export const sourceInputSchema = z
  .object({
    source: sourceSchema,
    apiKey: key.optional(),
    searchKey: key.optional(),
  })
  .strict();
export function newSource(
  provider: SourceConfig["provider"] = "deepseek",
): SourceConfig {
  const p = providers.find((item) => item.id === provider)!;
  return {
    id: crypto.randomUUID(),
    name: p.name,
    provider,
    protocol: p.protocol,
    endpoint: p.endpoint,
    auth: "bearer",
    model: "",
    searchMode: provider === "openai-compatible" ? "none" : "native",
    searchEndpoint: "https://api.deepseek.com",
    resultCount: 5,
    readPages: true,
    maxSearches: 3,
    maxPages: 5,
    liveAccess: true,
    domainMode: "all",
    domains: [],
    country: "",
    timeoutSeconds: 300,
    maxOutputTokens: 32768,
    project: "",
    organization: "",
  };
}
export const targetSchema = z
  .object({
    connectionId: z.string().min(1).max(128),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !v.includes("\0")),
  })
  .strict();
export type SaveTarget = z.infer<typeof targetSchema>;
export const saveRuleSchema = z
  .object({
    mode: z.enum(["fixed", "last"]),
    fixed: targetSchema.nullable(),
    last: targetSchema.nullable(),
  })
  .strict();
export type SaveRule = z.infer<typeof saveRuleSchema>;
export interface SettingsState {
  downloads: Record<"series" | "video", SaveRule>;
  recognition: {
    automatic?: boolean;
    parser: "release" | "anitomy";
    defaultSourceId: string;
    aiPrompt: string;
    sources: CustomSource[];
    tmdbConfigured?: boolean;
  };
}
export function defaultSettings(language: "en" | "zh"): SettingsState {
  return {
    downloads: {
      series: { mode: "last", fixed: null, last: null },
      video: { mode: "last", fixed: null, last: null },
    },
    recognition: {
      automatic: true,
      parser: "release",
      defaultSourceId: "bangumi",
      aiPrompt: defaultPrompts[language],
      sources: [],
    },
  };
}
export function sourceConfig(source: CustomSource): SourceConfig {
  const { hasKey, hasSearchKey, models, ...config } = source;
  return config;
}
