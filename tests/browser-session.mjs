import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const profile = await mkdtemp(path.join(tmpdir(), "tamki-session-"));
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<title>Fixture ${req.url}</title><p>Session fixture</p>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const launch = () =>
  electron.launch({
    args: ["."],
    env: {
      ...process.env,
      TAMKI_TEST_PROFILE: profile,
      TAMKI_BACKGROUND_TEST: "1",
    },
  });
let app;
try {
  app = await launch();
  let shell = await app.firstWindow();
  await shell.waitForFunction(() => window.tamki);
  await shell.evaluate(async (base) => {
    await window.tamki.action("new");
    await window.tamki.action("navigate", base + "/one");
    await window.tamki.action("new");
    await window.tamki.action("navigate", base + "/two");
  }, base);
  for (let i = 0; i < 100; i++) {
    const state = await shell.evaluate(() => window.tamki.action("state"));
    if (
      state.tabs.filter((tab) => tab.title.startsWith("Fixture")).length === 2
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await shell.evaluate(async () => {
    const s = await window.tamki.action("state");
    await window.tamki.action("select", s.tabs[0].id);
  });
  await app.close();
  app = await launch();
  shell = await app.firstWindow();
  await shell.waitForFunction(() => window.tamki);
  for (let i = 0; i < 100; i++) {
    const state = await shell.evaluate(() => window.tamki.action("state"));
    if (
      state.tabs.filter((tab) => tab.title.startsWith("Fixture")).length === 2
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = await shell.evaluate(() => window.tamki.action("state"));
  assert.deepEqual(
    state.tabs.map((tab) => tab.url),
    [base + "/one", base + "/two"],
  );
  assert.equal(
    state.tabs.find((tab) => tab.id === state.active).url,
    base + "/one",
  );
  await shell.evaluate(() => window.tamki.action("history-open"));
  await shell.locator(".toolbar-panel").waitFor();
  const data = await shell.evaluate(() => window.tamkiTabs.action("state"));
  assert.equal(
    data.history.filter((entry) => entry.url.startsWith(base)).length,
    2,
  );
  console.log(
    "PASS: isolated browser restart restores URLs, selected tab, and local history.",
  );
} finally {
  await app?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
