import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LibraryStore } from "../src/library/store";
import { AutomaticRecognition } from "../src/library/automatic-recognition";
import { automaticCandidate } from "../src/library/automatic-match";
import { ArtworkCache, artworkURL } from "../src/library/artwork";
import { defaultSettings } from "../src/shared/settings";
import type {
  RecognitionRequest,
  RecognitionResponse,
} from "../src/shared/recognition";
const scan = (store: LibraryStore, count = 1) =>
  store.applyScan("local", "/media", {
    groups: [
      {
        path: "/media/Example",
        name: "Example",
        files: Array.from({ length: count }, (_, i) => ({
          path: `/media/Example/${i + 1}.mp4`,
          name: `${i + 1}.mp4`,
          directory: false,
          size: 10,
          modified: 1,
        })),
      },
    ],
    completeDirectories: [],
    failures: [],
  });
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
  scan(store);
  return store;
}
const response = (request: RecognitionRequest): RecognitionResponse => ({
  kind: "result",
  citations: [],
  result: {
    work: {
      title: "Canonical Example",
      description: "Work synopsis",
      tags: ["Animation"],
      cover: "a".repeat(64),
    },
    files: request.draft.episodes.map((e) => ({
      id: e.id,
      number: "2",
      title: "Episode title",
      description: "Episode synopsis",
    })),
  },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Background identification did not reach expected state");
}
test("automatic matching requires one exact title/alias and consistent season; never first hit", () => {
  const store = setup(),
    work = store.snapshot().works[0];
  const candidates = [
    {
      id: "bangumi:1",
      title: "Different",
      aliases: ["Example"],
      description: "",
      date: "",
    },
  ];
  assert.equal(automaticCandidate(work, candidates, "release"), "bangumi:1");
  assert.equal(
    automaticCandidate(work, [{ ...candidates[0], aliases: [] }], "release"),
    undefined,
  );
  assert.equal(
    automaticCandidate(
      work,
      [...candidates, { ...candidates[0], id: "bangumi:2" }],
      "release",
    ),
    undefined,
  );
  work.title = "Example 第二季";
  assert.equal(automaticCandidate(work, candidates, "release"), undefined);
  assert.equal(
    automaticCandidate(
      work,
      [{ ...candidates[0], title: "Example 2nd Season", aliases: [] }],
      "release",
    ),
    "bangumi:1",
  );
  assert.equal(
    automaticCandidate(
      work,
      [
        { ...candidates[0], season: 1 },
        { ...candidates[0], id: "tmdb:tv:1:2", season: 2 },
      ],
      "release",
    ),
    "tmdb:tv:1:2",
  );
  assert.equal(
    automaticCandidate(
      work,
      [{ ...candidates[0], id: "tmdb:tv:1" }],
      "release",
    ),
    "tmdb:tv:1",
  );
  work.episodes[0].fileName = "Example.S01E01.mkv";
  assert.equal(
    automaticCandidate(work, [{ ...candidates[0], season: 2 }], "release"),
    undefined,
  );
  store.close();
});
test("scan→background enrichment persists, avoids repeat requests and recognizes appended files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tamki-auto-"));
  const file = path.join(temporary, "library.sqlite");
  let store = setup(file),
    calls = 0;
  const settings = { snapshot: () => defaultSettings("en") };
  const engine = {
    run: async (r: RecognitionRequest) => {
      calls++;
      return response(r);
    },
    cancel() {},
  };
  let queue = new AutomaticRecognition(store, settings, engine, () => {}, 0);
  try {
    queue.start();
    await until(
      () => store.snapshot().works[0].recognition?.status === "complete",
    );
    const first = store.snapshot().works[0];
    assert.equal(first.description, "Work synopsis");
    assert.equal(first.cover, "a".repeat(64));
    assert.equal(first.title, "Example");
    assert.equal(first.episodes[0].number, "1");
    scan(store);
    queue.schedule();
    await queue.close();
    store.close();
    store = new LibraryStore(file);
    queue = new AutomaticRecognition(store, settings, engine, () => {}, 0);
    queue.start();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls, 1);
    assert.equal(store.snapshot().works[0].cover, first.cover);
    scan(store, 2);
    queue.schedule();
    await until(
      () =>
        store.snapshot().works[0].episodes[1].description ===
        "Episode synopsis",
    );
    assert.equal(calls, 2);
  } finally {
    await queue.close();
    store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
test("in-flight manual edits, clearing fields, progress, ordering and removals win over background results", async () => {
  const store = setup();
  scan(store, 2);
  let resolve!: (r: RecognitionResponse) => void, pending!: RecognitionRequest;
  const queue = new AutomaticRecognition(
    store,
    { snapshot: () => defaultSettings("en") },
    {
      run: (r) => {
        pending = r;
        return new Promise((done) => {
          resolve = done;
        });
      },
      cancel() {},
    },
    () => {},
    0,
  );
  try {
    queue.start();
    const work = store.snapshot().works[0];
    const edit = {
      id: work.id,
      title: "My title",
      description: "My synopsis",
      tags: ["Mine"],
      removedEpisodeIds: [work.episodes[1].id],
      episodes: [{ ...work.episodes[0], title: "My episode" }],
    };
    store.edit(edit);
    store.edit({ ...edit, removedEpisodeIds: [], description: "", tags: [] });
    store.setProgress(work.episodes[0].id, 20, 100, true);
    resolve(response(pending));
    await until(
      () => store.snapshot().works[0].recognition?.status === "complete",
    );
    const saved = store.snapshot().works[0];
    assert.equal(saved.description, "");
    assert.deepEqual(saved.tags, []);
    assert.equal(saved.title, "My title");
    assert.equal(saved.episodes.length, 1);
    assert.equal(saved.episodes[0].title, "My episode");
    assert.equal(saved.episodes[0].position, 20);
    assert.equal(saved.resumeId, work.episodes[0].id);
  } finally {
    await queue.close();
    store.close();
  }
});
test("unmatched and failed jobs are distinct and visible, do not loop, and can be retried explicitly", async () => {
  const store = setup(),
    settings = defaultSettings("en");
  let calls = 0,
    mode = "ambiguous";
  const queue = new AutomaticRecognition(
    store,
    { snapshot: () => settings },
    {
      async run(r) {
        calls++;
        if (mode === "error") throw new Error("sourceRateLimited");
        if (mode === "success") return response(r);
        return { kind: "candidates", candidates: [] };
      },
      cancel() {},
    },
    () => {},
    0,
  );
  try {
    queue.start();
    await until(
      () => store.snapshot().works[0].recognition?.status === "no-match",
    );
    queue.schedule();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1);
    const id = store.snapshot().works[0].id;
    mode = "error";
    queue.schedule([id]);
    await until(
      () => store.snapshot().works[0].recognition?.status === "failed",
    );
    assert.equal(
      store.snapshot().works[0].recognition?.error,
      "sourceRateLimited",
    );
    settings.recognition.automatic = false;
    mode = "success";
    queue.schedule([id]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 2);
    settings.recognition.automatic = true;
    queue.schedule([id]);
    await until(
      () => store.snapshot().works[0].recognition?.status === "complete",
    );
  } finally {
    await queue.close();
    store.close();
  }
});
test("interrupted jobs return to queued, resume, and removed works cannot be resurrected", async () => {
  const store = setup();
  let reject!: (e: Error) => void;
  let queue = new AutomaticRecognition(
    store,
    { snapshot: () => defaultSettings("en") },
    {
      run: () =>
        new Promise((_r, no) => {
          reject = no;
        }),
      cancel: () => reject(new Error("recognitionCancelled")),
    },
    () => {},
    0,
  );
  queue.start();
  await queue.close();
  assert.equal(store.snapshot().works[0].recognition?.status, "queued");
  let done!: (r: RecognitionResponse) => void, pending!: RecognitionRequest;
  queue = new AutomaticRecognition(
    store,
    { snapshot: () => defaultSettings("en") },
    {
      run: (r) => {
        pending = r;
        return new Promise((yes) => {
          done = yes;
        });
      },
      cancel() {},
    },
    () => {},
    0,
  );
  queue.start();
  store.removeWork(store.snapshot().works[0].id);
  done(response(pending));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.snapshot().works.length, 0);
  await queue.close();
  store.close();
});
test("artwork cache accepts safe HTTPS, bounded raster bytes, no authentication, and survives restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tamki-artwork-"));
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWsAAAAASUVORK5CYII=",
    "base64",
  );
  let calls = 0;
  const url = "https://lain.bgm.tv/pic/cover/l/example.png";
  try {
    for (const bad of [
      "http://lain.bgm.tv/a",
      "https://localhost/a",
      "https://lain.bgm.tv.evil.test/a",
      "https://user@lain.bgm.tv/a",
      "https://lain.bgm.tv:999/a",
    ])
      assert.throws(() => artworkURL(bad));
    const request = (async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch;
    const cache = new ArtworkCache(directory, request),
      signal = new AbortController().signal;
    const key = await cache.cache(url, signal);
    assert.equal((await cache.read(key)).type, "image/png");
    assert.equal(
      await new ArtworkCache(directory, request).cache(url, signal),
      key,
    );
    assert.equal(calls, 1);
    await assert.rejects(cache.read("../secret"));
    const invalid = new ArtworkCache(
      directory,
      (async () =>
        new Response("<svg />", {
          headers: { "Content-Type": "image/png" },
        })) as typeof fetch,
    );
    await assert.rejects(invalid.cache(url + "invalid", signal));
    const large = new ArtworkCache(
      directory,
      (async () =>
        new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
          headers: { "Content-Type": "image/png" },
        })) as typeof fetch,
    );
    await assert.rejects(large.cache(url + "large", signal));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("smart organization can pause background recognition, hold it suspended and resume the queued work", async () => {
  const store = setup();
  let reject!: (e: Error) => void,
    calls = 0;
  const queue = new AutomaticRecognition(
    store,
    { snapshot: () => defaultSettings("en") },
    {
      run: async (request) => {
        calls++;
        if (calls > 1) return response(request);
        return new Promise((_resolve, no) => {
          reject = no;
        });
      },
      cancel: () => reject(new Error("recognitionCancelled")),
    },
    () => {},
    0,
  );
  try {
    queue.start();
    await queue.pause();
    assert.equal(store.snapshot().works[0].recognition?.status, "queued");
    queue.schedule();
    assert.equal(calls, 1);
    queue.resume();
    await until(
      () => store.snapshot().works[0].recognition?.status === "complete",
    );
    assert.equal(calls, 2);
  } finally {
    await queue.close();
    store.close();
  }
});

