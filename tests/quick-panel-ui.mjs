import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const assets = new Map(
  await Promise.all(
    ["tab-picker.js", "style.css"].map(async (name) => [
      "/" + name,
      await readFile("dist/ui/" + name),
    ]),
  ),
);
const server = createServer((req, res) => {
  if (assets.has(req.url)) {
    res.setHeader(
      "content-type",
      req.url.endsWith(".css") ? "text/css" : "text/javascript",
    );
    res.end(assets.get(req.url));
  } else
    res.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/tab-picker.js"></script></body></html>',
    );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 440, height: 520 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const jobs = ["第一季", "第二季"].map((name, index) => ({
      id: "job" + index,
      name: "示例作品 · " + name,
      target: { connectionId: "local", path: "/media/" + index },
      series: true,
      createdAt: 1,
      items: Array.from({ length: 12 }, (_, i) => ({
        id: index + "-" + (i + 1),
        name: name + " · 第" + (i + 1) + "集.mp4",
        state: i === 0 ? "queued" : "completed",
        stage: "transferring",
        received: 0,
        total: 100,
        qualityLabel: "1080P",
        episodeId: "episode" + index + "-" + i,
        resource: {
          id: index + "-" + i,
          provider: "bilibili",
          title: "Episode",
          aid: 1,
          bvid: "BV0000000001",
          cid: 1,
          duration: 30,
        },
      })),
    }));
    const state = {
      preferences: {
        language: "zh",
        palette: "hazel",
        mode: "dark",
        refreshOnOpen: false,
      },
      mode: "tasks",
      jobs,
      transfers: [],
      history: [
        { title: "示例浏览记录", url: "https://example.com/history", time: 1 },
      ],
      browser: {
        pickerOpen: true,
        tabs: [
          {
            id: 1,
            title: "示例标签页",
            url: "https://example.com/tab",
            kind: "web",
          },
        ],
        bookmarks: [
          {
            id: "bookmark1",
            title: "示例收藏",
            url: "https://example.com/bookmark",
          },
        ],
      },
    };
    window.fixture = { state, calls: [], update: () => {} };
    window.tamkiTabs = {
      onState: (handler) => {
        window.fixture.update = (patch) => {
          Object.assign(state, patch);
          handler({ ...state });
        };
        return () => {};
      },
      action: async (type, value) => {
        if (type === "state") return state;
        window.fixture.calls.push({ type, value });
        return {};
      },
    };
  });
  page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}/tab-picker.html`);
  const panel = page.getByRole("dialog", { name: "任务", exact: true });
  await panel.waitFor();
  assert.equal(await panel.getByRole("checkbox").count(), 3);
  const alignment = await panel.evaluate((el) => {
    const header = el.querySelector("header").getBoundingClientRect();
    const list = el.querySelector(".quick-task-list").getBoundingClientRect();
    const row = el.querySelector(".task-top").getBoundingClientRect();
    return { left: row.x - header.x, gap: list.y - header.bottom };
  });
  assert.deepEqual(alignment, { left: 0, gap: 8 });
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/quick-tasks-default.png" });
  assert.equal(await panel.getByRole("checkbox").count(), 3);
  assert.equal(
    await panel
      .locator(".download-task-children .download-selection-bar")
      .count(),
    0,
  );
  for (let i = 0; i < 2; i++)
    await panel
      .getByRole("button", { name: "展开任务", exact: true })
      .first()
      .click();
  const header = panel.locator("header");
  const headerY = (await header.boundingBox()).y;
  await panel
    .getByRole("checkbox", { name: "第一季 · 第1集.mp4", exact: true })
    .check();
  await panel
    .getByRole("checkbox", { name: "第二季 · 第1集.mp4", exact: true })
    .check();
  assert.match(await header.innerText(), /任务.*已选 2 项/s);
  assert.equal((await header.boundingBox()).y, headerY);
  const layout = await header.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      overflow: el.scrollWidth > el.clientWidth,
      oneRow: [...el.querySelectorAll("button,strong,span[aria-live]")].every(
        (child) => {
          const b = child.getBoundingClientRect();
          return b.y >= box.y && b.bottom <= box.bottom;
        },
      ),
    };
  });
  assert.deepEqual(layout, { overflow: false, oneRow: true });
  await page.screenshot({ path: "test-results/quick-tasks-multiselect.png" });
  await header.getByRole("button", { name: "批量暂停", exact: true }).click();
  await page.waitForFunction(() => window.fixture.calls.length === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.calls.map((c) => [
        c.type,
        c.value.id,
        c.value.itemIds,
        c.value.action,
      ]),
    ),
    [
      ["download-action", "job0", ["0-1"], "pause"],
      ["download-action", "job1", ["1-1"], "pause"],
    ],
  );
  await header.getByRole("button", { name: "批量取消", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog").count(), 1);
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "取消下载", exact: true })
    .click();
  await page.waitForFunction(() => window.fixture.calls.length === 4);
  assert.equal(
    await panel.getByRole("button", { name: "多选任务", exact: true }).count(),
    0,
  );
  assert.equal(await panel.locator(".download-selection-bar").count(), 1);
  const offsets = [];
  for (const [mode, title, width] of [
    ["tasks", "任务", 440],
    ["history", "浏览历史", 360],
    ["bookmarks", "收藏", 360],
    ["tabs", "搜索标签页", 360],
  ]) {
    await page.setViewportSize({ width, height: 520 });
    await page.evaluate((mode) => window.fixture.update({ mode }), mode);
    const surface = page.getByRole("dialog", { name: title, exact: true });
    await surface.waitFor();
    offsets.push(
      await surface.evaluate((el) => {
        const header = el.querySelector("header"),
          box = el.getBoundingClientRect(),
          head = header.getBoundingClientRect();
        return {
          left: head.x - box.x,
          listLeft:
            el
              .querySelector(
                '.task-top, .bookmark-row, [data-slot="command-item"]',
              )
              .getBoundingClientRect().x - box.x,
          top: head.y - box.y,
          height: head.height,
          padding: getComputedStyle(el).padding,
        };
      }),
    );
    await page.screenshot({ path: `test-results/quick-panel-${mode}.png` });
  }
  assert(
    offsets.every(
      (offset) => JSON.stringify(offset) === JSON.stringify(offsets[0]),
    ),
  );
  assert.deepEqual(offsets[0], {
    left: 12,
    listLeft: 12,
    top: 8,
    height: 24,
    padding: "8px 12px 12px",
  });
  for (const [mode, title, region] of [
    ["bookmarks", "收藏", ".bookmark-list"],
    ["history", "浏览历史", '[data-slot="command-list"]'],
    ["tasks", "任务", ".quick-task-list"],
    ["tabs", "搜索标签页", '[data-slot="command-list"]'],
  ]) {
    await page.setViewportSize({
      width: mode === "tasks" ? 440 : 360,
      height: 520,
    });
    await page.evaluate(
      (mode) =>
        window.fixture.update({
          mode,
          jobs: [],
          transfers: [],
          history: [],
          browser: { ...window.fixture.state.browser, bookmarks: [], tabs: [] },
        }),
      mode,
    );
    const surface = page.getByRole("dialog", { name: title, exact: true });
    await surface.waitFor();
    if (mode === "tabs")
      await surface.getByRole("combobox").fill("no matching tab");
    const empty = surface.locator('[data-slot="empty-header"]');
    await empty.waitFor();
    const contentBox = await surface.locator(region).boundingBox();
    const emptyBox = await empty.boundingBox();
    assert(
      Math.abs(
        emptyBox.x + emptyBox.width / 2 - (contentBox.x + contentBox.width / 2),
      ) < 2,
      `${mode} empty state centered horizontally`,
    );
    assert(
      Math.abs(
        emptyBox.y +
          emptyBox.height / 2 -
          (contentBox.y + contentBox.height / 2),
      ) < 2,
      `${mode} empty state centered vertically`,
    );
    assert.equal(
      await surface.locator('[data-slot="empty-icon"] svg').count(),
      1,
    );
    await page.screenshot({ path: `test-results/quick-empty-${mode}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Passed quick-panel shared selection, cross-job bulk actions, fixed single-row header, and consistent panel spacing.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
