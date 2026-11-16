import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { ThumbnailCache, thumbnailKey } from "../src/library/thumbnails";

test("video thumbnails survive cache instances and invalidate on file changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tamki-thumbnail-"));
  try {
    const file = {
      connectionId: "nas",
      path: "/series/01.mp4",
      size: 12345,
      modified: 100,
    };
    const key = thumbnailKey(file);
    const image = execFileSync(ffmpeg!, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "tests/fixtures/video.webm",
      "-frames:v",
      "1",
      "-vf",
      "scale=360:-1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ]);
    await new ThumbnailCache(directory).save(
      key,
      "data:image/jpeg;base64," + image.toString("base64"),
    );
    assert.deepEqual(
      (await new ThumbnailCache(directory).read(key)).data,
      image,
    );
    assert.notEqual(key, thumbnailKey({ ...file, modified: 101 }));
    assert.notEqual(key, thumbnailKey({ ...file, size: 12346 }));
    await assert.rejects(
      new ThumbnailCache(directory).read(
        thumbnailKey({ ...file, modified: 101 }),
      ),
    );
    await assert.rejects(
      new ThumbnailCache(directory).save(
        key,
        "data:image/jpeg;base64," +
          Buffer.from("not an image").toString("base64"),
      ),
    );
    await assert.rejects(
      new ThumbnailCache(directory).save(
        "../escape",
        "data:image/jpeg;base64," + image.toString("base64"),
      ),
    );
    assert.deepEqual(await readdir(directory), [key]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
