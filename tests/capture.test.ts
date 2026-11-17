import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  stat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Bilibili,
  biliPage,
  mediaURL,
  parsePlayback,
  type ResolvedMedia,
} from "../src/capture/bilibili";
import { VideoDownloads, muxMedia } from "../src/capture/downloads";
import { CaptureStorage } from "../src/capture/storage";
import { LocalProvider } from "../src/providers/local";
import { LibraryStore } from "../src/library/store";
import {
  captureResourceSchema,
  downloadNameSchema,
  safeDownloadName,
  type VideoDownloadJob,
} from "../src/shared/capture";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const video = (aid = 1, count = 2) => ({
  aid,
  bvid: `BV${String(aid).padStart(10, "0")}`,
  title: `Work ${aid}`,
  owner: { mid: 10 },
  pages: Array.from({ length: count }, (_, i) => ({
    cid: aid * 100 + i + 1,
    page: i + 1,
    part: `Part ${i + 1}`,
    duration: 30,
  })),
});
const resource = (aid = 1) =>
  captureResourceSchema.parse({
    provider: "bilibili",
    id: `bili:${aid}:${aid * 100 + 1}`,
    aid,
    bvid: video(aid).bvid,
    cid: aid * 100 + 1,
    title: `Video ${aid}`,
    duration: 30,
  });
const signal = () => new AbortController().signal;
const response = (data: unknown) => Response.json({ code: 0, data });
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("Bilibili URLs identify videos, parts, seasons and collection pages without accepting lookalike hosts", () => {
  assert.equal(
    biliPage("https://www.bilibili.com/video/BV0000000001/?p=2")?.kind,
    "video",
  );
  assert.deepEqual(biliPage("https://www.bilibili.com/bangumi/play/ep10"), {
    kind: "season",
    episodeId: 10,
  });
  assert.deepEqual(
    biliPage("https://space.bilibili.com/10/lists/30?type=season"),
    { kind: "collection", owner: 10, collection: 30, series: false },
  );
  assert.deepEqual(
    biliPage("https://space.bilibili.com/10/channel/seriesdetail?sid=30"),
    { kind: "collection", owner: 10, collection: 30, series: true },
  );
  assert.deepEqual(
    biliPage(
      "https://www.bilibili.com/medialist/play/10?business=space_series&business_id=30",
    ),
    { kind: "collection", owner: 10, collection: 30, series: true },
  );
  for (const url of [
    "https://bilibili.com.evil.test/video/BV0000000001",
    "file:///video/BV0000000001",
    "https://user:pass@www.bilibili.com/video/BV0000000001",
  ])
    assert.equal(biliPage(url), undefined);
  for (const url of [
    "https://evil.test/a",
    "https://bilivideo.com.evil.test/a",
    "file:///tmp/a",
    "http://video.bilivideo.com/a",
    "https://127.0.0.1/a",
  ])
    assert.throws(() => mediaURL(url), /captureInvalid/);
  assert.equal(
    mediaURL("https://example.bilivideo.com/video.m4s"),
    "https://example.bilivideo.com/video.m4s",
  );
  for (const name of ["../video", "CON.mp4", "/tmp/a", "a/b", "a\\b", "bad."])
    assert(!downloadNameSchema.safeParse(name).success);
  assert(
    downloadNameSchema.safeParse(safeDownloadName("长标题".repeat(100)))
      .success,
  );
  assert(Buffer.byteLength(safeDownloadName("长标题".repeat(100))) <= 220);
});

test("anonymous discovery retains all parts and the selected part; collections paginate and expand multipart entries", async () => {
  const calls: string[] = [];
  const bili = new Bilibili((async (url, init) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      undefined,
    );
    if (u.pathname.includes("seasons_archives")) {
      const second = u.searchParams.get("page_num") === "2";
      return response({
        page: { total: 2 },
        meta: { name: "Collection" },
        archives: [{ aid: second ? 2 : 1 }],
      });
    }
    return response(video(Number(u.searchParams.get("aid") || 1)));
  }) as typeof fetch);
  const one = await bili.discover(
    "https://www.bilibili.com/video/BV0000000001/?p=2",
    signal(),
  );
  assert.equal(one!.current!.cid, 102);
  assert.equal(one!.groups[0].resources.length, 2);
  const collection = await bili.discover(
    "https://space.bilibili.com/10/lists/20?sid=30&type=season",
    signal(),
  );
  assert.equal(collection!.current, undefined);
  assert.equal(collection!.groups[0].resources.length, 4);
  assert.deepEqual(
    collection!.groups[0].resources.map((r) => r.cid),
    [101, 102, 201, 202],
  );
  assert(calls.some((c) => c.includes("page_num=2")));
});

