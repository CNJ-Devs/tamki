// Isolated hidden Electron window; all site/API/media requests are local fixtures.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

// Seed via an isolated TS process, never the real user's profile.
const temp = await realpath(
  await mkdtemp(path.join(tmpdir(), "tamki-capture-browser-")),
);
const profile = path.join(temp, "profile"),
  destination = path.join(temp, "saved");
await mkdir(profile);
await mkdir(destination);
const seed = `const {LibraryStore}=require('./src/library/store.ts');const {defaultSettings}=require('./src/shared/settings.ts');const store=new LibraryStore(process.argv[1],'en');store.saveConnection({id:'local',type:'local',name:'Local storage',roots:[process.argv[2]],status:'connected',error:null,scannedAt:null});const settings=defaultSettings('en');settings.recognition.automatic=false;settings.downloads.series.fixed={connectionId:'local',path:process.argv[2]};settings.downloads.series.mode='fixed';settings.downloads.video.fixed={connectionId:'local',path:process.argv[2]};settings.downloads.video.mode='fixed';store.setConfig('settings',JSON.stringify(settings));store.close();`;
execFileSync(process.execPath, [
  "--import",
  "tsx",
  "-e",
  seed,
  path.join(profile, "library.sqlite"),
  destination,
]);
const media = path.join(temp, "source.mp4");
execFileSync(ffmpeg, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=160x90:d=0.3",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-an",
  media,
]);
const bytes = (await readFile(media)).toString("base64");
const dashFixture = { streams: [], tracks: [] };
for (const kind of ["video", "audio"]) {
  const track = path.join(temp, `${kind}.mp4`);
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    kind === "video"
      ? "color=c=blue:s=160x90:r=24:d=2"
      : "sine=frequency=440:duration=2",
    ...(kind === "video"
      ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-an"]
      : ["-c:a", "aac", "-vn"]),
    "-movflags",
    "+dash+global_sidx+frag_keyframe+empty_moov",
    track,
  ]);
  const data = await readFile(track);
  let offset = 0,
    index;
  while (offset + 8 <= data.length) {
    const size = data.readUInt32BE(offset),
      type = data.toString("ascii", offset + 4, offset + 8);
    if (type === "sidx") {
      index = [offset, offset + size - 1];
      break;
    }
    if (size < 8) break;
    offset += size;
  }
  assert(index);
  dashFixture.tracks.push(data.toString("base64"));
  dashFixture.streams.push({
    id: kind === "video" ? 80 : 30280,
    codecid: 7,
    baseUrl: `https://fixture.bilivideo.com/${kind}.mp4`,
    mimeType: `${kind}/mp4`,
    codecs: kind === "video" ? "avc1.64000A" : "mp4a.40.2",
    bandwidth: 100000,
    SegmentBase: {
      Initialization: `0-${index[0] - 1}`,
      indexRange: index.join("-"),
    },
  });
}

