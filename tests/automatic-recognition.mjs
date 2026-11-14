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
  await app.evaluate(({ protocol }) => protocol.unhandle("https"));
  return identified.work.cover;
}