test("incomplete/duplicated collection listings fail instead of offering a partial all-download", async () => {
  for (const data of [
    { page: { total: 2 }, archives: [] },
    { page: { total: 2 }, archives: [{ aid: 1 }, { aid: 1 }] },
  ]) {
    const bili = new Bilibili((async () => response(data)) as typeof fetch);
    await assert.rejects(
      bili.discover(
        "https://space.bilibili.com/10/lists?sid=30&type=season",
        signal(),
      ),
      /captureIncomplete/,
    );
  }
});

test("PGC seasons expose every episode while resolving access and URLs only on execution", async () => {
  let resolutions = 0;
  const bili = new Bilibili((async (url) => {
    if (String(url).includes("playurl")) {
      resolutions++;
      return Response.json({ code: -10403 });
    }
    return response({
      season_id: 9,
      title: "A season",
      episodes: [1, 2].map((n) => ({
        ...video(n, 1),
        id: n,
        cid: n * 100 + 1,
        title: String(n),
        long_title: "Episode",
        duration: 30000,
      })),
    });
  }) as typeof fetch);
  const result = await bili.discover(
    "https://www.bilibili.com/bangumi/play/ep2",
    signal(),
  );
  assert.equal(result!.current!.episodeId, 2);
  assert.equal(result!.groups[0].resources.length, 2);
  assert.equal(resolutions, 0);
  await assert.rejects(
    bili.resolve(result!.current!, signal()),
    /captureRestricted/,
  );
  assert.equal(resolutions, 1);
});

test("playback parsing uses accessible quality, retains audio, and refuses protected, preview or arbitrary-host streams", () => {
  const stream = {
    id: 80,
    codecid: 7,
    bandwidth: 100,
    baseUrl: "https://media.bilivideo.com/video",
  };
  const input = {
    quality: 80,
    timelength: 30000,
    dash: {
      video: [{ ...stream, id: 120 }, stream],
      audio: [
        { ...stream, id: 30280, baseUrl: "https://media.bilivideo.com/audio" },
      ],
    },
  };
  assert.equal(parsePlayback(input).streams.length, 2);
  assert.equal(parsePlayback(input).streams[0].key.startsWith("80:"), true);
  // Purchase status is independent of playback entitlement: free, full-length
  // PGC streams legitimately return has_paid=false.
  const free = parsePlayback({
    ...input,
    has_paid: false,
    is_drm: false,
    is_preview: 0,
  });
  assert.equal(free.duration, 30);
  assert.equal(free.streams.length, 2);
  assert.throws(
    () =>
      parsePlayback({
        ...input,
        dash: { video: [{ ...stream, drm_tech_type: 2 }] },
      }),
    /captureUnavailable/,
  );
  for (const patch of [{ is_drm: true }, { is_preview: 1 }])
    assert.throws(
      () => parsePlayback({ ...input, has_paid: false, ...patch }),
      /captureRestricted/,
    );
  assert.throws(
    () =>
      parsePlayback({
        ...input,
        dash: { video: [{ ...stream, baseUrl: "https://evil.test/a" }] },
      }),
    /captureInvalid/,
  );
});

