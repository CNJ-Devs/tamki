import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  cp,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { checkConnections } from "./connections.mjs";
import { checkAutomaticRecognition } from "./automatic-recognition.mjs";
import { checkRecognition } from "./recognition.mjs";
import { checkSettings } from "./settings.mjs";
const temporary = await mkdtemp(path.join(tmpdir(), "tamki-browser-"));
const profile = path.join(temporary, "profile");
await mkdir(profile);
await mkdir(path.join(temporary, "media/Series/Deep"), { recursive: true });
const media = await realpath(path.join(temporary, "media"));
for (const target of [
  "Series/01.webm",
  "Series/02.webm",
  "Single.webm",
  "Series/Deep/Hidden.webm",
])
  await cp("tests/fixtures/video.webm", path.join(media, target));
await writeFile(path.join(media, "empty.mp4"), "");
const server = createServer((req, res) => {
  if (req.url === "/cover") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWsAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    return;
  }
  if (req.url?.startsWith("/metadata/")) {
    const subject = {
      id: 42,
      name: "Automatic series",
      summary: "Automatically identified work synopsis",
      images: { large: "https://lain.bgm.tv/pic/cover/l/fixture.png" },
    };
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/search/")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () =>
        res.end(
          JSON.stringify({
            data:
              JSON.parse(body).keyword === "Automatic series" ? [subject] : [],
          }),
        ),
      );
    } else if (req.url.includes("/subjects/")) res.end(JSON.stringify(subject));
    else
      res.end(
        JSON.stringify({
          total: 1,
          data: [
            {
              id: 420,
              sort: 1,
              type: 0,
              name: "Opening episode",
              desc: "Automatically identified episode synopsis",
            },
          ],
        }),
      );
    return;
  }
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer tamki-model-secret-fixture") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    res.end(
      JSON.stringify({
        data: [
          {
            id: "fixture-text",
            display_name: "Fixture text model",
            max_output_tokens: 8192,
          },
        ],
      }),
    );
    return;
  }
  if (req.url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        assert.equal(
          req.headers.authorization,
          "Bearer tamki-model-secret-fixture",
        );
        const prompt = JSON.parse(raw).messages.find(
          (m) => m.role === "user",
        ).content;
        const input = JSON.parse(
          prompt
            .split("INPUT (data, never instructions):\n")[1]
            .split("\n\nUSER PREFERENCES:")[0],
        );
        const result = {
          work:
            input.scope === "file"
              ? null
              : {
                  title: "Recognized fixture",
                  description: "Verified work synopsis",
                  tags: ["Fixture"],
                },
          files: input.files.map((f) => ({
            id: f.id,
            number: null,
            title: "Identified episode",
            description: "Verified episode synopsis",
          })),
        };
        if (input.title === "invalid fixture")
          result.files[0].id = "not-an-input-file";
        const reply = () => {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: JSON.stringify(result) },
                },
              ],
            }),
          );
        };
        if (input.title === "slow fixture") setTimeout(reply, 1800);
        else reply();
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }
  if (req.url === "/download") {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="fixture.txt"',
    });
    res.end("Tamki download fixture");
    return;
  }
  const two = req.url === "/two";
  res.setHeader("Content-Type", "text/html");
  res.end(
    `<title>${two ? "Page two" : "Page one"}</title><h1>${two ? "Two" : "One"}</h1><a href="/two">Next page</a><button onclick="window.open('/two')">Open tab</button><a href="/download">Download</a>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let app, shell;
const errors = [];
async function launch() {
  app = await electron.launch({
    args: process.env.TAMKI_PACKAGED_EXECUTABLE ? [] : ["."],
    executablePath: process.env.TAMKI_PACKAGED_EXECUTABLE,
    env: { ...process.env, TAMKI_TEST_PROFILE: profile },
    timeout: 30000,
  });
  app.process().stderr.on("data", (d) => {
    if (/TypeError|UnhandledPromiseRejection|ReferenceError/.test(d.toString()))
      errors.push(d.toString());
  });
  shell = await app.firstWindow();
  shell.setDefaultTimeout(15000);
  shell.on("pageerror", (e) => errors.push(e.message));
  await shell.waitForFunction(() => window.tamki);
  await shell.locator(".page-header").waitFor();
  await shell.evaluate(async () => {
    const s = await window.tamki.library("state");
    await window.tamki.library("recognition-preferences", { automatic: false });
    await window.tamki.library("preferences", {
      ...s.preferences,
      language: "en",
      mode: "light",
    });
  });
  return shell;
}
async function waitForPage(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const target = app.context().pages().find(predicate);
    if (target) return target;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chromium target did not attach");
}
const state = () => shell.evaluate(() => window.tamki.library("state"));
try {
  await mkdir("test-results", { recursive: true });
  await launch();
  await shell.getByRole("button", { name: "New tab", exact: true }).click();
  await shell.locator("#address").fill(base + "/one");
  await shell.locator("#address").press("Enter");
  let remote = await waitForPage(
    (p) => p !== shell && p.url().startsWith(base),
  );
  await remote.waitForURL(base + "/one");
  assert.deepEqual(
    await remote.evaluate(() => [
      typeof require,
      typeof process,
      typeof window.tamki,
    ]),
    ["undefined", "undefined", "undefined"],
  );
  await remote.evaluate(
    () => (document.cookie = "tamki_fixture=persisted; max-age=3600; path=/"),
  );
  await remote.getByRole("link", { name: "Next page" }).click();
  await remote.waitForURL(base + "/two");
  await shell.locator("#back").click();
  await remote.waitForURL(base + "/one");
  await shell.locator("#forward").click();
  await remote.waitForURL(base + "/two");
  const geometry = await app.evaluate(({ BaseWindow }) => {
    const w = BaseWindow.getAllWindows()[0];
    return {
      width: w.getContentBounds().width,
      views: w.contentView.children.map((v) => v.getBounds()),
    };
  });
  assert.equal(geometry.views.at(-1).x, 8);
  assert.equal(geometry.views.at(-1).width, geometry.width - 16);
  assert.equal(geometry.views.at(-1).y, 82);
  // The tab menu is a trusted native view above the remote page, not a DOM
  // popover hidden under Chromium. Its preload exposes no library capability.
  await shell.getByRole("button", { name: "Search tabs", exact: true }).click();
  const picker = await waitForPage((p) => p.url().endsWith("/tab-picker.html"));
  picker.on("pageerror", (e) => errors.push(e.message));
  await picker.getByRole("combobox").waitFor();
  assert.deepEqual(
    await picker.evaluate(() => [typeof window.tamki, typeof window.tamkiTabs]),
    ["undefined", "object"],
  );
  const overlay = await app.evaluate(({ BaseWindow }) => {
    const views = BaseWindow.getAllWindows()[0].contentView.children;
    const view = views.at(-1);
    return {
      url: view.webContents.getURL(),
      visible: view.getVisible(),
      bounds: view.getBounds(),
    };
  });
  assert(overlay.url.endsWith("/tab-picker.html"));
  assert(overlay.visible);
  assert(overlay.bounds.y + overlay.bounds.height > 82);
  await picker.screenshot({ path: "test-results/tab-picker.png" });
  await picker.getByRole("combobox").fill("Page two");
  await picker.getByRole("option").filter({ hasText: "Page two" }).click();
  await shell.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Search tabs"]')
        .getAttribute("aria-expanded") === "false",
  );
  await shell.getByRole("button", { name: "Search tabs", exact: true }).click();
  await picker.getByRole("combobox").press("Escape");
  await shell
    .getByRole("button", { name: "Search tabs", exact: true })
    .evaluate((el) => {
      if (document.activeElement !== el)
        throw new Error("Tab menu did not restore focus");
    });
  await shell.getByRole("button", { name: "Search tabs", exact: true }).click();
  await remote.locator("h1").click();
  await shell.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Search tabs"]')
        .getAttribute("aria-expanded") === "false",
  );
  const previousTargets = new Set(app.context().pages());
  await remote.getByRole("button", { name: "Open tab" }).click();
  await shell.waitForFunction(
    () => document.querySelectorAll(".tab-select").length === 2,
  );
  const current = await waitForPage(
    (p) => !previousTargets.has(p) && p.url() === base + "/two",
  );
  await shell.locator("#address").fill("file:///etc/passwd");
  await shell.locator("#address").press("Enter");
  assert.match(
    await shell.locator("#error").innerText(),
    /Unsupported URL protocol/,
  );
  assert((await shell.locator("#error").boundingBox()).y < 82);
  assert(current.url().startsWith(base));
  assert.equal(
    await current.evaluate(() => Notification.requestPermission()),
    "denied",
  );
  const file = path.join(profile, "fixture.txt");
  await app.evaluate(
    ({ session }, target) =>
      session
        .fromPartition("persist:tamki-browser")
        .once("will-download", (_e, item) => item.setSavePath(target)),
    file,
  );
  await current.getByRole("link", { name: "Download", exact: true }).click();
  await shell.waitForFunction(async () =>
    (await window.tamki.library("state")).transfers.some(
      (t) => t.state === "completed",
    ),
  );
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      (await readFile(file, "utf8").catch(() => "")) ===
      "Tamki download fixture"
    )
      break;
    await shell.waitForTimeout(100);
  }
  assert.equal(await readFile(file, "utf8"), "Tamki download fixture");
  await shell.locator(".close-tab").last().click();
  await shell.getByRole("button", { name: "Home", exact: true }).click();
  await shell.getByRole("button", { name: "Settings", exact: true }).click();
  await shell.screenshot({ path: "test-results/settings.png" });
  await checkConnections(app, shell, temporary);
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [root],
    });
  }, media);
  await shell
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await shell
    .getByRole("button", { name: "Local folder", exact: true })
    .click();
  await shell.getByLabel("Name", { exact: true }).fill("Fixture media");
  const depth = shell.getByRole("combobox", {
    name: `Scan depth · ${media}`,
    exact: true,
  });
  assert.match(await depth.innerText(), /3 levels below/);
  await depth.click();
  await shell
    .getByRole("option", { name: "1 level below", exact: true })
    .click();
  await shell.getByRole("listbox").waitFor({ state: "hidden" });
  await shell.screenshot({ path: "test-results/scan-depth.png" });
  await shell.getByRole("button", { name: "Save", exact: true }).click();
  await shell.waitForFunction(async () => {
    const s = await window.tamki.library("state");
    return !s.refreshing && s.works.length === 2;
  });
  await shell.waitForFunction(async () =>
    (await window.tamki.library("state")).works.every((w) =>
      w.episodes.every((e) => e.duration > 0),
    ),
  );
  let snapshot = await state();
  assert.equal(
    snapshot.works.find((w) => w.title === "Series").episodes.length,
    2,
  );
  assert(!snapshot.works.some((w) => w.title.includes("Hidden")));
  await checkSettings(app, shell, base, profile);
  await shell.getByRole("button", { name: "Back", exact: true }).click();
  await shell.locator(".poster img").first().waitFor();
  await shell.screenshot({ path: "test-results/library.png" });
  await shell
    .getByRole("button", { name: "Series", exact: true })
    .first()
    .click();
  await shell
    .getByRole("button", { name: "Organize information", exact: true })
    .click();
  await checkRecognition(app, shell);
  await shell.getByLabel("Name", { exact: true }).fill("Edited series");
  await shell
    .getByLabel("Synopsis", { exact: true })
    .fill("A locally generated media fixture.");
  await shell.getByRole("tab", { name: "Episodes", exact: true }).click();
  await shell
    .locator(".edit-episode-row")
    .first()
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await shell.getByLabel("Episode number", { exact: true }).fill("Special 1");
  await shell
    .getByLabel("Episode title", { exact: true })
    .fill("An editable title");
  await shell.getByRole("button", { name: "Back", exact: true }).click();
  await shell.getByRole("button", { name: "Save", exact: true }).click();
  snapshot = await state();
  const series = snapshot.works.find((w) => w.title === "Edited series");
  assert.equal(series.episodes[0].number, "Special 1");
  await shell.getByRole("button", { name: "Play", exact: true }).click();
  const video = shell.locator(".player video");
  await shell.waitForFunction(() => {
    const v = document.querySelector(".player video");
    return v?.readyState >= 2 && v.duration > 0 && !v.paused;
  });
  // The custom media protocol serves real bytes and obeys Range; arbitrary files cannot be requested.
  const mediaChecks = await shell.evaluate(async (id) => {
    const url = await window.tamki.library("media", id);
    const good = await fetch(url, { headers: { Range: "bytes=10-19" } });
    const data = await good.arrayBuffer();
    const bad = await fetch(url.replace(/ticket=.*/, "ticket=wrong"));
    return [
      good.status,
      data.byteLength,
      good.headers.get("content-range"),
      bad.status,
    ];
  }, series.episodes[0].id);
  assert.equal(mediaChecks[0], 206);
  assert.equal(mediaChecks[1], 10);
  assert.match(mediaChecks[2], /^bytes 10-19\//);
  assert.equal(mediaChecks[3], 403);
  await video.evaluate((v) => {
    v.pause();
    v.currentTime = 1.25;
  });
  await shell.waitForTimeout(200);
  await shell.getByRole("button", { name: "Mini player", exact: true }).click();
  await shell.locator(".mini-surface").waitFor();
  await shell.waitForTimeout(400);
  assert.equal(await video.count(), 1);
  assert.equal(await shell.locator(".player-controls").isVisible(), true);
  await shell
    .locator(".player-placeholder")
    .getByRole("button", { name: "Return to player", exact: true })
    .click();
  await shell.waitForTimeout(400);
  const canPip = await shell.evaluate(() => document.pictureInPictureEnabled);
  if (canPip) {
    await shell
      .getByRole("button", { name: "Picture in picture", exact: true })
      .click();
    await shell.waitForFunction(
      () =>
        document.pictureInPictureElement ===
        document.querySelector(".player video"),
    );
    assert.equal(await shell.locator(".mini-surface").count(), 0);
    await shell
      .locator(".player-placeholder")
      .getByRole("button", { name: "Return to player", exact: true })
      .click();
    await shell.waitForFunction(() => !document.pictureInPictureElement);
  }
  await shell.getByRole("button", { name: "Episodes", exact: true }).click();
  await shell.locator(".player-queue").waitFor();
  await shell
    .locator(".player-queue")
    .getByRole("button")
    .filter({ hasText: "Identified episode" })
    .click();
  await shell.waitForFunction(() => {
    const v = document.querySelector(".player video");
    return v?.readyState >= 2 && v.currentTime < 1 && !v.paused;
  });
  assert.equal(
    await shell
      .getByRole("button", { name: "Next episode", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await shell
      .getByRole("button", { name: "Previous episode", exact: true })
      .isDisabled(),
    false,
  );
  await video.evaluate((v) => {
    v.pause();
    v.currentTime = 2;
  });
  await shell.waitForTimeout(200);
  await shell.screenshot({ path: "test-results/player.png" });
  await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0].setContentSize(720, 620),
  );
  await shell.waitForTimeout(450);
  const bounds = await shell.locator(".player-controls").evaluate((el) => ({
    overflow: el.scrollWidth > el.clientWidth,
    buttons: [...el.querySelectorAll("button[data-size=icon]")].map((b) => {
      const r = b.getBoundingClientRect();
      return [r.width, r.height];
    }),
  }));
  assert.equal(bounds.overflow, false);
  assert(bounds.buttons.every(([w, h]) => w === 32 && h === 32));
  await shell.screenshot({ path: "test-results/player-narrow.png" });
  await shell.getByRole("button", { name: "Full screen", exact: true }).click();
  await shell.waitForFunction(() => document.fullscreenElement);
  await shell.getByRole("button", { name: "Play", exact: true }).click();
  await shell.waitForTimeout(2500);
  await shell.screenshot({ path: "test-results/fullscreen.png" });
  await shell.evaluate(() => document.exitFullscreen());
  await shell.getByRole("button", { name: "Home", exact: true }).click();
  await shell
    .getByRole("button", { name: "Organize information", exact: true })
    .click();
  await shell.getByRole("tab", { name: "Episodes", exact: true }).click();
  await shell
    .getByRole("button", { name: "Add episodes", exact: true })
    .click();
  const pickerDialog = shell.getByRole("dialog");
  await pickerDialog.getByRole("button", { name: media, exact: true }).click();
  await pickerDialog
    .getByRole("button", { name: "Series", exact: true })
    .click();
  await pickerDialog.getByRole("button", { name: "Deep", exact: true }).click();
  await pickerDialog
    .getByRole("checkbox", { name: "Hidden.webm", exact: true })
    .click();
  await pickerDialog
    .getByRole("button", { name: "Add (1)", exact: true })
    .click();
  await shell
    .locator(".edit-episode-row")
    .filter({ hasText: "Hidden.webm" })
    .waitFor();
  assert.equal(
    (await state()).works.find((w) => w.id === series.id).episodes.length,
    2,
  );
  await shell.getByRole("button", { name: "Save", exact: true }).click();
  await shell.waitForFunction(
    async (id) =>
      (await window.tamki.library("state")).works.find((w) => w.id === id)
        .episodes.length === 3,
    series.id,
  );
  await shell.waitForTimeout(250);
  await shell.screenshot({ path: "test-results/detail.png" });
  await shell.getByRole("button", { name: "Back", exact: true }).click();
  await shell.getByRole("button", { name: "Settings", exact: true }).click();
  await shell.getByRole("radio", { name: "Iris", exact: true }).click();
  await shell.getByRole("combobox", { name: "Language", exact: true }).click();
  await shell.getByRole("option", { name: "简体中文", exact: true }).click();
  await shell.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.equal((await state()).preferences.palette, "iris");
  await shell.waitForTimeout(300);
  await shell.screenshot({ path: "test-results/settings-narrow.png" });
  const automaticCover = await checkAutomaticRecognition(
    app,
    shell,
    temporary,
    base,
  );
  await app.close();
  await launch();
  snapshot = await state();
  assert.equal(
    snapshot.works.find((w) => w.title === "Automatic series").cover,
    automaticCover,
  );
  await shell.waitForFunction(() =>
    [...document.querySelectorAll(".poster img")].some(
      (image) =>
        image.src.startsWith("tamki-media://cover/") &&
        image.complete &&
        image.naturalWidth > 0,
    ),
  );
  await shell.screenshot({ path: "test-results/automatic-recognition.png" });
  assert.equal(snapshot.preferences.palette, "iris");
  assert.equal(snapshot.settings.recognition.parser, "anitomy");
  assert.match(snapshot.settings.recognition.aiPrompt, /Fixture preference/);
  assert.equal(
    snapshot.settings.recognition.defaultSourceId,
    snapshot.settings.recognition.sources[0].id,
  );
  assert.equal(snapshot.settings.recognition.sources[0].model, "fixture-text");
  assert.equal(snapshot.settings.downloads.series.mode, "fixed");
  assert.match(snapshot.settings.downloads.series.fixed.path, /Series$/);
  assert.equal(
    snapshot.works.find((w) => w.id === series.id).episodes[0].number,
    "Special 1",
  );
  assert.equal(
    snapshot.works.find((w) => w.id === series.id).episodes.length,
    3,
  );
  assert(
    snapshot.works.find((w) => w.id === series.id).episodes[1].position > 0,
  );
  await shell.getByRole("button", { name: "New tab", exact: true }).click();
  await shell.locator("#address").fill(base + "/one");
  await shell.locator("#address").press("Enter");
  remote = await waitForPage((p) => p !== shell && p.url().startsWith(base));
  await remote.waitForURL(base + "/one");
  assert.match(
    await remote.evaluate(() => document.cookie),
    /tamki_fixture=persisted/,
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  await writeFile(
    "test-results/runtime.json",
    JSON.stringify(
      {
        pipTested: canPip,
        ...(await app.evaluate(({ app }) => ({
          versions: process.versions,
          processes: app.getAppMetrics().map((m) => ({
            type: m.type,
            workingSetKB: m.memory.workingSetSize,
          })),
        }))),
      },
      null,
      2,
    ),
  );
  console.log(
    "Passed Chromium isolation/navigation/downloads/native menus, real local scans, metadata and episode appending, media Range/playback, mini/PiP/fullscreen, narrow layout, theme/localization and restart persistence.",
  );
} catch (e) {
  if (shell)
    await shell
      .screenshot({ path: "test-results/failure.png" })
      .catch(() => {});
  throw e;
} finally {
  await app?.close().catch(() => {});
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
