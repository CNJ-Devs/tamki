import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{Tasks}from'./src/ui/tasks';import{TooltipProvider}from'./src/ui/components/ui/tooltip';import{LocaleContext}from'./src/ui/i18n';import{defaultSettings}from'./src/shared/settings';import{applyTheme}from'./src/ui/theme';
const preferences={language:'zh',palette:'hazel',mode:'light',refreshOnOpen:false};applyTheme(preferences);
const jobs=['第一季','第二季'].map((name,index)=>({id:'job'+index,name:'示例作品 · '+name,target:{connectionId:'local',path:'/media/'+index},series:true,createdAt:1,items:[1,2].map(n=>({id:index+'-'+n,name:name+' · 第'+n+'集.mp4',state:n===1?'queued':'completed',stage:'transferring',received:0,total:100,qualityLabel:'1080P',resource:{id:index+'-'+n,provider:'bilibili',title:'Episode',aid:1,bvid:'BV0000000001',cid:1,duration:30}}))}));
window.fixture={calls:[],jobs};window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});return {};}};
const state={preferences,settings:defaultSettings('zh'),connections:[],works:[],collections:[],series:[],transfers:[],videoDownloads:jobs,refreshing:false};
createRoot(document.getElementById('root')).render(<LocaleContext value="zh"><TooltipProvider><Tasks state={state} onBack={()=>{}} play={()=>{}}/></TooltipProvider></LocaleContext>);
`,
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await readFile("dist/ui/style.css");
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("content-type", "text/css");
    res.end(css);
  } else
    res.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (let i = 0; i < 2; i++)
    await page
      .getByRole("button", { name: "展开任务", exact: true })
      .first()
      .click();
  await page
    .getByRole("checkbox", { name: "第一季 · 第1集.mp4", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "第二季 · 第1集.mp4", exact: true })
    .check();
  await page.getByRole("button", { name: "批量暂停", exact: true }).click();
  await page.waitForFunction(() => window.fixture.calls.length === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.calls.map((c) => [
        c.value.id,
        c.value.itemIds,
        c.value.action,
      ]),
    ),
    [
      ["job0", ["0-1"], "pause"],
      ["job1", ["1-1"], "pause"],
    ],
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/download-batch-selection.png" });
  await page.getByRole("button", { name: "批量取消", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog").count(), 1);
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "取消下载", exact: true })
    .click();
  await page.waitForFunction(() => window.fixture.calls.length === 4);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.calls
        .slice(2)
        .map((c) => [c.value.id, c.value.itemIds, c.value.action]),
    ),
    [
      ["job0", ["0-1"], "cancel"],
      ["job1", ["1-1"], "cancel"],
    ],
  );
  console.log(
    "Passed cross-task video selection, scoped batch pause and single-confirmation cancellation.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