async function setup() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "tamki-download-test-")),
  );
  const store = new LibraryStore(path.join(root, "index.sqlite"), "en");
  const connection = {
    id: "local",
    name: "Local",
    type: "local" as const,
    roots: [root],
    status: "connected" as const,
    error: null,
    scannedAt: null,
  };
  store.saveConnection(connection);
  const storage = new CaptureStorage({
    connection: () => connection,
    provider: async () => new LocalProvider([root]),
    upload: async () => {
      throw new Error("Unexpected upload");
    },
  });
  return {
    root,
    store,
    storage,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("download retry resumes verified bytes, publishes complete files without overwriting, and skips completed siblings", async () => {
  const f = await setup();
  let manager: VideoDownloads | undefined;
  try {
    let fail = true;
    const ranges: string[] = [];
    const resolved: number[] = [];
    const bytes = Buffer.from("a synthetic video payload");
    const request: typeof fetch = async (_url, init) => {
      const range = (init?.headers as Record<string, string>).Range || "";
      ranges.push(range);
      const start = range ? Number(range.match(/\d+/)![0]) : 0;
      if (fail) {
        fail = false;
        let sent = false;
        return new Response(
          new ReadableStream({
            async pull(c) {
              if (!sent) {
                sent = true;
                c.enqueue(bytes.subarray(0, 8));
                await new Promise((r) => setTimeout(r, 20));
              } else c.error(new Error("interrupted"));
            },
          }),
          {
            headers: {
              "content-length": String(bytes.length),
              etag: "fixture",
            },
          },
        );
      }
      return new Response(bytes.subarray(start), {
        status: start ? 206 : 200,
        headers: {
          "content-length": String(bytes.length - start),
          ...(start
            ? {
                "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
              }
            : {}),
          etag: "fixture",
        },
      });
    };
    manager = new VideoDownloads({
      store: f.store,
      cache: path.join(f.root, "cache"),
      request,
      resolve: async (r) => {
        resolved.push(r.aid);
        return {
          kind: "segments",
          duration: 30,
          streams: [
            { url: "https://media.bilivideo.com/test", key: "stable-stream" },
          ],
        };
      },
      mux: async (_m, inputs, output) =>
        writeFile(output, await readFile(inputs[0])),
      target: (...args) => f.storage.target(...args),
      publish: (...args) => f.storage.publish(...args),
      completed: async () => undefined,
      emit: () => {},
    });
    const job = await manager.enqueue(
      "Series",
      [resource(1), resource(2)],
      { connectionId: "local", path: f.root },
      true,
    );
    await until(() =>
      f.store
        .downloadJobs()[0]
        .items.every((i) => ["failed", "completed"].includes(i.state)),
    );
    const before = f.store.downloadJobs()[0];
    assert.equal(before.items.filter((i) => i.state === "completed").length, 1);
    manager.command(job.id, "retry");
    await until(() =>
      f.store.downloadJobs()[0].items.every((i) => i.state === "completed"),
    );
    assert(ranges.includes("bytes=8-"));
    assert.equal(resolved.length, 3);
    const completed = f.store.downloadJobs()[0];
    for (const item of completed.items)
      assert.deepEqual(await readFile(item.path!), bytes);
    assert.equal(
      completed.items.every((i) => i.progress === 1),
      true,
    );
    const name = completed.items[0].name,
      old = await readFile(completed.items[0].path!);
    await writeFile(path.join(f.root, "incoming.mp4"), "new");
    await assert.rejects(
      f.storage.publish(
        path.join(f.root, "incoming.mp4"),
        completed.target,
        name,
        "another",
        signal(),
      ),
      /downloadExists/,
    );
    assert.deepEqual(await readFile(completed.items[0].path!), old);
    manager.command(job.id, "cancel");
    assert(
      f.store.downloadJobs()[0].items.every((i) => i.state === "completed"),
    );
  } finally {
    await manager?.close();
    await f.close();
  }
});

test("interrupted queues become paused on restart and cannot write outside granted storage", async () => {
  const f = await setup();
  let manager: VideoDownloads | undefined;
  try {
    const job: VideoDownloadJob = {
      id: crypto.randomUUID(),
      name: "Saved",
      series: false,
      createdAt: 1,
      target: { connectionId: "local", path: f.root },
      items: [
        {
          id: crypto.randomUUID(),
          resource: resource(),
          name: "Video.mp4",
          state: "running",
          stage: "transferring",
          received: 8,
          total: 30,
        },
      ],
    };
    f.store.saveDownloadJob(job);
    manager = new VideoDownloads({
      store: f.store,
      cache: path.join(f.root, "cache"),
      request: async () => {
        throw new Error("No automatic requests on restart");
      },
      resolve: async () => {
        throw new Error("No automatic resolution on restart");
      },
      mux: async () => {},
      target: (...args) => f.storage.target(...args),
      publish: (...args) => f.storage.publish(...args),
      completed: async () => undefined,
      emit: () => {},
    });
    assert.equal(f.store.downloadJobs()[0].items[0].state, "paused");
    assert.equal(f.store.downloadJobs()[0].items[0].received, 8);
    await assert.rejects(manager.remove(job.id), /transferUnavailable/);
    manager.command(job.id, "cancel");
    const cache = path.join(f.root, "cache", job.id, job.items[0].id);
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "partial"), "cache");
    const destination = path.join(f.root, "already-downloaded.mp4");
    await writeFile(destination, "keep-file");
    await manager.remove(job.id);
    assert.equal(f.store.downloadJobs().length, 0);
    assert.equal(await readFile(destination, "utf8"), "keep-file");
    await assert.rejects(stat(cache));
    await manager.close();
    assert.equal(
      f.store.downloadJobs().length,
      0,
      "Shutdown must not resurrect removed records",
    );

    await assert.rejects(
      f.storage.target(
        { connectionId: "local", path: tmpdir() },
        "Outside",
        false,
      ),
      /outsideRoot/,
    );
  } finally {
    await manager?.close();
    await f.close();
  }
});

