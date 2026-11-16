import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoFile } from "../shared/model";

export function thumbnailKey(
  file: Pick<VideoFile, "connectionId" | "path" | "size" | "modified">,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "frame-v1",
        file.connectionId,
        file.path,
        file.size,
        file.modified,
      ]),
    )
    .digest("hex");
}
function validate(bytes: Buffer) {
  if (bytes.length > 512 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("artworkUnavailable");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + size + 2 > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8) break;
      const height = bytes.readUInt16BE(offset + 5),
        width = bytes.readUInt16BE(offset + 7);
      if (width > 0 && width <= 360 && height > 0 && height <= 720) return;
      break;
    }
    offset += size + 2;
  }
  throw new Error("artworkUnavailable");
}
/** Small derived images only; source video bytes are never stored here. */
export class ThumbnailCache {
  constructor(private directory: string) {}
  async read(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("artworkUnavailable");
    const data = await readFile(path.join(this.directory, key));
    validate(data);
    return { data, type: "image/jpeg" };
  }
  async save(key: string, dataURL: string) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      dataURL.length > 700000 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataURL)
    )
      throw new Error("artworkUnavailable");
    const bytes = Buffer.from(
      dataURL.slice("data:image/jpeg;base64,".length),
      "base64",
    );
    validate(bytes);
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path.join(this.directory, key));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
