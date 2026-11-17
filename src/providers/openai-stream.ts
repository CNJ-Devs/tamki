import { logEvent } from "../diagnostics";
import { ProviderError } from "./provider";

export function exceedsContext(data: any): boolean {
  const error = data?.error || data;
  return (
    [
      "context_length_exceeded",
      "context_window_exceeded",
      "input_too_long",
      "prompt_too_long",
    ].includes(error?.code) ||
    (typeof error?.message === "string" &&
      /(?:prompt is too long|exceeds? (?:the )?(?:maximum )?(?:context length|context window|input token limit)|input token count.*exceeds|maximum context length.*(?:exceed|requested))/i.test(
        error.message,
      ))
  );
}

/** Never surface upstream messages: they can contain prompts or credentials. */
export function openAIError(data: any, status = 0): ProviderError {
  const code = data?.error?.code || data?.code;
  if (exceedsContext(data)) return new ProviderError("recognitionContextLimit");
  if (code === "subscription_sharing_usage_limit_exceeded")
    return new ProviderError("oauthUsageLimit");
  if (
    [
      "subscription_sharing_usage_unavailable",
      "subscription_sharing_user_unavailable",
    ].includes(code)
  )
    return new ProviderError("oauthUnavailable");
  if (code === "subscription_sharing_unsupported_capability")
    return new ProviderError("oauthCapabilityUnsupported");
  if (status === 401 || code === "subscription_sharing_invalid_user")
    return new ProviderError("oauthSignInRequired");
  if (
    status === 403 ||
    [
      "subscription_sharing_user_not_eligible",
      "chatpass_v2_scope_not_authorized",
      "chatpass_v2_invalid_authorization_context",
    ].includes(code)
  )
    return new ProviderError("oauthRestricted");
  if (status === 429) return new ProviderError("sourceRateLimited");
  return new ProviderError(
    status >= 500 ? "oauthUnavailable" : "recognitionFailed",
  );
}

export async function boundedJSON(
  response: Response,
  limit = 1024 * 1024,
): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("recognitionFailed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new ProviderError("recognitionTooLarge");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Only a completed terminal event is success, including after text has arrived. */
export async function openAIStream(
  body: Record<string, unknown>,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<any> {
  const started = performance.now();
  let firstEventMs: number | undefined, firstTextMs: number | undefined;
  const searchStarts = new Map<string, number>();
  const response = await request("https://api.openai.com/v1/responses", {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ ...body, store: false, stream: true }),
  });
  if (!response.ok) {
    const data = await boundedJSON(response).catch(() => null);
    throw openAIError(data, response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("recognitionFailed");
  const decoder = new TextDecoder();
  let buffer = "",
    eventData: string[] = [],
    total = 0,
    eventCount = 0;
  // Output completion may arrive before the terminal response. Keep it within
  // this request; final failure/incomplete events must still reject the result.
  const items = new Map<string, Record<string, any>>();
  const consume = (line: string): any => {
    if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
    if (line || !eventData.length) return;
    const data = eventData.join("\n");
    eventData = [];
    if (data === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(data);
      eventCount++;
      firstEventMs ??= Math.round(performance.now() - started);
      if (event.type === "response.output_text.delta")
        firstTextMs ??= Math.round(performance.now() - started);
      if (
        event.type === "response.web_search_call.in_progress" &&
        typeof event.item_id === "string"
      )
        searchStarts.set(event.item_id, performance.now());
      if (event.type === "response.web_search_call.completed") {
        const start = searchStarts.get(event.item_id);
        logEvent("ai.search.completed", {
          durationMs:
            start === undefined
              ? undefined
              : Math.round(performance.now() - start),
        });
      }
    } catch {
      logEvent(
        "ai.stream.invalid-event",
        { bytes: total, eventCount },
        "error",
      );
      throw new ProviderError("recognitionInvalid");
    }
    if (event.type === "error" || event.type === "response.failed")
      throw openAIError(event.response || event);
    if (event.type === "response.incomplete")
      throw new ProviderError(
        event.response?.incomplete_details?.reason === "max_output_tokens"
          ? "recognitionTruncated"
          : "recognitionFailed",
      );
    if (
      ["response.output_item.added", "response.output_item.done"].includes(
        event.type,
      ) &&
      (event.item?.type === "web_search_call" ||
        (event.type === "response.output_item.done" &&
          event.item?.type === "message" &&
          event.item.status === "completed")) &&
      typeof event.item.id === "string"
    ) {
      items.set(event.item.id, {
        ...items.get(event.item.id),
        ...event.item,
      });
    }
    if (
      event.type === "response.web_search_call.completed" &&
      typeof event.item_id === "string"
    ) {
      items.set(event.item_id, {
        ...items.get(event.item_id),
        id: event.item_id,
        type: "web_search_call",
        status: "completed",
      });
    }
    if (event.type === "response.completed") {
      if (
        event.response?.status !== "completed" ||
        (event.response.output !== undefined &&
          !Array.isArray(event.response.output))
      ) {
        logEvent(
          "ai.stream.invalid-final",
          { bytes: total, eventCount },
          "error",
        );
        throw new ProviderError("recognitionInvalid");
      }
      const seen = new Set<string>();
      let recoveredItems = 0;
      const output = (event.response.output || []).map((item: any) => {
        if (typeof item?.id !== "string") return item;
        seen.add(item.id);
        // Explicit terminal status wins, including failed/incomplete searches.
        return item.type === "web_search_call"
          ? { ...items.get(item.id), ...item }
          : item;
      });
      for (const [id, item] of items)
        if (!seen.has(id) && item.status === "completed") {
          output.push(item);
          recoveredItems++;
        }
      logEvent("ai.stream.completed", {
        durationMs: Math.round(performance.now() - started),
        firstEventMs,
        firstTextMs,
        inputTokens: event.response.usage?.input_tokens,
        outputTokens: event.response.usage?.output_tokens,
        reasoningTokens:
          event.response.usage?.output_tokens_details?.reasoning_tokens,
        cachedTokens: event.response.usage?.input_tokens_details?.cached_tokens,
        bytes: total,
        eventCount,
        terminalItems: event.response.output?.length || 0,
        recoveredItems,
        messageItems: output.filter((i: any) => i.type === "message").length,
        searchItems: output.filter((i: any) => i.type === "web_search_call")
          .length,
      });
      return { ...event.response, output };
    }
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 16 * 1024 * 1024)
        throw new ProviderError("recognitionTooLarge");
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        const result = consume(line);
        if (result) return result;
      }
    }
    // An event may end at EOF, without the optional final blank line.
    buffer += decoder.decode();
    if (buffer) {
      const result = consume(buffer.replace(/\r$/, ""));
      if (result) return result;
    }
    const result = consume("");
    if (result) return result;
    throw new ProviderError("oauthStreamInterrupted");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function usedWebSearch(response: any): boolean {
  return (
    response?.status === "completed" &&
    Array.isArray(response.output) &&
    response.output.some(
      (item: any) =>
        // action is optional in the Responses contract. Search, open_page and
        // find_in_page are all hosted web operations; text citations alone are not.
        item?.type === "web_search_call" && item.status === "completed",
    )
  );
}