test("bundled FFmpeg merges actual separate audio/video streams into a playable MP4", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tamki-mux-test-"));
  try {
    const video = path.join(root, "video.mp4"),
      audio = path.join(root, "audio.m4a"),
      output = path.join(root, "merged.mp4");
    execFileSync(ffmpeg!, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x90:d=0.3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      video,
    ]);
    execFileSync(ffmpeg!, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.3",
      "-c:a",
      "aac",
      audio,
    ]);
    const media: ResolvedMedia = { kind: "dash", duration: 0.3, streams: [] };
    await muxMedia(
      path.resolve(
        "dist/tools",
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
      ),
      media,
      [video, audio],
      output,
      signal(),
    );
    assert((await stat(output)).size > 1000);
    execFileSync(ffmpeg!, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      output,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pausing and cancelling in-flight downloads aborts transport; resume keeps verified partial bytes", async () => {
  const f = await setup();
  let manager: VideoDownloads | undefined;
  let round = 0;
  let aborted = 0;
  const ranges: string[] = [];
  const payload = Buffer.from("fixture media bytes");
  try {
    manager = new VideoDownloads({
      store: f.store,
      cache: path.join(f.root, "cache"),
      emit: () => {},
      resolve: async () => ({
        kind: "segments",
        duration: 1,
        streams: [{ key: "stable", url: "https://fixture.bilivideo.com/a" }],
      }),
      request: async (_url, init) => {
        const range = (init!.headers as Record<string, string>).Range || "";
        ranges.push(range);
        round++;
        const start = range ? Number(range.match(/\d+/)![0]) : 0;
        const headers = {
          "content-length": String(payload.length - start),
          etag: "stable",
          ...(start
            ? {
                "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
              }
            : {}),
        };
        if (round === 2)
          return new Response(payload.subarray(start), {
            status: start ? 206 : 200,
            headers,
          });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(payload.subarray(0, 5));
              init!.signal!.addEventListener(
                "abort",
                () => {
                  aborted++;
                  c.error(init!.signal!.reason);
                },
                { once: true },
              );
            },
          }),
          { headers },
        );
      },
      mux: async (_m, inputs, out) => writeFile(out, await readFile(inputs[0])),
      target: (...a) => f.storage.target(...a),
      publish: (...a) => f.storage.publish(...a),
      completed: async () => undefined,
    });
    const target = { connectionId: "local", path: f.root };
    const job = await manager.enqueue(
      "Pause test",
      [resource()],
      target,
      false,
    );
    await until(() => f.store.downloadJobs()[0].items[0].received === 5);
    manager.command(job.id, "pause");
    await until(() => aborted === 1);
    assert.equal(f.store.downloadJobs()[0].items[0].state, "paused");
    manager.command(job.id, "resume");
    await until(() => f.store.downloadJobs()[0].items[0].state === "completed");
    assert.equal(ranges[1], "bytes=5-");
    const cancel = await manager.enqueue(
      "Cancel test",
      [resource(2)],
      target,
      false,
    );
    await until(
      () =>
        f.store.downloadJobs().find((j) => j.id === cancel.id)!.items[0]
          .received === 5,
    );
    manager.command(cancel.id, "cancel");
    await until(() => aborted === 2);
    assert.equal(
      f.store.downloadJobs().find((j) => j.id === cancel.id)!.items[0].state,
      "cancelled",
    );
    assert.equal(
      await stat(path.join(f.root, "Cancel test.mp4")).catch(() => null),
      null,
    );
  } finally {
    await manager?.close();
    await f.close();
  }
});

