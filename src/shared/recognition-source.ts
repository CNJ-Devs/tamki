import { z } from "zod";
import {
  newSource,
  sourceSchema,
  type CustomSource,
  type SourceConfig,
} from "./settings";
import { connectionConfig, type AIConnectionConfig } from "./ai-connections";

// Renderer requests contain feature options and a saved connection reference.
// Transport and authentication always come from the main process's connection.
const fields = sourceSchema.shape;
export const recognitionSourceSchema = z
  .object({
    id: fields.id,
    name: fields.name,
    connectionId: fields.id,
    model: fields.model,
    searchMode: fields.searchMode,
    searchEndpoint: fields.searchEndpoint,
    resultCount: fields.resultCount,
    readPages: fields.readPages,
    maxSearches: fields.maxSearches,
    maxPages: fields.maxPages,
    liveAccess: fields.liveAccess,
    domainMode: fields.domainMode,
    domains: fields.domains,
    country: fields.country,
    timeoutSeconds: fields.timeoutSeconds,
    maxOutputTokens: fields.maxOutputTokens,
  })
  .strict();
export type RecognitionSourceConfig = z.infer<typeof recognitionSourceSchema>;
export const recognitionSourceInput = z
  .object({
    source: recognitionSourceSchema,
    searchKey: z
      .string()
      .max(8192)
      .refine((v) => !/[\r\n\0]/.test(v))
      .optional(),
  })
  .strict();

export function recognitionSourceConfig(
  source: CustomSource,
): RecognitionSourceConfig {
  const values = { ...source, connectionId: source.connectionId || source.id };
  return Object.fromEntries(
    Object.keys(recognitionSourceSchema.shape).map((key) => [
      key,
      values[key as keyof typeof values],
    ]),
  ) as RecognitionSourceConfig;
}

export function resolveRecognitionSource(
  options: RecognitionSourceConfig,
  connection: AIConnectionConfig,
): SourceConfig {
  const { connectionId, ...feature } = options;
  return sourceSchema.parse({
    ...newSource(connection.provider),
    ...feature,
    ...connectionConfig(connection),
    id: feature.id,
    name: feature.name,
  });
}
