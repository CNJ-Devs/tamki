import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LibraryStore, recognitionSignature } from "../src/library/store";
import { ArtworkCache } from "../src/library/artwork";
import { Bilibili } from "../src/capture/bilibili";
import { libraryEntries } from "../src/shared/series";
import type { CaptureMetadata } from "../src/shared/capture";

const metadata: CaptureMetadata = {
  id: "bilibili:season:7",
  url: "https://www.bilibili.com/bangumi/play/ss7",
  title: "Official title",
  description: "Official synopsis",
  tags: ["Animation"],
  cover: "https://i0.hdslb.com/bfs/bangumi/poster.png",
};
const episode = {
  title: "Official episode",
  number: "12",
  description: "Episode synopsis",
  cover: "https://i0.hdslb.com/bfs/archive/episode.png",
};
function setup(file = ":memory:") {
  const store = new LibraryStore(file);
  store.saveConnection({
    id: "local",
    type: "local",
    name: "Local",
    roots: ["/media"],
    status: "connected",
    error: null,
    scannedAt: null,
  });
  store.applyScan("local", "/media", {
    groups: [
      {
        path: "/media/Work",
        name: "Saved folder",
        files: [
          {
            path: "/media/Work/001.mp4",
            name: "001.mp4",
            directory: false,
            size: 10,
            modified: 1,
          },
        ],
      },
    ],
    completeDirectories: [],
    failures: [],
  });
  return store;
}

test("capture preserves separate official work/episode metadata and normalizes only trusted artwork", async () => {
  const bili = new Bilibili((async () =>
    Response.json({
      code: 0,
      result: {
        season_id: 7,
        title: metadata.title,
        evaluate: metadata.description,
        styles: metadata.tags,
        cover: "http://i0.hdslb.com/bfs/bangumi/poster.png",
        episodes: [
          {
            id: 17,
            aid: 1,
            bvid: "BV0000000001",
            cid: 10,
            title: "12",
            long_title: episode.title,
            cover: "//i0.hdslb.com/bfs/archive/episode.png",
          },
        ],
      },
    })) as typeof fetch);
  const result = await bili.discover(
    "https://www.bilibili.com/bangumi/play/ep17",
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(result?.groups[0].metadata, metadata);
  assert.equal(result?.current?.metadata?.cover, episode.cover);
  assert.equal(result?.current?.metadata?.title, episode.title);
  assert.equal(result?.current?.metadata?.number, "12");
  const invalid = new Bilibili((async () =>
    Response.json({
      code: 0,
      data: {
        aid: 1,
        bvid: "BV0000000001",
        title: "Video",
        desc: "Video synopsis",
        pic: "http://127.0.0.1/private.png",
        pages: [
          {
            page: 1,
            cid: 10,
            part: "One",
            first_frame: "https://hdslb.com.evil.test/frame.png",
          },
        ],
      },
    })) as typeof fetch);
  const video = await invalid.discover(
    "https://www.bilibili.com/video/av1",
    AbortSignal.timeout(1000),
  );
  assert.equal(video?.metadata?.cover, undefined);
  assert.equal(video?.current?.metadata?.cover, undefined);
  assert.equal(video?.metadata?.description, "Video synopsis");
});

test("direct import suppresses redundant recognition and survives restart independently of task records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tamki-source-metadata-"));
  const file = path.join(dir, "library.sqlite");
  let store = setup(file);
  try {
    store.applyCapturedMetadata(
      "local",
      "/media/Work/001.mp4",
      metadata,
      episode,
      "Saved folder",
    );
    store.queueRecognition("some-ai-source");
    const work = store.snapshot().works[0];
    assert.equal(work.title, metadata.title);
    assert.equal(work.description, metadata.description);
    assert.equal(work.recognition?.status, "complete");
    assert.equal(work.recognition?.sourceId, "bilibili");
    assert.equal(work.episodes[0].title, episode.title);
    assert.equal(work.episodes[0].number, "12");
    assert.equal(work.episodes[0].artworkSource, episode.cover);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWsAAAAASUVORK5CYII=",
      "base64",
    );
    let requests = 0;
    const cache = new ArtworkCache(path.join(dir, "artwork"), (async () => {
      requests++;
      return new Response(png, { headers: { "content-type": "image/png" } });
    }) as typeof fetch);
    const key = await cache.cache(metadata.cover!, AbortSignal.timeout(1000));
    store.repairCapturedArtwork(work.id, metadata.cover!, key);
    store.repairCapturedArtwork(work.episodes[0].id, episode.cover, key, true);
    store.close();
    store = new LibraryStore(file);
    const reopened = store.snapshot().works[0];
    assert.equal(reopened.cover, key);
    assert.equal(reopened.episodes[0].cover, key);
    assert.equal(reopened.captureSource?.cover, metadata.cover);
    assert.deepEqual(store.downloadJobs(), []);
    await cache.cache(metadata.cover!, AbortSignal.timeout(1000));
    assert.equal(requests, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual edits and cleared fields win over subsequent captured metadata and artwork repair", () => {
  const store = setup();
  try {
    store.applyCapturedMetadata(
      "local",
      "/media/Work/001.mp4",
      metadata,
      episode,
      "Saved folder",
    );
    const work = store.snapshot().works[0];
    store.edit({
      ...work,
      title: "My title",
      description: "",
      tags: [],
      cover: "c".repeat(64),
      episodes: [
        {
          ...work.episodes[0],
          title: "My episode",
          number: "SP",
          description: "",
        },
      ],
      removedEpisodeIds: [],
    });
    store.applyCapturedMetadata(
      "local",
      "/media/Work/001.mp4",
      metadata,
      episode,
      "My title",
    );
    store.repairCapturedArtwork(work.id, metadata.cover!, "a".repeat(64));
    const saved = store.snapshot().works[0];
    assert.equal(saved.title, "My title");
    assert.equal(saved.description, "");
    assert.deepEqual(saved.tags, []);
    assert.equal(saved.cover, "c".repeat(64));
    assert.equal(saved.episodes[0].title, "My episode");
    assert.equal(saved.episodes[0].number, "SP");
    assert.equal(saved.episodes[0].description, "");
  } finally {
    store.close();
  }
});

