import { nativeImage, type WebContents } from "electron";
import { isWebURL } from "./navigation";
/** Convert bounded same-origin image bytes to PNG; privileged UI never loads remote URLs. */
export async function loadFavicon(
  wc: WebContents,
  urls: string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const page = wc.getURL();
  if (!isWebURL(page)) return;
  for (const value of urls.slice(0, 8)) {
    if (!isWebURL(value) || new URL(value).origin !== new URL(page).origin)
      continue;
    try {
      const response = await wc.session.fetch(value, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      });
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > 262144
      ) {
        await response.body?.cancel();
        continue;
      }
      const reader = response.body?.getReader();
      if (!reader) continue;
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > 262144) break;
          parts.push(chunk);
        }
      } finally {
        await reader.cancel();
      }
      if (size > 262144) continue;
      const image = nativeImage.createFromBuffer(Buffer.concat(parts));
      if (!image.isEmpty())
        return image.resize({ width: 32, height: 32 }).toDataURL();
    } catch {
      if (signal.aborted) return;
    }
  }
}
