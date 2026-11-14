import { ProviderError } from "./provider";
/** Bound bodies and refuse redirects, including for requests containing secrets. */
export async function metadataJSON(
  url: string | URL,
  init: RequestInit,
  request: typeof fetch = fetch,
): Promise<any> {
  const response = await request(url, {
    ...init,
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "CNJ-Devs/Tamki/0.1.0 (https://github.com/CNJ-Devs/tamki)",
      ...init.headers,
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError(
      response.status === 401 || response.status === 403
        ? "sourceUnauthorized"
        : response.status === 429
          ? "sourceRateLimited"
          : "recognitionFailed",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("recognitionFailed");
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 8 * 1024 * 1024)
        throw new ProviderError("recognitionTooLarge");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
