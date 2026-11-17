import { mkdir, cp } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

export async function checkAutomaticRecognition(app, shell, temporary, base) {
  const root = path.join(temporary, "automatic");
  await mkdir(path.join(root, "Automatic series"), { recursive: true });
  await cp(
    "tests/fixtures/video.webm",
    path.join(root, "Automatic series/01.webm"),
  );
  await app.evaluate(
    ({ protocol, net, dialog }, { root, base }) => {
      // Exercise the real adapters and cache with local HTTP, never public accounts.
      protocol.handle("https", (request) => {
        const url = new URL(request.url);
        if (url.hostname === "api.bilibili.com") {
          if (url.pathname === "/x/frontend/finger/spi")
            return Response.json({ code: 0, data: { b_3: "fixture-visitor" } });
          if (url.pathname === "/x/web-interface/search/type") {
            if (request.headers.get("authorization"))
              return new Response(null, { status: 401 });
            return Response.json({
              code: 0,
              data: {
                result:
                  url.searchParams.get("search_type") === "media_bangumi"
                    ? [{ season_id: 77, title: "Batch series" }]
                    : [],
              },
            });
          }
          return Response.json({
            code: 0,
            result: {
              season_id: 77,
              title: "Batch series",
              evaluate: "Bilibili public synopsis",
              cover: "https://i0.hdslb.com/bfs/bangumi/fixture.jpg",
              styles: ["Animation"],
              episodes: [
                { id: 770, title: "1", long_title: "Bilibili first episode" },
              ],
            },
          });
        }
        if (url.hostname === "i0.hdslb.com") {
          const headers = new Headers({ "content-type": "jpg" });
          return net
            .fetch(`${base}/cover`)
            .then((response) => new Response(response.body, { headers }));
        }
        if (url.hostname === "api.bgm.tv")
          return net.fetch(`${base}/metadata${url.pathname}${url.search}`, {
            method: request.method,
            body: request.method === "POST" ? request.body : undefined,
            duplex: "half",
          });
        if (url.hostname === "lain.bgm.tv") return net.fetch(`${base}/cover`);
        return new Response(null, { status: 403 });
      });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      });
    },
    { root, base },
  );
  const oldSource = await shell.evaluate(async () => {
    const state = await window.tamki.library("state");
    await window.tamki.library("recognition-preferences", {
      automatic: true,
      defaultSourceId: "bangumi",
    });
    const draft = await window.tamki.library("choose-local");
    await window.tamki.library("save-connection", {
      draftId: draft.id,
      type: "local",
      name: "Automatic fixture",
      roots: draft.roots,
      scanDepths: { [draft.roots[0]]: 1 },
    });
    return state.settings.recognition.defaultSourceId;
  });
  for (let attempt = 0; attempt < 300; attempt++) {
    const ready = await shell.evaluate(
      async () =>
        (await window.tamki.library("state")).works.find(
          (w) => w.title === "Automatic series",
        )?.recognition?.status === "complete",
    );
    if (ready) break;
    await shell.waitForTimeout(100);
  }
  const identified = await shell.evaluate(async () => {
    const state = await window.tamki.library("state");
    const work = state.works.find((w) => w.title === "Automatic series");
    if (!work.cover)
      throw new Error(`Missing artwork: ${JSON.stringify(work)}`);
    const cover = await window.tamki.library("cover", work.cover);
    const good = await fetch(cover),
      bad = await fetch(cover.replace(/ticket=.*/, "ticket=invalid"));
    return {
      work,
      imageType: good.headers.get("content-type"),
      imageBytes: (await good.arrayBuffer()).byteLength,
      denied: bad.status,
    };
  });
  assert.equal(
    identified.work.description,
    "Automatically identified work synopsis",
  );
  assert.equal(identified.work.episodes[0].title, "Opening episode");
  assert.equal(
    identified.work.episodes[0].description,
    "Automatically identified episode synopsis",
  );
  assert.equal(identified.work.recognition.candidate, "bangumi:42");
  assert.equal(identified.imageType, "image/png");
  assert(identified.imageBytes > 10);
  assert.equal(identified.denied, 403);
  await shell.evaluate(async (defaultSourceId) => {
    await window.tamki.library("recognition-preferences", {
      automatic: false,
      defaultSourceId,
    });
    await window.tamki.library("refresh");
  }, oldSource);
  await shell.waitForFunction(
    async () => !(await window.tamki.library("state")).refreshing,
  );
  // Exercise the real public adapter, persisted explicit queue and artwork cache
  // over validated IPC while automatic identification remains disabled.
  await mkdir(path.join(root, "Batch series"), { recursive: true });
  await cp(
    "tests/fixtures/video.webm",
    path.join(root, "Batch series/01.webm"),
  );
  await shell.evaluate(() => window.tamki.library("refresh"));
  await shell.waitForFunction(async () => {
    const state = await window.tamki.library("state");
    return (
      !state.refreshing && state.works.some((w) => w.title === "Batch series")
    );
  });
  const batch = await shell.evaluate(async () => {
    await window.tamki.library("recognition-preferences", {
      defaultSourceId: "bilibili",
    });
    const state = await window.tamki.library("state");
    const work = state.works.find((w) => w.title === "Batch series");
    const queued = await window.tamki.library("recognize-batch", {
      workIds: [work.id],
      sourceId: "bilibili",
    });
    return { id: work.id, queued };
  });
  assert.deepEqual(batch.queued.queued, [batch.id]);
  await shell.waitForFunction(
    async (id) =>
      (await window.tamki.library("state")).works.find((w) => w.id === id)
        ?.recognition?.status === "complete",
    batch.id,
  );
  const batchResult = await shell.evaluate(async (id) => {
    const state = await window.tamki.library("state");
    const work = state.works.find((w) => w.id === id);
    const image = await fetch(await window.tamki.library("cover", work.cover));
    return {
      work,
      automatic: state.settings.recognition.automatic,
      imageType: image.headers.get("content-type"),
      bytes: (await image.arrayBuffer()).byteLength,
    };
  }, batch.id);
  assert.equal(batchResult.automatic, false);
  assert.equal(batchResult.work.recognition.requested, true);
  assert.equal(batchResult.work.recognition.sourceId, "bilibili");
  assert.equal(batchResult.work.description, "Bilibili public synopsis");
  assert.equal(batchResult.work.episodes[0].title, "Bilibili first episode");
  assert.equal(batchResult.imageType, "image/png");
  assert(batchResult.bytes > 10);
  const rejected = await shell.evaluate(async () => {
    const errors = [];
    for (const value of [
      { workIds: ["unknown"], sourceId: "bilibili" },
      { workIds: ["unknown"], sourceId: "not-a-source" },
      { workIds: ["duplicate", "duplicate"], sourceId: "bilibili" },
    ])
      try {
        await window.tamki.library("recognize-batch", value);
        errors.push("accepted");
      } catch (e) {
        errors.push(e.message);
      }
    return errors;
  });
  assert(rejected.every((error) => error !== "accepted"));
  await shell.evaluate(
    (defaultSourceId) =>
      window.tamki.library("recognition-preferences", { defaultSourceId }),
    oldSource,
  );
  await app.evaluate(({ protocol }) => protocol.unhandle("https"));
  return identified.work.cover;
}
