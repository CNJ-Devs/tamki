import { z } from "zod";
import {
  newSource,
  providers,
  sourceSchema,
  type CustomSource,
  type ModelOption,
  type OAuthAccount,
  type SourceConfig,
} from "./settings";

// Only transport, identity and billing belong to a connection. Inference options
// deliberately stay in the feature configuration that uses it.
const fields = sourceSchema.shape;
export const aiConnectionSchema = z
  .object({
    id: fields.id,
    name: fields.name,
    provider: fields.provider,
    protocol: fields.protocol,
    endpoint: fields.endpoint,
    auth: fields.auth,
    project: fields.project,
    organization: fields.organization,
    oauthClientId: fields.oauthClientId,
    runtimePath: fields.runtimePath,
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = sourceSchema.safeParse({
      ...newSource(value.provider),
      ...value,
      searchMode: "none",
    });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: "invalidInput",
        });
    const provider = providers.find((p) => p.id === value.provider)!;
    const fail = (field: string) =>
      ctx.addIssue({ code: "custom", path: [field], message: "invalidInput" });
    if (value.provider !== "openai-compatible" && value.auth !== provider.auth)
      fail("auth");
    if (value.project && !["openai", "gemini-oauth"].includes(value.provider))
      fail("project");
    if (value.organization && value.provider !== "openai") fail("organization");
  });
export type AIConnectionConfig = z.infer<typeof aiConnectionSchema>;
export interface AIConnection extends AIConnectionConfig {
  hasKey: boolean;
  models: ModelOption[];
  account?: OAuthAccount;
}
const credential = z
  .string()
  .max(8192)
  .refine((v) => !/[\r\n\0]/.test(v));
export const aiConnectionInput = z
  .object({
    connection: aiConnectionSchema,
    apiKey: credential.optional(),
    oauthClientSecret: credential.optional(),
  })
  .strict();

export function connectionConfig(
  value: AIConnectionConfig | SourceConfig,
): AIConnectionConfig {
  const {
    id,
    name,
    provider,
    protocol,
    endpoint,
    auth,
    project,
    organization,
    oauthClientId = "",
    runtimePath = "",
  } = value;
  return {
    id,
    name,
    provider,
    protocol,
    endpoint,
    auth:
      provider === "openai-compatible"
        ? auth
        : providers.find((p) => p.id === provider)!.auth,
    project: ["openai", "gemini-oauth"].includes(provider) ? project : "",
    organization: provider === "openai" ? organization : "",
    oauthClientId,
    runtimePath,
  };
}
export function newAIConnection(
  provider: SourceConfig["provider"] = "openai-oauth",
): AIConnection {
  return {
    ...connectionConfig(newSource(provider)),
    hasKey: false,
    models: [],
  };
}
// Adapt connection-only operations to the providers' transport contract.
export function connectionSource(connection: AIConnectionConfig): SourceConfig {
  return {
    ...newSource(connection.provider),
    ...connection,
    searchMode: "none",
    timeoutSeconds: 300,
  };
}
export function connectionFromSource(source: CustomSource): AIConnection {
  return {
    ...connectionConfig(source),
    hasKey: source.hasKey,
    models: source.models,
  };
}
export function connectionIdentity(value: AIConnectionConfig): string {
  const { id, name, ...identity } = connectionConfig(value);
  return JSON.stringify(identity);
}
