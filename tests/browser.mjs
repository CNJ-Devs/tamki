import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const profile = await mkdtemp(path.join(tmpdir(), "tamki-browser-"));
const server = createServer((req, res) => {
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
let app;
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
  const shell = await app.firstWindow();
  await shell.waitForFunction(() => window.tamki);
  await shell.locator(".tab-select").waitFor();
  return shell;
}
async function waitForPage(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const target = app.context().pages().find(predicate);
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chromium browsing target to attach");
}
try {
  let shell = await launch();
  await shell.locator("#address").fill(base + "/one");
  await shell.locator("#address").press("Enter");
  let remote = await waitForPage(
    (p) => p !== shell && p.url().startsWith(base),
  );
  await remote.waitForURL(base + "/one");
  await remote.getByRole("heading", { name: "One", exact: true }).waitFor();
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
  await shell.locator("#collapse").click();
  assert.equal(await shell.locator("body").getAttribute("class"), "collapsed");
  const geometry = await app.evaluate(({ BaseWindow }) => {
    const w = BaseWindow.getAllWindows()[0];
    return {
      width: w.getContentBounds().width,
      views: w.contentView.children.map((v) => v.getBounds()),
    };
  });
  assert.equal(geometry.views.at(-1).x, 64);
  assert.equal(geometry.views.at(-1).width, geometry.width - 72);
  const previousTargets = new Set(app.context().pages());
  await remote.getByRole("button", { name: "Open tab" }).click();
  await shell.waitForFunction(
    () => document.querySelectorAll(".tab-select").length === 2,
  );
  const current = await waitForPage(
    (p) => !previousTargets.has(p) && p.url() === base + "/two",
  );
  await current.getByRole("heading", { name: "Two", exact: true }).waitFor();
  await shell.locator("#address").fill("file:///etc/passwd");
  await shell.locator("#address").press("Enter");
  assert.match(
    await shell.locator("#error").innerText(),
    /Unsupported URL protocol/,
  );
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
        .once("will-download", (_event, item) => item.setSavePath(target)),
    file,
  );
  await current.getByRole("link", { name: "Download", exact: true }).click();
  for (let i = 0; i < 40; i++) {
    try {
      if ((await readFile(file, "utf8")) === "Tamki download fixture") break;
    } catch {}
    await shell.waitForTimeout(100);
  }
  assert.equal(await readFile(file, "utf8"), "Tamki download fixture");
  await shell.locator(".tab .close").last().click();
  await shell.waitForFunction(
    () => document.querySelectorAll(".tab-select").length === 1,
  );
  await shell.locator("[data-page=settings]").click();
  await shell.locator("#other select").selectOption("zh");
  assert.match(await shell.locator("#other").innerText(), /设置/);
  await shell.locator("[data-page=browser]").click();
  await shell.locator("#collapse").click();
  // Return home for the actual shell screenshot, excluding all personal state.
  await shell.getByRole("button", { name: "New tab", exact: true }).click();
  await shell.waitForTimeout(250);
  await mkdir("test-results", { recursive: true });
  await shell.screenshot({ path: "test-results/browser-foundation.png" });
  const metrics = await app.evaluate(({ app }) => ({
    versions: process.versions,
    processes: app
      .getAppMetrics()
      .map((m) => ({ type: m.type, workingSetKB: m.memory.workingSetSize })),
  }));
  await writeFile(
    "test-results/runtime.json",
    JSON.stringify(metrics, null, 2),
  );
  await app.close();
  shell = await launch();
  await shell.locator("#address").fill(base + "/one");
  await shell.locator("#address").press("Enter");
  remote = await waitForPage((p) => p !== shell && p.url().startsWith(base));
  await remote.waitForURL(base + "/one");
  assert.match(
    await remote.evaluate(() => document.cookie),
    /tamki_fixture=persisted/,
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Passed real Chromium navigation, tabs/popups, isolation, denied permissions, blocked schemes, native download path, sidebar geometry, localization and session persistence.",
  );
} finally {
  await app?.close().catch(() => {});
  server.close();
  await rm(profile, { recursive: true, force: true });
}
