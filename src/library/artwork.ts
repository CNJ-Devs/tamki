import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { artworkURL, publicArtworkFetch } from "./artwork-fetch";
import { pageArtwork } from "./artwork-page";
import { logEvent, observedFetch } from "../diagnostics";
export { artworkURL } from "./artwork-fetch";
function imageType(data: Buffer) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw new Error("artworkUnavailable");
}
export class ArtworkCache {
  constructor(
    private directory: string,
    private request: typeof fetch = observedFetch(publicArtworkFetch),
  ) {}
  async resolve(
    cover: string | null | undefined,
    page: string | null | undefined,
    signal: AbortSignal,
  ) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    bounded.throwIfAborted();
    if (cover)
      try {
        const key = await this.cache(cover, bounded);
        logEvent("artwork.resolve.done", { phase: "direct" });
        return key;
      } catch {
        bounded.throwIfAborted();
        logEvent("artwork.resolve.fallback", {
          phase: "direct",
          reason: "unavailable",
        });
      }
    if (page) {
      const url = artworkURL(page);
      const response = await this.request(url, {
        signal: bounded,
        redirect: "error",
        credentials: "omit",
        headers: { Accept: "text/html" },
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("artworkUnavailable");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (
          !response.ok ||
          !/^text\/html(?:;|$)/i.test(
            response.headers.get("content-type") || "",
          )
        )
          throw new Error("artworkUnavailable");
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 2 * 1024 * 1024) throw new Error("artworkUnavailable");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const candidates = pageArtwork(
        Buffer.concat(chunks).toString("utf8"),
        response.url || url,
      );
      logEvent("artwork.page.parsed", {
        phase: "page",
        issues: candidates.length,
      });
      for (const candidate of candidates)
        try {
          const key = await this.cache(candidate, bounded);
          logEvent("artwork.resolve.done", { phase: "page" });
          return key;
        } catch {
          bounded.throwIfAborted();
        }
    }
    logEvent("artwork.resolve.failed", { reason: "unavailable" }, "warn");
    throw new Error("artworkUnavailable");
  }
  async read(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("artworkUnavailable");
    const data = await readFile(path.join(this.directory, key));
    return { data, type: imageType(data) };
  }
  async cache(value: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const url = artworkURL(value);
    const key = createHash("sha256").update(url).digest("hex");
    if (await this.read(key).catch(() => null)) return key;
    const response = await this.request(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      redirect: "error",
      credentials: "omit",
      headers: { Accept: "image/jpeg, image/png, image/webp" },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("artworkUnavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (
        !response.ok ||
        !/^image\/(jpeg|png|webp)(;|$)/i.test(
          response.headers.get("content-type") || "",
        )
      )
        throw new Error("artworkUnavailable");
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8 * 1024 * 1024) throw new Error("artworkUnavailable");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    imageType(bytes);
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path.join(this.directory, key));
    } finally {
      await rm(temporary, { force: true });
    }
    return key;
  }
}