test("ZSpace save uses scoped CLI upload without overwrite and verifies saved bytes", async () => {
  const f = await setup();
  try {
    const file = path.join(f.root, "source.mp4"),
      bytes = Buffer.from("synthetic media");
    await writeFile(file, bytes);
    const entries: any[] = [];
    const calls: string[][] = [];
    let corrupt = false;
    let sampleProgress = true;
    const progress: number[] = [];
    const connection = {
      id: "nas",
      type: "zspace" as const,
      name: "NAS",
      roots: ["/media"],
      browseRoots: ["/media"],
      status: "connected" as const,
      error: null,
      scannedAt: null,
    };
    const storage = new CaptureStorage({
      connection: () => connection,
      provider: async () => ({
        list: async () => entries,
        read: async (_p: string, start: number, length: number) =>
          corrupt
            ? Buffer.alloc(length)
            : bytes.subarray(start, start + length),
      }),
      upload: async (_id, args) => {
        calls.push(args);
        assert(args.includes("--yes"));
        const params = JSON.parse(args[args.indexOf("--params") + 1]);
        assert.equal(params.rename, 0);
        assert.notEqual(params.overwrite, true);
        if (args.includes("mkdir"))
          entries.push({
            name: params.name,
            path: "/media/" + params.name,
            directory: true,
            size: 0,
            modified: 0,
          });
        else {
          assert.equal(args[0], "--local-root");
          assert.equal(args[1], f.root);
          assert.equal(params.local_path, "source.mp4");
          assert.equal(params.resume, true);
          if (sampleProgress) {
            sampleProgress = false;
            const partial = {
              name: `.${path.posix.basename(params.dest_path)}.z${"a".repeat(32)}`,
              path: `${params.dest_path}.partial`,
              directory: false,
              size: 7,
              modified: 0,
            };
            entries.push(partial);
            await new Promise((resolve) => setTimeout(resolve, 2200));
            entries.splice(entries.indexOf(partial), 1);
          }
          entries.push({
            name: path.posix.basename(params.dest_path),
            path: params.dest_path,
            directory: false,
            size: bytes.length,
            modified: 0,
          });
        }
        return { path: params.dest_path };
      },
    });
    const target = await storage.target(
      { connectionId: "nas", path: "/media" },
      "Series",
      true,
    );
    assert.equal(target.path, "/media/Series");
    assert.equal(
      await storage.publish(
        file,
        target,
        "Episode.mp4",
        "fixture",
        signal(),
        (n) => progress.push(n),
      ),
      "/media/Series/Episode.mp4",
    );
    assert(
      progress.includes(7),
      "reports observed partial bytes before completion",
    );
    assert.equal(progress.at(-1), bytes.length);
    assert.equal(calls.length, 2);
    assert.equal(
      await storage.publish(file, target, "Episode.mp4", "fixture", signal()),
      "/media/Series/Episode.mp4",
    );
    assert.equal(calls.length, 2, "reconciliation must not upload again");
    corrupt = true;
    await assert.rejects(
      storage.publish(file, target, "Episode.mp4", "fixture", signal()),
      /downloadExists/,
    );
    corrupt = false;
    await assert.rejects(
      storage.target(
        { connectionId: "nas", path: "/elsewhere" },
        "Outside",
        false,
      ),
      /outsideRoot/,
    );
    corrupt = true;
    await assert.rejects(
      storage.publish(file, target, "Corrupt.mp4", "fixture", signal()),
      /downloadSaveFailed/,
    );
  } finally {
    await f.close();
  }
});

test("a failed collection does not remove a verified current video or offer incomplete batch download", async () => {
  const bili = new Bilibili((async (url) =>
    new URL(String(url)).pathname === "/x/web-interface/view"
      ? response({ ...video(1, 1), ugc_season: { id: 20 } })
      : Response.json({ code: -412 })) as typeof fetch);
  const result = await bili.discover(
    "https://www.bilibili.com/video/BV0000000001",
    signal(),
  );
  assert(result?.current);
  assert.equal(result.groups.length, 0);
  assert.equal(result.collectionError, "captureRateLimited");
});

