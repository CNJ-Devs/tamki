import test from "node:test";
import assert from "node:assert/strict";
import { CapturePlayback } from "../src/capture/playback";
import type { CaptureResource } from "../src/shared/capture";
const resource: CaptureResource = {
  provider: "bilibili",
  id: "bili:1:1",
  title: "Episode",
  aid: 1,
  bvid: "BV0000000001",
  cid: 1,
  duration: 10,
};
test("online playback resolves only captured resources, proxies ranges without credentials, and revokes closed tabs", async () => {
  let received: RequestInit | undefined;
  const playback = new CapturePlayback(
    async () => ({
      kind: "segments",
      duration: 10,
      streams: [{ url: "https://fixture.bilivideo.com/video", key: "a" }],
    }),
    async (_url, init) => {
      received = init;
      return new Response("abc", {
        status: 206,
        headers: { "Content-Range": "bytes 0-2/10" },
      });
    },
  );
  const work = playback.create("Series", [
    resource,
    { ...resource, id: "bili:1:2", cid: 2 },
  ]);
  assert.equal(work.episodes.length, 2);
  await assert.rejects(playback.source("unknown:0"), /mediaMissing/);
  const source = await playback.source(work.episodes[0].id);
  const response = await playback.handle(
    new Request(source.url, {
      headers: { Range: "bytes=0-2", Cookie: "must-not-forward" },
    }),
  );
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "abc");
  assert.equal(received?.credentials, "omit");
  assert.equal((received?.headers as Record<string, string>).Cookie, undefined);
  assert.equal(
    (received?.headers as Record<string, string>).Range,
    "bytes=0-2",
  );
  playback.close(work.id);
  assert.equal((await playback.handle(new Request(source.url))).status, 403);
});
test("DASH manifests contain separate audio/video tracks and media redirects stay on approved hosts", async () => {
  const playback = new CapturePlayback(
    async () => ({
      kind: "dash",
      duration: 10,
      streams: ["video", "audio"].map((kind) => ({
        url: "https://fixture.bilivideo.com/track",
        key: kind,
        dash: {
          mime: `${kind}/mp4`,
          codecs: kind === "video" ? "avc1.640028" : "mp4a.40.2",
          bandwidth: 1000,
          indexRange: "100-200",
          initialization: "0-99",
        },
      })),
    }),
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }),
  );
  const work = playback.create("Episode", [resource]);
  const source = await playback.source(work.episodes[0].id);
  assert.equal(source.dash, true);
  const manifest = await (
    await playback.handle(new Request(source.url))
  ).text();
  assert.match(manifest, /audio\/mp4/);
  assert.match(manifest, /video\/mp4/);
  assert.match(manifest, /indexRange="100-200"/);
  assert.equal(
    (
      await playback.handle(
        new Request(source.url.replace("manifest.mpd", "0")),
      )
    ).status,
    502,
  );
});

test("playing one captured episode preserves every group and resolves only the selected episode/quality", async () => {
  const calls: CaptureResource[] = [];
  const playback = new CapturePlayback(
    async (r) => {
      calls.push(r);
      return {
        kind: "segments",
        duration: 10,
        quality: r.quality || 80,
        qualities: [{ id: 80, label: "1080P" }],
        streams: [{ url: "https://fixture.bilivideo.com/video", key: "a" }],
      };
    },
    async () => new Response("video"),
  );
  const second = { ...resource, id: "second", cid: 2 };
  const third = { ...resource, id: "third", cid: 3 };
  const work = playback.createContext(
    {
      id: "result",
      pageURL: "https://www.bilibili.com/video/BV0000000001",
      current: second,
      groups: [
        { id: "season1", title: "Season 1", resources: [resource, second] },
        { id: "season2", title: "Season 2", resources: [third] },
      ],
    },
    second,
  );
  assert.equal(work.episodes.length, 3);
  assert.equal(work.resumeId, work.episodes[1].id);
  assert.equal(work.playbackGroups?.length, 2);
  assert.deepEqual(
    work.playbackGroups?.[0].episodeIds,
    work.episodes.slice(0, 2).map((e) => e.id),
  );
  assert.equal(calls.length, 0);
  const source = await playback.source(work.resumeId!, 80);
  assert.equal(calls[0].id, "second");
  assert.equal(calls[0].quality, 80);
  assert.equal(source.quality, 80);
  await playback.source(work.episodes[2].id);
  assert.equal(calls[1].id, "third");
  playback.close(work.id);
});