test("artwork repair fills only the missing image and preserves current metadata", () => {
  const store = setup();
  try {
    const work = store.snapshot().works[0];
    store.setRecognition(work.id, {
      status: "complete",
      sourceId: "bangumi",
      signature: "fixture",
      artworkError: true,
    });
    store.repairArtwork(work.id, "stale", "a".repeat(64));
    assert.equal(store.snapshot().works[0].cover, undefined);
    store.repairArtwork(work.id, "fixture", "b".repeat(64));
    const repaired = store.snapshot().works[0];
    assert.equal(repaired.cover, "b".repeat(64));
    assert.equal(repaired.recognition?.artworkError, false);
    assert.equal(repaired.title, work.title);
    store.repairArtwork(work.id, "fixture", "c".repeat(64));
    assert.equal(store.snapshot().works[0].cover, "b".repeat(64));
  } finally {
    store.close();
  }
});
test("downloaded representations of one source episode become selectable versions", () => {
  const store = setup();
  try {
    scan(store, 2);
    store.linkDownloadedVersions("local", [
      {
        path: "/media/Example/1.mp4",
        label: "1080P",
        releaseKey: "bilibili:80",
      },
      { path: "/media/Example/2.mp4", label: "4K", releaseKey: "bilibili:120" },
    ]);
    const work = store.snapshot().works[0];
    assert.equal(work.episodes.length, 1);
    assert.equal(work.episodes[0].versions?.length, 2);
    assert.deepEqual(
      work.episodes[0].versions?.map((version) => version.label).sort(),
      ["1080P", "4K"],
    );
  } finally {
    store.close();
  }
});