test("PGC discovers only explicit sibling seasons, deduplicates links and preserves current episode", async () => {
  const calls: number[] = [];
  const bili = new Bilibili((async (url) => {
    const u = new URL(String(url));
    assert.ok(u.pathname.endsWith("/pgc/view/web/season"));
    const id = Number(u.searchParams.get("season_id") || 9);
    calls.push(id);
    return response({
      season_id: id,
      title: `Work ${id}`,
      episodes: [
        { ...video(id, 1), id, cid: id * 100 + 1, title: "1", duration: 1000 },
      ],
      seasons:
        id === 9
          ? [
              { season_id: 9, season_title: "First" },
              { season_id: 10, season_title: "Second" },
              { season_id: 10 },
              { season_id: 11, season_title: "Film" },
            ]
          : [{ season_id: 99 }],
    });
  }) as typeof fetch);
  const result = await bili.discover(
    "https://www.bilibili.com/bangumi/play/ep9",
    signal(),
  );
  assert.deepEqual(
    calls.sort((a, b) => a - b),
    [9, 10, 11],
  );
  assert.deepEqual(
    result!.groups.map((g) => g.id),
    ["season:9", "season:10", "season:11"],
  );
  assert.equal(result!.groups[0].title, "Work 9 · First");
  assert.equal(result!.current!.episodeId, 9);
});
test("PGC sibling failures retain current season and successful siblings with a partial-result warning", async () => {
  const bili = new Bilibili((async (url) => {
    const id = Number(new URL(String(url)).searchParams.get("season_id") || 9);
    if (id === 10) return Response.json({ code: -10403 });
    return response({
      season_id: id,
      title: "Work",
      episodes: [{ ...video(id, 1), id, cid: id * 100 + 1, title: "1" }],
      seasons: [{ season_id: 10 }, { season_id: 11 }],
    });
  }) as typeof fetch);
  const r = await bili.discover(
    "https://www.bilibili.com/bangumi/play/ep9",
    signal(),
  );
  assert.deepEqual(
    r!.groups.map((g) => g.id),
    ["season:9", "season:11"],
  );
  assert.equal(r!.collectionError, "captureRestricted");
  assert.equal(r!.current!.episodeId, 9);
});
test("PGC cancellation during sibling lookup propagates instead of returning partial success", async () => {
  const controller = new AbortController();
  const bili = new Bilibili((async (url) => {
    if (new URL(String(url)).searchParams.has("season_id")) {
      controller.abort();
      throw controller.signal.reason;
    }
    return response({
      season_id: 9,
      title: "Work",
      episodes: [{ ...video(9, 1), id: 9, cid: 901, title: "1" }],
      seasons: [{ season_id: 10 }],
    });
  }) as typeof fetch);
  await assert.rejects(
    bili.discover(
      "https://www.bilibili.com/bangumi/play/ep9",
      controller.signal,
    ),
  );
});

test("downloads run ahead of slow saves, with one save per destination and abortable waiting", async () => {
  const f = await setup();
  let manager: VideoDownloads | undefined;
  let resolved = 0,
    saving = 0,
    peakSaving = 0;
  const payload = Buffer.from("fixture media");
  try {
    manager = new VideoDownloads({
      store: f.store,
      cache: path.join(f.root, "cache"),
      emit: () => {},
      limits: () => ({ downloads: 3, saves: 2, cacheGiB: 20 }),
      resolve: async () => {
        resolved++;
        return {
          kind: "segments",
          duration: 1,
          streams: [{ key: "stable", url: "https://fixture.bilivideo.com/a" }],
        };
      },
      request: async () =>
        new Response(payload, {
          headers: { "content-length": String(payload.length) },
        }),
      mux: async (_media, inputs, output) =>
        writeFile(output, await readFile(inputs[0])),
      target: async (target) => target,
      publish: async (_file, _target, _name, _id, signal) => {
        saving++;
        peakSaving = Math.max(peakSaving, saving);
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          return "unused";
        } finally {
          saving--;
        }
      },
      completed: async () => undefined,
    });
    const job = await manager.enqueue(
      "pipeline",
      Array.from({ length: 9 }, (_, i) => resource(i + 1)),
      { connectionId: "local", path: f.root },
      true,
    );
    await until(() => resolved >= 4);
    await until(() =>
      f.store
        .downloadJobs()[0]
        .items.some((item) => item.stage === "waitingSave"),
    );
    assert.equal(peakSaving, 1);
    assert.ok(
      resolved < 9,
      "read-ahead must remain bounded when saving stalls",
    );
    manager.command(job.id, "pause");
    await manager.close();
    assert.equal(saving, 0);
    assert.ok(
      f.store.downloadJobs()[0].items.every((item) => item.state === "paused"),
    );
  } finally {
    await manager?.close();
    await f.close();
  }
});

