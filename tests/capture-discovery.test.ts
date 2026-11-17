import test from "node:test";
import assert from "node:assert/strict";
import { Bilibili, biliPage, parsePlayback } from "../src/capture/bilibili";

const entry = (id: number) => ({
  id,
  aid: id,
  bvid: `BV${String(id).padStart(10, "0")}`,
  cid: id * 100,
  title: String(id),
  long_title: "Episode",
  duration: 30000,
});
const video = (id: number) => ({
  ...entry(id),
  title: `Work ${id}`,
  videos: 1,
  pages: [{ cid: id * 100, part: "Part 1", duration: 30 }],
});
const season = (id: number) => ({
  season_id: id,
  title: `Season ${id}`,
  episodes: [entry(id)],
});
const response = (data: unknown) => Response.json({ code: 0, data });
const signal = () => new AbortController().signal;
const adapter = (handle: (url: URL) => Response | Promise<Response>) =>
  new Bilibili((async (url) => handle(new URL(String(url)))) as typeof fetch);

test("discovery entry points validate identities for media, embedded players and list aliases", () => {
  assert.deepEqual(biliPage("https://www.bilibili.com/bangumi/media/md123/"), {
    kind: "season",
    mediaId: 123,
  });
  assert.deepEqual(
    biliPage(
      "https://player.bilibili.com/player.html?bvid=BV0000000001&page=2",
    ),
    { kind: "video", bvid: "BV0000000001", part: 2 },
  );
  assert.deepEqual(biliPage("https://player.bilibili.com/player.html?aid=17"), {
    kind: "video",
    aid: 17,
    part: 1,
  });
  assert.equal(
    biliPage("https://space.bilibili.com/10/lists/20/?business=space_series")
      ?.kind,
    "collection",
  );
  assert.deepEqual(
    biliPage(
      "https://www.bilibili.com/medialist/detail/10?business=space_series&business_id=20",
    ),
    { kind: "collection", owner: 10, collection: 20, series: true },
  );
  for (const url of [
    "https://www.bilibili.com/bangumi/play/ep0",
    "https://www.bilibili.com/bangumi/media/md9007199254740993",
    "https://www.bilibili.com/video/av0",
    "https://space.bilibili.com/0/lists/20",
    "https://space.bilibili.com/10/lists/0",
    "https://player.bilibili.com/player.html?aid=-1",
    "https://player.bilibili.com/other.html?aid=17",
    "https://player.bilibili.com.evil.test/player.html?aid=17",
  ])
    assert.equal(biliPage(url), undefined, url);
});

test("media details map to the season using platform metadata before discovering episodes", async () => {
  const calls: string[] = [];
  const bili = adapter((url) => {
    calls.push(url.pathname);
    if (url.pathname === "/pgc/review/user") {
      assert.equal(url.searchParams.get("media_id"), "17");
      return response({ media: { season_id: 7 } });
    }
    assert.equal(url.searchParams.get("season_id"), "7");
    return response(season(7));
  });
  const result = await bili.discover(
    "https://www.bilibili.com/bangumi/media/md17",
    signal(),
  );
  assert.equal(result?.current?.episodeId, 7);
  assert.deepEqual(calls, ["/pgc/review/user", "/pgc/view/web/season"]);
});

test("BV-to-PGC mapping discovers the actual episode and season rather than using UGC playback", async () => {
  const calls: string[] = [];
  const bili = adapter((url) => {
    calls.push(url.pathname);
    if (url.pathname === "/x/web-interface/view")
      return response({ redirect_url: "/bangumi/play/ep7" });
    assert.equal(url.searchParams.get("ep_id"), "7");
    return response(season(7));
  });
  const result = await bili.discover(
    "https://www.bilibili.com/video/BV0000000007",
    signal(),
  );
  assert.equal(result?.current?.episodeId, 7);
  assert.equal(result?.groups[0].id, "season:7");
  assert.equal(calls.length, 2);
  const untrusted = adapter(() =>
    response({
      ...video(7),
      redirect_url: "https://evil.test/bangumi/play/ep8",
    }),
  );
  assert.equal(
    (await untrusted.discover("https://www.bilibili.com/video/av7", signal()))
      ?.current?.episodeId,
    undefined,
  );
});

test("PGC sections retain the current extra and platform grouping, deduplicate identities and include extras in a work's union", async () => {
  const bili = adapter(() =>
    response({
      ...season(7),
      section: [
        { id: 1, title: "Extras", episodes: [entry(7), entry(8), entry(8)] },
        { id: 2, title: "Behind the scenes", episodes: [entry(9)] },
      ],
    }),
  );
  const result = await bili.discover(
    "https://www.bilibili.com/bangumi/play/ep8",
    signal(),
  );
  assert.equal(result?.current?.episodeId, 8);
  assert.deepEqual(
    result?.groups[0].resources.map((r) => r.episodeId),
    [7, 8, 9],
  );
  assert.deepEqual(
    result?.groups[0].sections?.map((s) => [s.title, s.resources.length]),
    [
      ["Extras", 1],
      ["Behind the scenes", 1],
    ],
  );
  assert.equal(result?.collectionError, undefined);
});