let app;
const errors = [];
// Playwright's waitForFunction treats a returned Promise as truthy before its
// boolean resolves. Poll awaited IPC results from Node instead.
async function waitForAsync(page, predicate, arg = null, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!(await page.evaluate(predicate, arg))) {
    if (Date.now() >= end) throw new Error("Timed out waiting for IPC state");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function settlePanel(page) {
  await page.mouse.move(24, 24);
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}
try {
  app = await electron.launch({
    executablePath: process.env.TAMKI_CAPTURE_EXECUTABLE,
    args: process.env.TAMKI_CAPTURE_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      TAMKI_TEST_PROFILE: profile,
      TAMKI_BACKGROUND_TEST: "1",
    },
    timeout: 30000,
  });
  const shell = await app.firstWindow();
  shell.on("pageerror", (e) => errors.push(e.message));
  await shell.waitForFunction(() => window.tamki);
  await shell.locator(".page-header").waitFor();
  await app.evaluate(({ session }, bytes) => {
    session.defaultSession.protocol.handle("https", async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "i0.hdslb.com" && url.pathname.startsWith("/bfs/")) {
        globalThis.__artworkRequests = (globalThis.__artworkRequests || 0) + 1;
        return new Response(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWsAAAAASUVORK5CYII=",
            "base64",
          ),
          { headers: { "content-type": "image/png" } },
        );
      }
      return new Response(null, { status: 404 });
    });
    session
      .fromPartition("persist:tamki-browser")
      .protocol.handle("https", async (request) => {
        const u = new URL(request.url);
        if (u.hostname === "www.bilibili.com")
          return new Response(
            '<!doctype html><title>Fixture site</title><h1>Public video</h1><input id="site-input">' +
              (globalThis.__capturePgc
                ? '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"episode_info":{"ep_id":9002,"cid":602}}}}</script>'
                : ""),
            { headers: { "content-type": "text/html" } },
          );
        if (u.hostname === "api.bilibili.com") {
          if (
            globalThis.__capturePgc &&
            u.pathname === "/pgc/view/web/season"
          ) {
            const id = Number(u.searchParams.get("season_id") || 835);
            const main = id === 835;
            return Response.json({
              code: 0,
              result: {
                season_id: id,
                title: main ? "Fixture television" : "Fixture film",
                evaluate: main
                  ? "Television synopsis from Bilibili"
                  : "Film synopsis from Bilibili",
                cover: `http://i0.hdslb.com/bfs/bangumi/${id}.png`,
                styles: ["Animation"],
                series: { series_id: 528, series_title: "Fixture family" },
                episodes: (main ? [1, 2] : [3]).map((n) => ({
                  id: n === 3 ? 9101 : 9000 + n,
                  aid: 100 + n,
                  bvid: "BV" + String(100 + n).padStart(10, "0"),
                  cid: 600 + n,
                  title: String(n),
                  long_title: "Episode " + n,
                  duration: 2000,
                  cover: `http://i0.hdslb.com/bfs/archive/${n}.png`,
                })),
                section:
                  main && globalThis.__capturePgcExtras
                    ? [
                        {
                          id: 44,
                          title: "Extras",
                          episodes: [
                            {
                              id: 9004,
                              aid: 104,
                              bvid: "BV0000000104",
                              cid: 604,
                              title: "Extra",
                              long_title: "Behind the scenes",
                              duration: 2000,
                            },
                            ...(globalThis.__capturePgcBroken
                              ? [{ id: 9005, title: "Unavailable" }]
                              : []),
                          ],
                        },
                      ]
                    : [],
                seasons: [
                  { season_id: 835, season_title: "TV" },
                  { season_id: 3441, season_title: "Film" },
                ],
              },
            });
          }

          if (u.pathname.includes("playurl") && globalThis.__slowDownload)
            await new Promise((resolve) => setTimeout(resolve, 3000));
          const data = u.pathname.includes("playurl")
            ? {
                quality: 32,
                has_paid: false,
                timelength: 300,
                durl: [
                  {
                    url: "https://fixture.bilivideo.com/sample.mp4",
                    size: Buffer.from(bytes, "base64").length,
                    length: 300,
                  },
                ],
              }
            : {
                aid: 1,
                bvid: "BV0000000001",
                title: "Fixture series",
                owner: { mid: 1 },
                pages: [1, 2].map((n) => ({
                  cid: 100 + n,
                  page: n,
                  part: "Episode " + n,
                  duration: 0.3,
                })),
              };
          if (u.pathname.includes("playurl") && globalThis.__captureDash)
            return Response.json({
              code: 0,
              data: {
                timelength: 2000,
                quality: 80,
                has_paid: false,
                dash: {
                  video: [globalThis.__captureDash.streams[0]],
                  audio: [globalThis.__captureDash.streams[1]],
                },
              },
            });
          return Response.json({ code: 0, data });
        }
        if (u.hostname === "fixture.bilivideo.com") {
          const fixture = globalThis.__captureDash;
          const body = Buffer.from(
            fixture && /\/(video|audio)\.mp4$/.test(u.pathname)
              ? fixture.tracks[u.pathname.includes("audio") ? 1 : 0]
              : bytes,
            "base64",
          );
          const range = request.headers.get("range");
          const start = range ? Number(range.match(/\d+/)[0]) : 0;
          const end =
            range && /-(\d+)$/.test(range)
              ? Math.min(body.length - 1, Number(range.match(/-(\d+)$/)[1]))
              : body.length - 1;
          return new Response(body.subarray(start, end + 1), {
            status: range ? 206 : 200,
            headers: {
              "content-type": "video/mp4",
              "content-length": String(end + 1 - start),
              ...(range
                ? {
                    "content-range": `bytes ${start}-${end}/${body.length}`,
                  }
                : {}),
            },
          });
        }
        return new Response("Blocked fixture request", { status: 403 });
      });
  }, bytes);
  await shell.evaluate(async () => {
    await window.tamki.action("new");
    await window.tamki.action(
      "navigate",
      "https://www.bilibili.com/video/BV0000000001/?p=2",
    );
  });
  const findPage = async (predicate) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      for (const p of app.context().pages()) if (await predicate(p)) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Capture page not found");
  };
  const reel = await findPage(
    async (p) =>
      p.url().includes("/capture.html") &&
      (await p.locator(".capture-reel").count()) > 0,
  );
  const panel = await findPage(
    async (p) => p !== reel && p.url().includes("/capture.html"),
  );
  reel.on("pageerror", (e) => errors.push(e.message));
  panel.on("pageerror", (e) => errors.push(e.message));
  await reel.getByRole("button", { name: "Page videos", exact: true }).hover();
  await panel
    .getByText("Fixture series · Episode 2", { exact: true })
    .first()
    .waitFor();
  await panel.getByRole("button", { name: "Expand episodes" }).click();
  await panel
    .getByText("Fixture series · Episode 1", { exact: true })
    .waitFor();
  await mkdir("test-results", { recursive: true });
  await panel.waitForTimeout(350);
  await panel.screenshot({
    path: "test-results/capture-menu.png",
    omitBackground: true,
  });
  // Main remote pages remain sandboxed and cannot invoke either local bridge.
  const web = await findPage(async (p) =>
    p.url().startsWith("https://www.bilibili.com/"),
  );
  assert.deepEqual(
    await web.evaluate(() => [
      typeof window.tamki,
      typeof window.tamkiCapture,
      typeof process,
      typeof require,
    ]),
    ["undefined", "undefined", "undefined", "undefined"],
  );
  const oldSnapshot = await panel.evaluate(
    async () => (await window.tamkiCapture.action("state")).snapshot.result.id,
  );
  await panel
    .getByRole("button", { name: "Download all", exact: true })
    .click();
  await panel
    .getByRole("dialog", { name: "Download all", exact: true })
    .waitFor();
  await panel.waitForTimeout(350);
  await panel.getByRole("dialog").screenshot({
    path: "test-results/capture-download.png",
    omitBackground: true,
  });

  await panel.getByRole("button", { name: "480P", exact: true }).click();
  const formHeight = await panel
    .getByRole("dialog")
    .evaluate((el) => el.getBoundingClientRect().height);
  await panel.getByRole("button", { name: destination, exact: true }).click();
  await panel
    .getByRole("button", { name: "Use this folder", exact: true })
    .waitFor();
  const folderHeight = await panel
    .getByRole("dialog")
    .evaluate((el) => el.getBoundingClientRect().height);
  assert(Math.abs(folderHeight - formHeight) < 1);
  await panel
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await app.evaluate(() => {
    globalThis.__slowDownload = true;
  });
  await panel
    .getByRole("button", { name: "Download 2 videos", exact: true })
    .click();
  await shell.evaluate(() => window.tamki.action("tasks-open"));
  const controls = await findPage(async (page) =>
    page.url().includes("tab-picker.html"),
  );
  await controls.getByRole("button", { name: "Pause", exact: true }).click();
  await controls
    .getByRole("button", { name: "Resume task", exact: true })
    .waitFor();
  assert(
    (
      await shell.evaluate(() => window.tamki.library("state"))
    ).videoDownloads[0].items.every((i) => i.state === "paused"),
  );
  await controls
    .getByRole("button", { name: "Expand task", exact: true })
    .click();
  await controls
    .locator(".download-task-item")
    .first()
    .getByRole("button", { name: "Resume task", exact: true })
    .click();
  await controls
    .locator(".download-task-item")
    .first()
    .getByRole("button", { name: "Pause", exact: true })
    .waitFor();
  await controls
    .locator(".download-task-item")
    .first()
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await controls
    .locator(".download-task-item")
    .first()
    .getByRole("button", { name: "Resume task", exact: true })
    .waitFor();
  await app.evaluate(() => {
    globalThis.__slowDownload = false;
  });
  await controls
    .getByRole("button", { name: "Resume task", exact: true })
    .first()
    .click();
  await shell.evaluate(() => window.tamki.action("tabs-dismiss"));
  for (let attempt = 0; attempt < 200; attempt++) {
    const s = await shell.evaluate(() => window.tamki.library("state"));
    if (
      s.videoDownloads?.[0]?.items.every(
        (i) => i.state === "completed" && i.episodeId,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = await shell.evaluate(() => window.tamki.library("state"));
  assert(
    state.videoDownloads[0].items.every(
      (i) => i.state === "completed" && i.episodeId,
    ),
    JSON.stringify(
      state.videoDownloads[0].items.map((i) => ({
        state: i.state,
        error: i.error,
      })),
    ),
  );
  assert.equal(state.videoDownloads[0].items.length, 2);
  assert(
    state.videoDownloads[0].items.every(
      (item) => item.quality === 32 && item.qualityLabel === "480P",
    ),
  );
  assert.equal(state.works.length, 1);
  assert.equal(state.works[0].episodes.length, 2);
  for (const item of state.videoDownloads[0].items) {
    assert(item.path.startsWith(destination + "/Fixture series/"));
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      item.path,
      "-f",
      "null",
      "-",
    ]);
  }
  assert.equal(
    await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].contentView.children.some(
        (v) =>
          v.webContents?.getURL().endsWith("/capture.html") &&
          v.getBounds().width === 56 &&
          v.getVisible(),
      ),
    ),
    true,
  );
  await shell.evaluate(() => window.tamki.action("select", 0));
  await shell
    .locator(".home-content")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await shell
    .locator(".video-task")
    .getByText("Fixture series", { exact: true })
    .waitFor();
  await shell.getByRole("button", { name: "Expand task", exact: true }).click();
  await shell.waitForTimeout(250);
  assert.equal(
    await shell
      .getByRole("button", { name: "Play video", exact: true })
      .count(),
    3,
  );
  await shell.screenshot({ path: "test-results/capture-tasks.png" });
  // Narrow/dark surfaces and stale page selections retain the same trusted boundary.
  await shell.evaluate(async () => {
    const s = await window.tamki.library("state");
    await window.tamki.library("preferences", {
      ...s.preferences,
      mode: "dark",
    });
    await window.tamki.action("select", 1);
  });
  await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0].setSize(680, 560),
  );
  await reel.getByRole("button", { name: "Page videos", exact: true }).click();
  await panel
    .getByRole("button", { name: "Download all", exact: true })
    .click();
  await panel
    .getByRole("dialog", { name: "Download all", exact: true })
    .waitFor();
  await panel.waitForTimeout(250);
  const fitting = await panel.getByRole("dialog").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.left >= 0 &&
      r.right <= innerWidth &&
      r.top >= 0 &&
      r.bottom <= innerHeight
    );
  });
  assert(fitting);
  await panel.getByRole("dialog").screenshot({
    path: "test-results/capture-download-dark-narrow.png",
    omitBackground: true,
  });
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await shell.evaluate(() =>
    window.tamki.action("navigate", "https://example.test/unsupported"),
  );
  assert.equal(
    await panel.evaluate(async (resultId) => {
      try {
        await window.tamkiCapture.action("prepare", {
          resultId,
          groupId: "parts:1",
        });
        return false;
      } catch (e) {
        return e.message === "captureChanged";
      }
    }, oldSnapshot),
    true,
  );
  // Online playback uses actual fragmented audio/video MP4 tracks through DASH.
  await app.evaluate((_electron, fixture) => {
    globalThis.__captureDash = fixture;
  }, dashFixture);
  // Online playback uses the same player, without creating a download task.
  await shell.evaluate(() =>
    window.tamki.action(
      "navigate",
      "https://www.bilibili.com/video/BV0000000001/?p=2",
    ),
  );
  await reel.getByRole("button", { name: "Page videos", exact: true }).click();
  await panel
    .getByRole("button", { name: "Play", exact: true })
    .first()
    .click();
  await shell.waitForFunction(() => {
    const video = document.querySelector(".player video");
    return video && Number.isFinite(video.duration) && video.duration > 0;
  });
  await shell.waitForFunction(() => {
    const video = document.querySelector(".player video");
    if (!video || video.readyState < 2) return false;
    const stream = video.captureStream();
    const audio = stream.getAudioTracks().length;
    stream.getTracks().forEach((track) => track.stop());
    return audio > 0;
  });
  const browser = await shell.evaluate(() => window.tamki.action("state"));
  assert(browser.tabs.some((tab) => tab.onlineWork));
  assert.equal(
    (await shell.evaluate(() => window.tamki.library("state"))).videoDownloads
      .length,
    1,
  );
  await shell.evaluate(() => window.tamki.action("tasks-open"));
  const quick = await findPage(async (page) =>
    page.url().includes("tab-picker.html"),
  );
  await quick.getByRole("button", { name: "View all tasks" }).waitFor();
  await quick.getByText("Fixture series", { exact: true }).waitFor();
  const expand = quick.getByRole("button", {
    name: "Expand task",
    exact: true,
  });
  if (await expand.count()) await expand.click();
  await quick.locator(".download-task-item").first().waitFor();
  assert.equal(await quick.locator(".download-task-item").count(), 2);
  assert.match(
    await quick.locator(".download-task-progress").first().innerText(),
    /Completed.*2\/2/s,
  );
  const toolbar = await shell.locator(".browser-actions").evaluate((el) => ({
    gap: getComputedStyle(el).gap,
    buttons: [...el.querySelectorAll("button")].map((b) => ({
      label: b.getAttribute("aria-label"),
      width: b.getBoundingClientRect().width,
      height: b.getBoundingClientRect().height,
      icon: b.querySelector("svg").getBoundingClientRect().width,
    })),
  }));
  assert.equal(toolbar.gap, "4px");
  assert.deepEqual(
    toolbar.buttons.map((b) => b.label),
    ["Search tabs", "Browsing history", "Tasks"],
  );
  for (const button of toolbar.buttons) {
    assert.equal(button.width, 32);
    assert.equal(button.height, 32);
    assert.equal(button.icon, 16);
  }
  assert.equal(
    await shell
      .locator('.browser-actions button[aria-expanded="true"]')
      .getAttribute("aria-label"),
    "Tasks",
  );
  assert.equal(
    await quick
      .getByRole("button", { name: "Play video", exact: true })
      .count(),
    3,
  );
  await quick
    .locator(".download-task-item")
    .last()
    .getByRole("button", { name: "Play video", exact: true })
    .click();
  await shell.waitForFunction(
    (episodeId) =>
      [...document.querySelectorAll(".player video")].some((video) =>
        video
          .getAttribute("src")
          ?.startsWith(`tamki-media://video/${episodeId}?`),
      ),
    state.videoDownloads[0].items.at(-1).episodeId,
  );
  const localPlayer = await shell.evaluate(() => window.tamki.action("state"));
  assert(
    localPlayer.tabs.some(
      (tab) =>
        tab.id === localPlayer.active &&
        tab.workId === state.works[0].id &&
        !tab.onlineWork &&
        tab.kind === "player",
    ),
  );
  await shell
    .locator(".browser-actions")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await quick.getByRole("button", { name: "View all tasks" }).waitFor();
  await quick.waitForTimeout(350);
  await quick.screenshot({ path: "test-results/capture-quick-tasks.png" });
  await shell
    .locator(".browser-actions")
    .getByRole("button", { name: "Browsing history", exact: true })
    .click();
  await quick.getByRole("dialog", { name: "Browsing history" }).waitFor();
  assert.equal(
    await shell
      .locator('.browser-actions button[aria-expanded="true"]')
      .getAttribute("aria-label"),
    "Browsing history",
  );
  await shell
    .locator(".browser-actions")
    .getByRole("button", { name: "Browsing history", exact: true })
    .click();
  assert.equal(
    (await shell.evaluate(() => window.tamki.action("state"))).pickerOpen,
    false,
  );
  await shell
    .locator(".browser-actions")
    .getByRole("button", { name: "Browsing history", exact: true })
    .click();
  assert(
    (await quick.evaluate(() => window.tamkiTabs.action("state"))).history
      .length > 0,
  );
  await shell.evaluate(() => window.tamki.action("tabs-dismiss"));
  await shell
    .locator(".browser-actions")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await quick
    .getByRole("button", { name: "Remove task", exact: true })
    .first()
    .click();
  await quick
    .getByRole("alertdialog", { name: "Remove task", exact: true })
    .getByRole("button", { name: "Remove task", exact: true })
    .click();
  await waitForAsync(
    shell,
    async () =>
      (await window.tamki.library("state")).videoDownloads.length === 0,
  );
  const retained = await shell.evaluate(() => window.tamki.library("state"));
  assert(
    retained.works.length > 0,
    "Removing task records must retain library entries",
  );
  for (const item of state.videoDownloads[0].items)
    assert((await readFile(item.path)).length > 0);
  // A season URL still identifies the active video from the remote page's public player IDs.
  await app.evaluate(() => {
    globalThis.__capturePgc = true;
  });
  const webId = (
    await shell.evaluate(() => window.tamki.action("state"))
  ).tabs.find((t) => t.kind === "web").id;
  await shell.evaluate(async (id) => {
    await window.tamki.action("select", id);
    await window.tamki.action(
      "navigate",
      "https://www.bilibili.com/bangumi/play/ss835",
    );
  }, webId);
  await reel.getByRole("button", { name: "Page videos", exact: true }).click();
  await waitForAsync(panel, async () => {
    const r = (await window.tamkiCapture.action("state")).snapshot.result;
    return r?.current?.episodeId === 9002 && r.series?.length === 1;
  });
  assert.equal(
    await panel.locator(".capture-menu-content > .capture-group").count(),
    3,
  );
  await panel
    .getByRole("button", { name: "Download current video", exact: true })
    .waitFor();
  const seriesEntry = panel.locator(".capture-series");
  assert.match(await seriesEntry.innerText(), /2 works.*3 episodes/);
  await settlePanel(panel);
  await panel.screenshot({
    path: "test-results/capture-series-levels.png",
    omitBackground: true,
  });
  await seriesEntry
    .getByRole("button", { name: "Expand series", exact: true })
    .click();
  assert.equal(
    await seriesEntry.locator(".capture-items > .capture-group").count(),
    2,
  );
  await seriesEntry
    .getByRole("button", { name: "Play", exact: true })
    .first()
    .click();
  await waitForAsync(shell, async () => {
    const state = await window.tamki.action("state");
    return state.tabs.some(
      (t) =>
        t.onlineWork?.title === "Fixture family" &&
        t.onlineWork.playbackGroups?.length === 2 &&
        t.onlineWork.episodes.length === 3,
    );
  });
  await shell.evaluate((id) => window.tamki.action("select", id), webId);
  await reel.getByRole("button", { name: "Page videos", exact: true }).click();
  await panel
    .getByRole("button", { name: "Download series", exact: true })
    .click();
  const familyForm = panel.getByRole("dialog", {
    name: "Download all",
    exact: true,
  });
  await familyForm.waitFor();
  assert.equal(
    await familyForm.locator(".capture-download-hierarchy > div").count(),
    2,
  );
  await familyForm.locator("#capture-name").fill("Fixture family download");
  await settlePanel(panel);
  await familyForm.screenshot({
    path: "test-results/capture-series-download.png",
  });
  await familyForm
    .getByRole("button", { name: "Download 3 videos", exact: true })
    .click();
  await waitForAsync(
    shell,
    async () => {
      const state = await window.tamki.library("state");
      const job = state.videoDownloads.find(
        (j) => j.name === "Fixture family download",
      );
      return (
        job?.items.length === 3 &&
        job.items.every((i) => i.state === "completed" && i.episodeId) &&
        job.librarySeriesCreated
      );
    },
    null,
    30000,
  );
  const familyState = await shell.evaluate(() => window.tamki.library("state"));
  const familyJob = familyState.videoDownloads.find(
    (j) => j.name === "Fixture family download",
  );
  assert.equal(familyJob.groups.length, 2);
  assert.equal(
    new Set(familyJob.items.map((i) => path.dirname(i.path))).size,
    2,
  );
  assert.equal(
    familyState.series.find((s) => s.id === familyJob.id).workIds.length,
    2,
  );
  assert.deepEqual(
    familyJob.items.map((i) => i.name.slice(0, 3)),
    ["001", "002", "001"],
  );
  assert.equal(
    familyJob.groups[0].metadata.description,
    "Television synopsis from Bilibili",
  );
  await waitForAsync(shell, async () => {
    const state = await window.tamki.library("state");
    const works = state.works.filter((w) =>
      w.captureSource?.id.startsWith("bilibili:season:"),
    );
    return (
      works.length === 2 &&
      works.every((w) => !!w.cover && w.episodes.every((e) => !!e.cover))
    );
  });
  const imported = (
    await shell.evaluate(() => window.tamki.library("state"))
  ).works.filter((w) => w.captureSource?.id.startsWith("bilibili:season:"));
  assert.deepEqual(imported.map((w) => w.title).sort(), [
    "Fixture film",
    "Fixture television",
  ]);
  assert(
    imported.every(
      (w) =>
        w.description &&
        w.tags.includes("Animation") &&
        w.recognition.sourceId === "bilibili" &&
        w.recognition.status === "complete",
    ),
  );
  assert.equal(imported.flatMap((w) => w.episodes).length, 3);
  assert.equal(await app.evaluate(() => globalThis.__artworkRequests), 5);
  await app.evaluate(() => {
    globalThis.__capturePgcExtras = true;
  });
  await shell.evaluate(async (id) => {
    await window.tamki.action("select", id);
    await window.tamki.action(
      "navigate",
      "https://www.bilibili.com/bangumi/play/ep9004",
    );
  }, webId);
  await reel.getByRole("button", { name: "Page videos", exact: true }).click();
  await waitForAsync(panel, async () => {
    const r = (await window.tamkiCapture.action("state")).snapshot.result;
    return r?.current?.episodeId === 9004 && r.groups[0].sections?.length === 1;
  });
  const work = panel.locator(".capture-menu-content > .capture-group").first();
  await work
    .getByRole("button", { name: "Expand episodes", exact: true })
    .click();
  const extras = work.locator(".capture-items > .capture-group");
  assert.match(await extras.innerText(), /Extras/);
  await extras
    .getByRole("button", { name: "Expand episodes", exact: true })
    .click();
  assert.match(await extras.innerText(), /Behind the scenes/);
  await settlePanel(panel);
  await panel.screenshot({
    path: "test-results/capture-sections.png",
    omitBackground: true,
  });
  await extras
    .getByRole("button", { name: "Download all", exact: true })
    .click();
  await panel
    .getByRole("dialog", { name: "Download all", exact: true })
    .waitFor();
  assert.equal(
    (await panel.evaluate(() => window.tamkiCapture.action("state"))).draft
      .count,
    1,
  );
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await app.evaluate(() => {
    globalThis.__capturePgcBroken = true;
  });
  await shell.evaluate(() =>
    window.tamki.action(
      "navigate",
      "https://www.bilibili.com/bangumi/play/ep9004?fixture=broken",
    ),
  );
  await reel.getByRole("button", { name: "Page videos", exact: true }).click();
  await waitForAsync(
    panel,
    async () =>
      (await window.tamkiCapture.action("state")).snapshot.result
        ?.collectionError === "captureIncomplete",
  );
  const brokenWork = panel
    .locator(".capture-menu-content > .capture-group")
    .first();
  assert(
    await brokenWork
      .getByRole("button", { name: "Download all", exact: true })
      .isDisabled(),
  );
  assert.equal(await panel.locator(".capture-series").count(), 0);
  assert(
    await panel
      .getByRole("button", { name: "Download current video", exact: true })
      .isEnabled(),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: hidden Chromium discovery, trusted animated overlay, multipart menu, stable folder dialog, real download/mux, task grouping and library indexing.",
  );
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