test("appending a download preserves a previously confirmed work's identity and recognition", () => {
  const store = setup();
  try {
    const work = store.snapshot().works[0];
    store.setRecognition(work.id, {
      sourceId: "manual",
      status: "complete",
      signature: recognitionSignature(work),
    });
    store.applyCapturedMetadata(
      "local",
      "/media/Work/001.mp4",
      metadata,
      episode,
    );
    const saved = store.snapshot().works[0];
    assert.equal(saved.title, "Saved folder");
    assert.equal(saved.recognition?.sourceId, "manual");
    store.failCapturedEpisodeArtwork(saved.episodes[0].id, episode.cover);
    assert.equal(store.snapshot().works[0].episodes[0].artworkError, true);
    store.repairCapturedArtwork(
      saved.episodes[0].id,
      episode.cover,
      "a".repeat(64),
      true,
    );
    assert.equal(store.snapshot().works[0].episodes[0].artworkError, false);
  } finally {
    store.close();
  }
});

test("series projection uses the first available member poster in the configured order", () => {
  const store = setup();
  try {
    const work = store.snapshot().works[0];
    const state = {
      ...store.snapshot(),
      works: [
        { ...work, id: "one", cover: undefined },
        { ...work, id: "two", cover: "b".repeat(64) },
      ],
      series: [{ id: "series", name: "Family", workIds: ["one", "two"] }],
    };
    assert.equal(
      libraryEntries(state).find((w) => w.id === "series")?.cover,
      "b".repeat(64),
    );
  } finally {
    store.close();
  }
});
