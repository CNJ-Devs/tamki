import { z } from "zod";
import {
  providers,
  type SourceConfig,
  type ModelOption,
} from "../shared/settings";
import { ProviderError } from "./provider";

// Discovery never sends keys to redirects or returns raw upstream errors.
export async function discoverModels(
  source: SourceConfig,
  key: string,
  request: typeof fetch = fetch,
): Promise<ModelOption[]> {
  const provider = providers.find((p) => p.id === source.provider)!;
  const base =
    source.provider === "openai-compatible"
      ? source.endpoint
      : provider.endpoint;
  const auth =
    source.provider === "openai-compatible" ? source.auth : provider.auth;
  if (auth !== "none" && !key) throw new ProviderError("keyRequired");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth === "bearer") headers.Authorization = `Bearer ${key}`;
  else if (auth !== "none") headers[auth] = key;
  if (source.provider === "anthropic")
    headers["anthropic-version"] = "2023-06-01";
  if (source.provider === "openai") {
    if (source.project) headers["OpenAI-Project"] = source.project;
    if (source.organization)
      headers["OpenAI-Organization"] = source.organization;
  }
  const suffix =
    source.provider === "anthropic"
      ? "/v1/models"
      : source.provider === "gemini"
        ? "/v1beta/models"
        : "/models";
  let cursor = "";
  const seen = new Set<string>();
  const models = new Map<string, ModelOption>();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(source.timeoutSeconds, 60) * 1000,
  );
  try {
    for (let page = 0; page < 50; page++) {
      const url = new URL(base.replace(/\/$/, "") + suffix);
      if (source.provider === "gemini") {
        url.searchParams.set("pageSize", "1000");
        if (cursor) url.searchParams.set("pageToken", cursor);
      }
      if (source.provider === "anthropic") {
        url.searchParams.set("limit", "1000");
        if (cursor) url.searchParams.set("after_id", cursor);
      }
      const response = await request(url, {
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(
          response.status === 401 || response.status === 403
            ? "sourceUnauthorized"
            : "modelListFailed",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError("modelListFailed");
      let total = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > 4 * 1024 * 1024)
            throw new ProviderError("modelListFailed");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (source.provider === "gemini") {
        const result = z
          .object({
            models: z.array(
              z.object({
                name: z.string().min(1).max(200),
                displayName: z.string().max(300).optional(),
                supportedGenerationMethods: z.array(z.string()),
                outputTokenLimit: z.number().int().positive().optional(),
              }),
            ),
            nextPageToken: z.string().max(2048).optional(),
          })
          .parse(data);
        for (const m of result.models)
          if (m.supportedGenerationMethods.includes("generateContent")) {
            const id = m.name.replace(/^models\//, "");
            models.set(id, {
              id,
              name: m.displayName || id,
              outputLimit: m.outputTokenLimit,
            });
          }
        cursor = result.nextPageToken || "";
      } else {
        const result = z
          .object({
            data: z.array(
              z.object({
                id: z.string().min(1).max(200),
                display_name: z.string().max(300).optional(),
                name: z.string().max(300).optional(),
                max_output_tokens: z.number().int().positive().optional(),
              }),
            ),
            has_more: z.boolean().optional(),
            last_id: z.string().max(2048).optional(),
          })
          .parse(data);
        for (const m of result.data)
          models.set(m.id, {
            id: m.id,
            name: m.display_name || m.name || m.id,
            outputLimit: m.max_output_tokens,
          });
        cursor =
          source.provider === "anthropic" && result.has_more
            ? result.last_id || ""
            : "";
        if (result.has_more && !cursor)
          throw new ProviderError("modelListFailed");
      }
      if (!cursor)
        return [...models.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      if (seen.has(cursor)) throw new ProviderError("modelListFailed");
      seen.add(cursor);
    }
    throw new ProviderError("modelListFailed");
  } catch (error) {
    throw error instanceof ProviderError
      ? error
      : new ProviderError(
          controller.signal.aborted ? "requestTimeout" : "modelListFailed",
        );
  } finally {
    clearTimeout(timer);
  }
}
