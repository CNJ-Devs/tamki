import { waitForAsync } from "./wait.mjs";
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
const combinedMetadataRequests = [];
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
      images: { large: "https://lain.bgm.tv/pic/cover/l/aa/bb/fixture.png" },
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
        if (input.works) {
          combinedMetadataRequests.push(input.works.map((w) => w.files.length));
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      works: input.works.map((w) => ({
                        id: w.id,
                        result: {
                          work: {
                            title: null,
                            description: `Batch synopsis: ${w.title}`,
                            tags: null,
                            cover: null,
                            coverPage: null,
                          },
                          files: w.files.map((f) => ({
                            id: f.id,
                            number: null,
                            title: `Batch episode: ${w.title}`,
                            description: "Verified batch synopsis",
                          })),
                        },
                      })),
                    }),
                  },
                },
              ],
            }),
          );
          return;
        }
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
let thumbnailEvidence;
const errors = [];
let stage = "launch";
const mark = (value) => console.log(`Browser fixture: ${(stage = value)}`);
// Keep evidence even if an IPC evaluation hangs and the outer runner kills us.
const evidenceTimer = setInterval(() => {
  cp(
    path.join(profile, "logs/runtime.log"),
    "test-results/fixture-runtime.log",
  ).catch(() => {});
}, 5000);
evidenceTimer.unref();
const deadline = setTimeout(() => {
  console.error(`Browser fixture exceeded its deadline during: ${stage}`);
  app?.process().kill();
}, 210000);
deadline.unref();
async function launch() {
  app = await electron.launch({
    chromiumSandbox: true,
    args: [
      ...(process.env.TAMKI_TEST_PASSWORD_STORE
        ? [`--password-store=${process.env.TAMKI_TEST_PASSWORD_STORE}`]
        : []),
      ...(process.env.TAMKI_PACKAGED_EXECUTABLE ? [] : ["."]),
    ],
    executablePath:
      process.env.TAMKI_PACKAGED_EXECUTABLE ||
      process.env.TAMKI_TEST_ELECTRON_EXECUTABLE,
    env: { ...process.env, TAMKI_TEST_PROFILE: profile },
    timeout: 30000,
  });
  app.process().stderr.on("data", (d) => {
    if (/TypeError|UnhandledPromiseRejection|ReferenceError/.test(d.toString()))
      errors.push(d.toString());
  });
  shell = await app.firstWindow();
  // Map CI desktop windows so Chromium keeps submitting compositor frames and
  // does not throttle animation/actionability checks in a hidden Windows window.
  if (process.env.TAMKI_TEST_SHOW_WINDOW === "1")
    await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].showInactive(),
    );
  if (process.platform === "linux") {
    const storage = await app.evaluate(({ safeStorage, app }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend(),
      requested: app.commandLine.getSwitchValue("password-store"),
      sandboxDisabled: app.commandLine.hasSwitch("no-sandbox"),
    }));
    console.log("Linux encrypted credential storage:", storage);
    assert.equal(storage.available, true);
    assert.notEqual(storage.backend, "basic_text");
    assert.equal(storage.sandboxDisabled, false);
  }
  // Answer native permission prompts inside the fixture, without displaying
  // system dialogs or waiting for interaction on the user's desktop.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
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
  const geometry = await app.evaluate(({ BaseWindow }, base) => {
    const w = BaseWindow.getAllWindows()[0];
    return {
      width: w.getContentBounds().width,
      remote: w.contentView.children
        .find((v) => v.webContents?.getURL().startsWith(base))
        .getBounds(),
    };
  }, base);
  assert.equal(geometry.remote.x, 8);
  assert.equal(geometry.remote.width, geometry.width - 16);
  assert.equal(geometry.remote.y, 82);
  // Connected quick panels are painted by the trusted transparent shell above
  // native remote content; the remote page still has no application bridges.
  await shell.getByRole("button", { name: "Search tabs", exact: true }).click();
  const picker = shell.locator(".toolbar-panel");
  await picker.getByRole("combobox").waitFor();
  assert.deepEqual(
    await remote.evaluate(() => [typeof window.tamki, typeof window.tamkiTabs]),
    ["undefined", "undefined"],
  );
  const overlay = await app.evaluate(({ BaseWindow }) => {
    const w = BaseWindow.getAllWindows()[0];
    return {
      url: w.contentView.children.at(-1).webContents.getURL(),
      height: w.getContentSize()[1],
    };
  });
  assert(overlay.url.endsWith("/index.html"));
  const joined = await picker.evaluate((el) => {
    const cap = el.querySelector(".toolbar-panel-cap").getBoundingClientRect(),
      panel = el.getBoundingClientRect(),
      button = document
        .querySelector('.browser-actions [aria-expanded="true"]')
        .getBoundingClientRect();
    return {
      gap: panel.top - button.bottom,
      capBottom: cap.bottom,
      menuTop: panel.top,
      capLeft: cap.left,
      buttonLeft: button.left,
      height: panel.height,
      filter: getComputedStyle(el).filter,
      transparent: getComputedStyle(document.querySelector(".content"))
        .backgroundColor,
    };
  });
  assert.equal(joined.gap, 0);
  assert.equal(joined.capBottom, joined.menuTop);
  assert.equal(joined.capLeft, joined.buttonLeft);
  assert.equal(joined.height, Math.min(520, overlay.height - 46));
  assert(joined.filter.includes("drop-shadow"));
  assert.equal(joined.transparent, "rgba(0, 0, 0, 0)");
  // Raising the transparent shell must not expose the native window's light
  // background around the webpage or turn a foreground-colored shadow white.
  for (const appearance of [
    { mode: "dark", palette: "hazel" },
    { mode: "light", palette: "hazel" },
    { mode: "dark", palette: "iris" },
    { mode: "system", palette: "iris", system: "dark" },
    { mode: "system", palette: "iris", system: "light" },
    { mode: "light", palette: "hazel" },
  ]) {
    if (appearance.system) {
      // Playwright otherwise emulates light media in its default context.
      await shell.emulateMedia({ colorScheme: appearance.system });
      await app.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme;
      }, appearance.system);
    }
    await shell.evaluate(async ({ mode, palette }) => {
      const s = await window.tamki.library("state");
      await window.tamki.library("preferences", {
        ...s.preferences,
        mode,
        palette,
      });
    }, appearance);
    await shell.waitForFunction(
      (mode) => document.documentElement.dataset.mode === mode,
      appearance.mode === "system" ? appearance.system : appearance.mode,
    );
    const frame = await shell.evaluate(() => {
      const content = getComputedStyle(document.querySelector(".content"));
      const probe = document.createElement("span");
      probe.style.color = "var(--rail)";
      document.body.append(probe);
      const rail = getComputedStyle(probe).color;
      probe.remove();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.fillStyle = getComputedStyle(
        document.querySelector(".native-tab-picker"),
      ).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return {
        rail,
        surface: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3),
        shadow: content.boxShadow,
        filter: getComputedStyle(document.querySelector(".toolbar-panel"))
          .filter,
      };
    });
    assert(frame.shadow.includes(frame.rail));
    assert(frame.filter.startsWith("drop-shadow(rgba(0, 0, 0,"));
    // Wait for Chromium to submit the theme repaint before native capture.
    await shell.screenshot();
    const { pixels, nativeBackground } = await app.evaluate(
      async ({ webContents, BaseWindow }) => {
        const wc = webContents
          .getAllWebContents()
          .find((wc) => wc.getURL().endsWith("/index.html"));
        const image = await wc.capturePage();
        const { width, height } = image.getSize();
        const bitmap = image.toBitmap({ scaleFactor: 1 });
        const pixels = [
          [1, Math.floor(height / 2)],
          [width - 2, Math.floor(height / 2)],
          [Math.floor(width / 2), height - 2],
          // Root/content junctions and all four corners of the native webpage.
          [0, 38],
          [width - 1, 38],
          [8, 38],
          [width - 9, 38],
          [8, 82],
          [width - 9, 82],
          [8, height - 9],
          [width - 9, height - 9],
          [0, height - 1],
          [width - 1, height - 1],
        ].map(([x, y]) => {
          const offset = (y * width + x) * 4;
          return [
            bitmap[offset + 2],
            bitmap[offset + 1],
            bitmap[offset],
            bitmap[offset + 3],
          ];
        });
        return {
          pixels,
          nativeBackground: BaseWindow.getAllWindows()[0].getBackgroundColor(),
        };
      },
    );
    const rgb = frame.rail.match(/\d+/g).map(Number);
    const nativeRgb = nativeBackground
      .match(/[\da-f]{2}/gi)
      .map((v) => parseInt(v, 16));
    assert.deepEqual(nativeRgb, rgb);
    for (const pixel of pixels) {
      // Transparent rounded cutouts reveal the native backing, not the shell
      // screenshot. Check the composited pixel, including antialiased edges.
      const alpha = pixel[3] / 255;
      const composed = pixel
        .slice(0, 3)
        .map((value, i) => value * alpha + nativeRgb[i] * (1 - alpha));
      assert(
        composed.every(
          (value, i) =>
            value <= Math.max(rgb[i], frame.surface[i]) + 12 &&
            value > Math.min(rgb[i], frame.surface[i]) - 20,
        ),
        `${JSON.stringify(appearance)}: corner ${composed} differs from frame/menu palette`,
      );
    }
  }
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "system";
  });
  await shell.emulateMedia({ colorScheme: null });
  await shell
    .getByRole("button", { name: "Browsing history", exact: true })
    .hover();
  const toolbarTooltip = shell.getByRole("tooltip", {
    name: "Browsing history",
    exact: true,
  });
  await toolbarTooltip.waitFor();
  assert(
    Number(await toolbarTooltip.evaluate((n) => getComputedStyle(n).zIndex)) >
      Number(
        await shell
          .locator(".tabstrip")
          .evaluate((n) => getComputedStyle(n).zIndex),
      ),
  );
  await shell.screenshot({ path: "test-results/tab-picker.png" });
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
  await shell.getByRole("button", { name: "Search tabs", exact: true }).click();
  await picker.waitFor();
  if (process.platform === "darwin")
    assert.equal(
      await shell
        .locator(".tabstrip")
        .evaluate((n) =>
          getComputedStyle(n).getPropertyValue("-webkit-app-region"),
        ),
      "no-drag",
    );
  await shell.locator(".tabstrip-space").click();
  await picker.waitFor({ state: "detached" });
  if (process.platform === "darwin")
    assert.equal(
      await shell
        .locator(".tabstrip")
        .evaluate((n) =>
          getComputedStyle(n).getPropertyValue("-webkit-app-region"),
        ),
      "drag",
    );
  for (const name of ["Bookmarks", "Browsing history", "Tasks"]) {
    await shell.getByRole("button", { name, exact: true }).click();
    await picker.getByRole("dialog").waitFor();
    assert.equal(
      await shell.locator('.browser-actions > [aria-expanded="true"]').count(),
      1,
    );
    assert.equal(
      await shell
        .getByRole("button", { name, exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    await shell.getByRole("button", { name, exact: true }).click();
    await picker.waitFor({ state: "detached" });
  }
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
  await waitForAsync(shell, async () =>
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
  mark("storage connections");
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
  await waitForAsync(shell, async () => {
    const s = await window.tamki.library("state");
    return !s.refreshing && s.works.length === 2;
  });
  await waitForAsync(shell, async () =>
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
  mark("settings");
  await checkSettings(app, shell, base, profile);
  await shell.getByRole("button", { name: "Back", exact: true }).click();
  assert.equal(
    await shell.locator(".cover-button .poster img").count(),
    0,
    "Missing work artwork must not use episode frames",
  );
  await shell
    .getByRole("button", { name: "Series", exact: true })
    .first()
    .click();
  await shell.locator(".episode-list .poster img").first().waitFor();
  assert.equal(
    await shell.locator(".detail-hero > .poster img").count(),
    0,
    "Work hero must remain an artwork placeholder even after episode thumbnails load",
  );
  for (let attempt = 0; attempt < 100 && !thumbnailEvidence; attempt++) {
    thumbnailEvidence = await shell.evaluate(async () => {
      const state = await window.tamki.library("state");
      for (const work of state.works)
        for (const episode of work.episodes) {
          const image = await window.tamki.library("thumbnail", {
            id: episode.id,
          });
          if (image.url) return { id: episode.id, key: image.key };
        }
    });
    if (!thumbnailEvidence) await shell.waitForTimeout(100);
  }
  assert(thumbnailEvidence, "A generated video frame must be persisted");
  await shell.screenshot({ path: "test-results/library.png" });
  await shell
    .getByRole("button", { name: "Organize information", exact: true })
    .click();
  mark("recognition");
  await checkRecognition(app, shell);
  mark("manual episode editing");
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
  mark("local playback");
  await shell.getByRole("button", { name: "Play", exact: true }).click();
  const video = shell.locator(".player video");
  await shell.waitForFunction(() => {
    const v = document.querySelector(".player video");
    return v?.readyState >= 2 && v.duration > 0 && !v.paused;
  });
  // The custom media protocol serves real bytes and obeys Range; arbitrary files cannot be requested.
  mark("media range and invalid-ticket requests");
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
  mark("mini player and picture in picture");
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
  await waitForAsync(
    shell,
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
  const batchFolders = ["AI batch Alpha", "AI batch Beta", "AI batch Gamma"];
  for (const [index, name] of batchFolders.entries()) {
    const folder = path.join(media, name);
    await mkdir(folder);
    for (let i = 0; i < (index === 0 ? 202 : index === 1 ? 2 : 1); i++)
      await cp(
        "tests/fixtures/video.webm",
        path.join(folder, `${String(i + 1).padStart(3, "0")}.webm`),
      );
  }
  await shell.evaluate(() => window.tamki.library("refresh"));
  await waitForAsync(
    shell,
    async (folders) => {
      const state = await window.tamki.library("state");
      return (
        !state.refreshing &&
        folders.every((folder) => state.works.some((w) => w.path === folder))
      );
    },
    batchFolders.map((name) => path.join(media, name)),
  );
  const beforeCombined = combinedMetadataRequests.length;
  const aiBatch = await shell.evaluate(
    async (folders) => {
      const state = await window.tamki.library("state");
      const works = folders.map((folder) =>
        state.works.find((w) => w.path === folder),
      );
      const first = works[0];
      await window.tamki.library("edit", {
        id: first.id,
        title: first.title,
        description: "Manual synopsis",
        tags: first.tags,
        attachments: [],
        removedEpisodeIds: [],
        episodes: first.episodes.map(({ id, number, title, description }) => ({
          id,
          number,
          title,
          description,
        })),
      });
      const result = await window.tamki.library("recognize-batch", {
        workIds: works.map((w) => w.id),
        sourceId: state.settings.recognition.sources[0].id,
      });
      return { ids: works.map((w) => w.id), queued: result.queued };
    },
    batchFolders.map((name) => path.join(media, name)),
  );
  assert.equal(aiBatch.queued.length, 3);
  await waitForAsync(
    shell,
    async (ids) => {
      const state = await window.tamki.library("state");
      return ids.every(
        (id) =>
          state.works.find((w) => w.id === id)?.recognition?.status ===
          "complete",
      );
    },
    aiBatch.ids,
  );
  assert.equal(
    combinedMetadataRequests.length - beforeCombined,
    1,
    "3 works and 205 episodes must share one AI request",
  );
  assert.deepEqual(
    combinedMetadataRequests
      .at(-1)
      .slice()
      .sort((a, b) => a - b),
    [1, 2, 202],
  );
  const batchWorks = (await state()).works.filter((w) =>
    aiBatch.ids.includes(w.id),
  );
  assert.equal(
    batchWorks.find((w) => w.id === aiBatch.ids[0]).description,
    "Manual synopsis",
  );
  assert(
    batchWorks.every((w) =>
      w.episodes.every((e) => e.title === `Batch episode: ${w.title}`),
    ),
    "decoded file identities must remain within their own work",
  );
  await app.close();
  mark("restart persistence");
  await launch();
  const restoredThumbnail = await shell.evaluate(
    (input) => window.tamki.library("thumbnail", { id: input.id }),
    thumbnailEvidence,
  );
  assert.equal(restoredThumbnail.key, thumbnailEvidence.key);
  assert(
    restoredThumbnail.url?.startsWith("tamki-media://thumbnail/"),
    "Restart must reuse the disk thumbnail",
  );
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
  assert.equal(snapshot.preferences.appIconStyle, "color");
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
  remote = await waitForPage((p) => p !== shell && p.url() === base + "/one");
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
  const runtime = await readFile(path.join(profile, "logs/runtime.log")).catch(
    () => null,
  );
  if (runtime) await writeFile("test-results/fixture-runtime.log", runtime);
  if (shell)
    await shell
      .screenshot({ path: "test-results/failure.png" })
      .catch(() => {});
  throw e;
} finally {
  clearInterval(evidenceTimer);
  clearTimeout(deadline);
  await app?.close().catch(() => {});
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