test("publication retry recognizes retained output without overwriting a different file", async () => {
  const f = await setup();
  try {
    const source = path.join(f.root, "cached.mp4"),
      target = { connectionId: "local", path: f.root };
    await writeFile(source, "same bytes");
    const first = await f.storage.publish(
      source,
      target,
      "saved.mp4",
      "fixture",
      signal(),
    );
    assert.equal(
      await f.storage.publish(source, target, "saved.mp4", "fixture", signal()),
      first,
    );
    await writeFile(first, "diff bytes");
    await assert.rejects(
      f.storage.publish(source, target, "saved.mp4", "fixture", signal()),
      /downloadExists/,
    );
    assert.equal(await readFile(first, "utf8"), "diff bytes");
  } finally {
    await f.close();
  }
});

test("explicit quality selects that representation and never silently downgrades", () => {
  const input = {
    quality: 120,
    timelength: 10000,
    accept_quality: [120, 80],
    accept_description: ["4K", "1080P"],
    dash: {
      video: [120, 80].map((id) => ({
        id,
        codecid: 7,
        baseUrl: "https://media.bilivideo.com/v" + id,
      })),
    },
  };
  assert.equal(parsePlayback(input, 80).quality, 80);
  assert.equal(parsePlayback(input, 80).qualityLabel, "1080P");
  assert.deepEqual(parsePlayback(input).qualities, [
    { id: 120, label: "4K" },
    { id: 80, label: "1080P" },
  ]);
  assert.throws(() => parsePlayback(input, 125), /captureUnavailable/);
  assert.throws(
    () =>
      parsePlayback(
        { quality: 80, durl: [{ url: "https://media.bilivideo.com/v" }] },
        120,
      ),
    /captureRestricted/,
  );
});

test("multiple selected qualities keep episode numbering and distinct output files", async () => {
  const f = await setup();
  const manager = new VideoDownloads({
    store: f.store,
    cache: path.join(f.root, "cache"),
    request: fetch,
    resolve: async () => {
      throw new Error("fixture-unavailable");
    },
    mux: async () => {},
    target: (...args) => f.storage.target(...args),
    publish: (...args) => f.storage.publish(...args),
    completed: async () => undefined,
    emit: () => {},
  });
  try {
    const job = await manager.enqueue(
      "Multi quality",
      [resource(1), resource(2)],
      { connectionId: "local", path: f.root },
      true,
      [80, 120],
    );
    assert.equal(job.items.length, 4);
    assert.deepEqual(
      job.items.map((item) => item.resource.quality),
      [80, 120, 80, 120],
    );
    assert.deepEqual(
      job.items.map((item) => item.name.slice(0, 3)),
      ["001", "001", "002", "002"],
    );
    assert.equal(new Set(job.items.map((item) => item.name)).size, 4);
  } finally {
    await manager.close();
    await f.close();
  }
});

test("episode quality overrides persist separately and batch actions affect only selected items", async () => {
  const f = await setup();
  const manager = new VideoDownloads({
    store: f.store,
    cache: path.join(f.root, "cache"),
    request: fetch,
    resolve: async () => {
      throw new Error("fixture-unavailable");
    },
    mux: async () => {},
    target: (...args) => f.storage.target(...args),
    publish: (...args) => f.storage.publish(...args),
    completed: async () => undefined,
    emit: () => {},
  });
  try {
    const job = await manager.enqueue(
      "Quality exceptions",
      [resource(1), resource(2), resource(3)],
      { connectionId: "local", path: f.root },
      true,
      [112],
      undefined,
      undefined,
      undefined,
      new Map([[resource(2).id, [80, 64]]]),
    );
    assert.deepEqual(
      job.items.map((i) => i.resource.quality),
      [112, 80, 64, 112],
    );
    const selected = [job.items[0].id, job.items[1].id];
    manager.command(job.id, "pause", selected);
    assert(job.items.slice(0, 2).every((i) => i.state === "paused"));
    assert.notEqual(job.items[2].state, "paused");
    assert.throws(
      () => manager.command(job.id, "cancel", [selected[0], "unknown"]),
      /transferUnavailable/,
    );
    assert.equal(job.items[0].state, "paused");
    manager.command(job.id, "cancel", selected);
    assert(job.items.slice(0, 2).every((i) => i.state === "cancelled"));
    assert.equal(f.store.downloadJobs()[0].items[1].resource.quality, 80);
    await manager.remove(job.id, selected);
    assert.equal(job.items.length, 2);
    assert.equal(job.items[0].resource.aid, 2);
    assert.equal(job.items[0].resource.quality, 64);
    assert.equal(job.items[1].resource.aid, 3);
  } finally {
    await manager.close();
    await f.close();
  }
});

