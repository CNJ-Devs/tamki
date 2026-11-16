import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";
const bundle = await build({
  stdin: {
    loader: "tsx",
    resolveDir: process.cwd(),
    contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{LibraryPage,DetailPage}from'./src/ui/library-page';import{TooltipProvider}from'./src/ui/components/ui/tooltip';import{LocaleContext}from'./src/ui/i18n';import{applyTheme}from'./src/ui/theme';import{defaultSettings}from'./src/shared/settings';
const preferences={language:'zh',palette:'hazel',mode:'light',refreshOnOpen:false};applyTheme(preferences);
const works=['第一部','第二部','独立作品'].map((title,i)=>({id:'w'+i,connectionId:'local',root:'/media',path:'/media/'+title,title,description:'作品简介',tags:[],createdAt:1,order:i,resumeId:null,episodes:[{id:'e'+i,workId:'w'+i,connectionId:'local',path:'/media/'+i+'.mp4',fileName:i+'.mp4',number:'1',title:'',description:'',size:100,modified:1,duration:120,position:0,order:0,missing:false}]}));
let current={preferences,connections:[],works,series:[],collections:[],transfers:[],refreshing:false,settings:defaultSettings('zh')};let emit=()=>{};
window.fixture={calls:[],getState:()=>current};
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});
if(type==='save-series'){const s={...value,id:value.id||'s1'};current={...current,series:[...current.series.filter(x=>x.id!==s.id),s]};}
else if(type==='save-collection'){current={...current,collections:[{...value,id:'c1'}]};}
else if(type==='remove-series'){current={...current,series:current.series.filter(x=>x.id!==value)};}
else if(type==='thumbnail')return null;
else throw new Error(type);
emit(current);return current;}};
function Harness(){const[state,setState]=useState(current),[id,setId]=useState(null);emit=setState;const work=state.works.find(w=>w.id===id);return <LocaleContext value="zh"><TooltipProvider><div style={{height:'100dvh'}}>{work?<DetailPage key={work.id} work={work} state={state} onBack={()=>setId(null)} onSelectWork={setId} onEdit={()=>{}} onPlay={()=>{}}/>:<LibraryPage state={state} settings={()=>{}} tasks={()=>{}} detail={setId}/>}</div></TooltipProvider></LocaleContext>;}createRoot(document.getElementById('root')).render(<Harness/>);
`,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await readFile("dist/ui/style.css");
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    );
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 780 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByRole("button", { name: "新建系列", exact: true }).click();
  await page.getByLabel("系列名称").fill("测试系列");
  await page.locator("label.folder-row").filter({ hasText: "第一部" }).click();
  await page.locator("label.folder-row").filter({ hasText: "第二部" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(
    () => window.fixture.getState().series.length === 1,
  );
  assert.equal(await page.locator(".media-card").count(), 4);
  await page
    .getByRole("button", { name: "测试系列", exact: true })
    .first()
    .click();
  assert.equal(await page.locator(".library-works .media-card").count(), 2);
  await page
    .getByRole("button", { name: "第一部", exact: true })
    .first()
    .click();
  assert.equal(await page.getByRole("tab").count(), 2);
  await page.getByRole("tab", { name: "第二部", exact: true }).click();
  assert.equal(
    await page
      .getByRole("tab", { name: "第二部", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/series-detail.png" });
  await page.getByRole("button", { name: "管理系列", exact: true }).click();
  await page.getByLabel("系列名称").fill("改名系列");
  const rows = page.locator(".series-member");
  await rows.first().focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () =>
      document.querySelector(".series-member")?.getAttribute("aria-pressed") ===
      "true",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => {
    const s = document.querySelector(".series-member")?.style.transform;
    return s && !s.includes("translate3d(0px, 0px, 0px)");
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(
    () => window.fixture.getState().series[0].name === "改名系列",
  );
  assert.deepEqual(
    await page.evaluate(() => window.fixture.getState().series[0].workIds),
    ["w1", "w0"],
  );
  await page.setViewportSize({ width: 420, height: 780 });
  await page.waitForFunction(
    () => document.documentElement.clientWidth === 420,
  );
  await page.screenshot({ path: "test-results/series-detail-420.png" });
  assert.ok(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  );
  await page.getByRole("button", { name: "管理系列", exact: true }).click();
  await page
    .getByRole("dialog", { name: "管理系列", exact: true })
    .waitFor({ state: "visible" });
  await page.getByLabel("系列名称").waitFor({ state: "visible" });
  await page.screenshot({
    path: "test-results/series-editor-final-420.png",
    animations: "disabled",
  });
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "解散系列", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page
    .getByRole("button", { name: "改名系列", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "解散系列", exact: true }).click();
  // Common confirmation uses the action label as its confirmation button.
  const dialogs = page.getByRole("alertdialog");
  await dialogs.getByRole("button").last().click();
  await page.waitForFunction(
    () => window.fixture.getState().series.length === 0,
  );
  assert.equal(
    await page.evaluate(() => window.fixture.getState().works.length),
    3,
  );
  assert.deepEqual(errors, []);
  console.log(
    "series UI: create, aggregate, switch, rename, keyboard reorder, narrow layout and dissolve passed",
  );
} finally {
  await browser?.close();
  server.close();
}