test("malformed PGC entries retain verified videos but block partial work/series batch actions", async () => {
  const bili = adapter((url) => {
    const id = Number(url.searchParams.get("season_id") || 7);
    return response({
      ...season(id),
      seasons: [{ season_id: 8 }],
      ...(id === 7
        ? {
            section: [
              {
                id: 1,
                title: "Extras",
                episodes: [entry(9), { id: 10, title: "Unavailable" }],
              },
            ],
          }
        : {}),
    });
  });
  const result = await bili.discover(
    "https://www.bilibili.com/bangumi/play/ep7",
    signal(),
  );
  assert.equal(result?.current?.episodeId, 7);
  assert.equal(result?.groups.length, 2);
  assert.equal(result?.groups[0].resources.length, 2);
  assert.equal(result?.groups[0].incomplete, true);
  assert.equal(result?.groups[0].sections?.[0].incomplete, true);
  assert.equal(result?.collectionError, "captureIncomplete");
  assert.equal(result?.series, undefined);
});

test("an unreturned explicit episode is never replaced with a different current episode", async () => {
  const result = await adapter(() => response(season(7))).discover(
    "https://www.bilibili.com/bangumi/play/ep123",
    signal(),
  );
  assert.equal(result?.current, undefined);
  assert.equal(result?.groups[0].resources.length, 1);
  assert.equal(result?.collectionError, "captureIncomplete");
});

test("a season with only supplemental sections still identifies its current episode", async () => {
  const result = await adapter(() =>
    response({
      season_id: 7,
      title: "Work",
      section: [{ id: 1, title: "Extras", episodes: [entry(8)] }],
    }),
  ).discover("https://www.bilibili.com/bangumi/play/ep8", signal());
  assert.equal(result?.current?.episodeId, 8);
  assert.equal(result?.groups[0].sections?.length, 1);
  assert.equal(result?.collectionError, undefined);
});

test("invalid related-season identities prevent a falsely complete combined series", async () => {
  const result = await adapter((url) =>
    response({
      ...season(Number(url.searchParams.get("season_id")) || 7),
      seasons: [{ season_id: 7 }, { season_id: 8 }, { season_id: 0 }],
    }),
  ).discover("https://www.bilibili.com/bangumi/play/ep7", signal());
  assert.equal(result?.groups.length, 2);
  assert.equal(result?.collectionError, "captureIncomplete");
  assert.equal(result?.series, undefined);
});

test("missing or truncated multipart metadata uses pagelist and refuses inconsistent counts or duplicate CIDs", async () => {
  for (const pages of [undefined, [{ cid: 100, part: "First" }]]) {
    const bili = adapter((url) =>
      response(
        url.pathname.endsWith("pagelist")
          ? [
              { cid: 100, part: "First" },
              { cid: 101, part: "Second" },
            ]
          : { ...video(1), videos: 2, pages },
      ),
    );
    const result = await bili.discover(
      "https://www.bilibili.com/video/av1?p=2",
      signal(),
    );
    assert.equal(result?.current?.cid, 101);
    assert.equal(result?.groups[0].resources.length, 2);
  }
  for (const pages of [[{ cid: 100 }], [{ cid: 100 }, { cid: 100 }]]) {
    const bili = adapter((url) =>
      response(
        url.pathname.endsWith("pagelist")
          ? pages
          : { ...video(1), videos: 2, pages: [] },
      ),
    );
    await assert.rejects(
      bili.discover("https://www.bilibili.com/video/av1", signal()),
      /captureIncomplete/,
    );
  }
});

test("collection play URLs retain the selected video and reject totals that change during pagination", async () => {
  const bili = adapter((url) =>
    response(
      url.pathname.endsWith("view")
        ? video(Number(url.searchParams.get("aid")))
        : {
            archives: [{ aid: 1 }, { aid: 2 }],
            page: { total: 2 },
            meta: { name: "Collection" },
          },
    ),
  );
  const result = await bili.discover(
    "https://www.bilibili.com/medialist/play/10?business=space_collection&business_id=20&oid=2",
    signal(),
  );
  assert.equal(result?.current?.aid, 2);
  const changing = adapter((url) =>
    response(
      url.searchParams.get("page_num") === "1"
        ? { archives: [{ aid: 1 }], page: { total: 3 } }
        : { archives: [{ aid: 2 }], page: { total: 2 } },
    ),
  );
  await assert.rejects(
    changing.discover("https://space.bilibili.com/10/lists/20", signal()),
    /captureIncomplete/,
  );
});

test("interactive video capture warns about untraversed branches rather than offering a full-video batch", async () => {
  const bili = adapter(() =>
    response({ ...video(1), rights: { is_stein_gate: 1 } }),
  );
  const result = await bili.discover(
    "https://www.bilibili.com/video/av1",
    signal(),
  );
  assert.equal(result?.current?.cid, 100);
  assert.deepEqual(result?.groups, []);
  assert.equal(result?.collectionError, "captureInteractive");
});

test("all supported preview markers refuse a short trial stream as a full download", () => {
  for (const flags of [
    { is_ugc_pay_preview: true },
    { play_video_type: "preview" },
    { play_check: { play_detail: "PLAY_PREVIEW" } },
  ]) {
    assert.throws(
      () =>
        parsePlayback({
          ...flags,
          timelength: 1000,
          durl: [{ url: "https://media.bilivideo.com/trial.mp4" }],
        }),
      /captureRestricted/,
    );
  }
});