test("media parsing uses approved HTTPS backup addresses when primary is unsupported", () => {
  const stream = {
    url: "https://edge.mcdn.bilivideo.cn:4483/video",
    backup_url: [
      "http://untrusted.test/file",
      "https://edge.bilivideo.com/video",
    ],
    size: 10,
    length: 1000,
  };
  const media = parsePlayback({ timelength: 1000, durl: [stream] });
  assert.equal(media.streams[0].url, "https://edge.bilivideo.com/video");
  assert.throws(
    () =>
      parsePlayback({
        timelength: 1000,
        durl: [{ ...stream, backup_url: ["http://127.0.0.1/private"] }],
      }),
    /captureInvalid/,
  );
});

test("season URLs include a standalone current episode and an explicit series, without following recommendations", async () => {
  const api = new Bilibili(async (url) => {
    const id = Number(new URL(String(url)).searchParams.get("season_id"));
    return response({
      season_id: id,
      title: id === 90 ? "A work" : "A film",
      series: { series_id: 100, series_title: "A family" },
      episodes: [1, 2].map((n) => ({
        ...video(n, 1),
        id: id * 10 + n,
        cid: id * 100 + n,
        title: String(n),
      })),
      seasons: id === 90 ? [{ season_id: 90 }, { season_id: 91 }] : [],
      recommendations: [{ season_id: 999 }],
    });
  });
  const result = await api.discover(
    "https://www.bilibili.com/bangumi/play/ss90",
    signal(),
  );
  assert.equal(result?.current?.episodeId, 901);
  assert.deepEqual(result?.series, [
    {
      id: "pgc-series:100",
      title: "A family",
      groupIds: ["season:90", "season:91"],
    },
  ]);
  assert.equal(result?.groups.length, 2);
});
test("incomplete sibling discovery never advertises a complete downloadable series", async () => {
  const api = new Bilibili(async (url) => {
    const id = Number(new URL(String(url)).searchParams.get("season_id"));
    return id === 91
      ? Response.json({ code: -412 })
      : response({
          season_id: id,
          title: "Work",
          episodes: [{ ...video(1, 1), id: 901, cid: 901 }],
          seasons: [{ season_id: 91 }],
        });
  });
  const result = await api.discover(
    "https://www.bilibili.com/bangumi/play/ss90",
    signal(),
  );
  assert.equal(result?.current?.episodeId, 901);
  assert(result?.collectionError);
  assert.equal(result?.series, undefined);
});
test("series download keeps works in separate folders with per-work episode numbering and persisted grouping", async () => {
  const f = await setup();
  let manager: VideoDownloads | undefined;
  const payload = Buffer.from("synthetic movie payload");
  try {
    manager = new VideoDownloads({
      store: f.store,
      cache: path.join(f.root, "cache"),
      request: async () =>
        new Response(payload, {
          headers: { "content-length": String(payload.length) },
        }),
      resolve: async () => ({
        kind: "segments",
        duration: 1,
        streams: [
          {
            url: "https://fixture.bilivideo.com/v",
            key: "v",
            bytes: payload.length,
          },
        ],
      }),
      mux: async (_media, inputs, output) =>
        writeFile(output, await readFile(inputs[0])),
      target: (...args) => f.storage.target(...args),
      publish: (...args) => f.storage.publish(...args),
      completed: async () => undefined,
      emit: () => {},
    });
    const resources = [resource(1), resource(2), resource(3)];
    const job = await manager.enqueue(
      "A family",
      resources,
      { connectionId: "local", path: f.root },
      true,
      [0],
      [
        { id: "tv", title: "Television", resources: resources.slice(0, 2) },
        { id: "film", title: "Film", resources: resources.slice(2) },
      ],
    );
    await until(() =>
      f.store.downloadJobs()[0]?.items.every((i) => i.state === "completed"),
    );
    const saved = f.store.downloadJobs()[0];
    assert.deepEqual(
      saved.items.map((i) => i.name.slice(0, 3)),
      ["001", "002", "001"],
    );
    assert.deepEqual(
      saved.items.map((i) =>
        path.relative(job.target.path, path.dirname(i.path!)),
      ),
      ["Television", "Television", "Film"],
    );
    for (const item of saved.items)
      assert.deepEqual(await readFile(item.path!), payload);
    assert.equal(saved.groups?.length, 2);
  } finally {
    await manager?.close();
    await f.close();
  }
});
