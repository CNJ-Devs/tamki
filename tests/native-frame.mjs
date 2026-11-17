// macOS compositor coverage: shell-only screenshots omit native backing layers.
import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

if (process.platform !== "darwin") process.exit(0);
const temporary = await mkdtemp(`${tmpdir()}/tamki-native-frame-`);
const server = createServer((_request, response) => {
  response.end(
    '<body style="margin:0;background:#121212;color:white">Native frame fixture</body>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app;
try {
  app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      TAMKI_TEST_PROFILE: temporary,
      TAMKI_BACKGROUND_TEST: "1",
    },
  });
  const shell = await app.firstWindow();
  await shell.waitForFunction(() => window.tamki);
  await shell.evaluate(async () => {
    const state = await window.tamki.library("state");
    await window.tamki.library("preferences", {
      ...state.preferences,
      language: "en",
      mode: "dark",
    });
  });
  await shell.getByRole("button", { name: "New tab", exact: true }).click();
  const url = `http://127.0.0.1:${server.address().port}/`;
  await shell.locator("#address").fill(url);
  await shell.locator("#address").press("Enter");
  await shell.waitForFunction(() => document.querySelector(".browser-page"));
  await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0].showInactive(),
  );
  const pid = app.process().pid;
  const swift = `import CoreGraphics
let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String:Any]] ?? []
for window in windows {
  if (window[kCGWindowOwnerPID as String] as? Int) == ${pid},
     let bounds = window[kCGWindowBounds as String] as? [String:Any],
     (bounds["Height"] as? Int ?? 0) > 400 {
    print(window[kCGWindowNumber as String]!)
  }
}`;
  const windowId = execFileSync("swift", ["-e", swift], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
  assert(windowId);
  for (const mode of ["dark", "light"]) {
    await shell.evaluate(async (mode) => {
      const state = await window.tamki.library("state");
      await window.tamki.library("preferences", { ...state.preferences, mode });
    }, mode);
    await shell.waitForFunction(
      (mode) => document.documentElement.dataset.mode === mode,
      mode,
    );
    for (const open of [true, false]) {
      await shell.getByRole("button", { name: "Tasks", exact: true }).click();
      await shell
        .locator(".toolbar-panel")
        .waitFor({ state: open ? "visible" : "detached" });
      await shell.screenshot();
      const file = `${temporary}/${mode}-${open}.png`;
      // WindowServer can assign an ID before the first native surface is ready.
      for (let attempt = 0; ; attempt++) {
        try {
          execFileSync("screencapture", ["-x", "-o", "-l", windowId, file], {
            stdio: "pipe",
          });
          break;
        } catch (error) {
          if (attempt === 19) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const pixels = await app.evaluate(({ nativeImage }, file) => {
        const image = nativeImage.createFromPath(file);
        const { width } = image.getSize();
        const scale = width / 1280;
        const bytes = image.getBitmap();
        return [
          [1, 40],
          [1278, 40],
          [8, 82],
          [1271, 82],
          [8, 851],
          [1271, 851],
        ].map(([x, y]) => {
          const offset =
            (Math.floor(y * scale) * width + Math.floor(x * scale)) * 4;
          return [
            bytes[offset + 2],
            bytes[offset + 1],
            bytes[offset],
            bytes[offset + 3],
          ];
        });
      }, file);
      for (const pixel of pixels) {
        assert.equal(pixel[3], 255);
        assert(
          pixel
            .slice(0, 3)
            .every((value) => (mode === "dark" ? value < 80 : value > 180)),
          `${mode}, menu ${open ? "open" : "closed"}: unexpected native corner ${pixel}`,
        );
      }
    }
  }
  console.log(
    "Passed native macOS frame, webpage corners and toolbar junctions in dark/light with menus open/closed.",
  );
} finally {
  await app?.close();
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
