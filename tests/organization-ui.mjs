// Isolated, headless library and organization UI. No desktop or external providers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LibraryPage} from './src/ui/library-page';
import {defaultSettings} from './src/shared/settings';
import {newAIConnection} from './src/shared/ai-connections';
import {TooltipProvider} from './src/ui/components/ui/tooltip';
import {LocaleContext} from './src/ui/i18n';
import {applyTheme} from './src/ui/theme';
const preferences={language:'zh',palette:'hazel',mode:'light',refreshOnOpen:false};applyTheme(preferences);
const files=[1,2,3,4].map(i=>({id:'f'+i,connectionId:'storage',root:'/videos',path:'/videos/Mixed/Example.S0'+i+'E01.mkv',relativePath:'Mixed/Example.S0'+i+'E01.mkv',name:'Example.S0'+i+'E01.mkv',size:100,modified:1,duration:120,currentTitle:'混合目录'}));
const plan={jobId:'',files,groups:[{id:'g1',title:'示例作品 · 第一季',fileIds:['f1','f4'],episodes:[{number:'01',title:'开场',versions:[{label:'版本 A',releaseKey:'A',fileIds:['f1']},{label:'版本 B',releaseKey:'B',fileIds:['f4']}]}],review:false,reason:'文件名中包含季数。',changes:{previousTitles:['混合目录'],title:true,membership:true,order:false,manual:false}},{id:'g2',title:'示例作品 · 第二季',fileIds:['f2'],review:true,reason:'目录名与文件名不一致，请确认。',changes:{previousTitles:['混合目录'],title:true,membership:true,order:true,manual:true}}],collections:[{id:'c1',name:'示例作品系列',groupIds:['g1','g2']}],unassigned:['f3'],excludedCount:0};
const work={id:'w1',connectionId:'storage',root:'/videos',path:'/videos/Mixed',title:'混合目录',description:'',tags:[],createdAt:1,order:0,resumeId:null,episodes:files.map((f,i)=>({...f,workId:'w1',fileName:f.name,number:String(i+1),title:'',description:'',position:0,order:i,missing:false}))};
let current={preferences,connections:[{id:'storage',type:'local',name:'本地片源',roots:['/videos'],scanDepths:{'/videos':2},status:'connected',error:null,scannedAt:1}],works:new URLSearchParams(location.search).has('empty')?[]:[work],collections:[{id:'existing',name:'测试合集',workIds:['w1']}],transfers:[],refreshing:false,settings:{...defaultSettings('zh'),aiConnections:[{...newAIConnection('openai'),id:'ai',name:'已连接的账号',hasKey:true}]}};
let emit=()=>{};
window.fixture={calls:[],pending:false,reject:null,stale:false};
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});
 if(type==='ai-feature-models')return [{id:'model',name:'Fixture model'}];
 if(type==='organize'||type==='organize-refine'){if(window.fixture.pending)return new Promise((resolve,reject)=>{window.fixture.reject=reject;});return {...plan,jobId:value.jobId};}
 if(type==='organize-progress')return {phase:'grouping',completed:1,total:2};
 if(type==='organize-cancel'){window.fixture.reject?.(new Error('recognitionCancelled'));window.fixture.reject=null;return;}
 if(type==='organize-apply'){if(window.fixture.stale)throw new Error('organizationStale');return {works:value.groups.length};}
 if(type==='remove-collection'){current={...current,collections:current.collections.filter(c=>c.id!==value)};emit(current);return current;}
 if(type==='save-collection')return current;
 throw new Error('Unexpected request '+type);
}};
function Harness(){const [state,setState]=useState(current);emit=setState;return <LocaleContext value="zh"><TooltipProvider><div style={{height:'100dvh'}}><LibraryPage state={state} settings={()=>{}} tasks={()=>{}} detail={()=>{}}/></div></TooltipProvider></LocaleContext>;}
createRoot(document.getElementById('root')).render(<Harness/>);
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
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mkdir("test-results", { recursive: true });
  await page.goto(base);
  await page
    .getByRole("button", { name: "测试合集", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "移除合集", exact: true }).click();
  let confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.calls.filter((c) => c.type === "remove-collection")
          .length,
    ),
    0,
  );
  await page.getByRole("button", { name: "移除合集", exact: true }).click();
  await confirmation.waitFor();
  await page.screenshot({
    path: "test-results/collection-remove.png",
    animations: "disabled",
  });
  await confirmation.getByRole("button", { name: "移除", exact: true }).click();
  await page
    .locator(".page-title")
    .filter({ hasText: /^片库$/ })
    .waitFor();
  assert.equal((await page.locator(".media-card").count()) > 0, true);
  const setup = async () => {
    await page.getByRole("button", { name: "智能整理", exact: true }).click();
    await page.getByRole("combobox", { name: "AI 连接", exact: true }).click();
    await page
      .getByRole("option", { name: "已连接的账号", exact: true })
      .click();
    await page.getByRole("button", { name: "获取模型", exact: true }).click();
    await page.getByRole("combobox", { name: "模型", exact: true }).click();
    await page
      .getByRole("option", { name: "Fixture model", exact: true })
      .click();
  };
  await setup();
  await page.screenshot({
    path: "test-results/organization-setup.png",
    animations: "disabled",
  });
  await page.evaluate(() => (window.fixture.pending = true));
  await page.getByRole("button", { name: "生成方案", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() =>
      window.fixture.calls.some((c) => c.type === "organize-apply"),
    ),
    false,
  );
  await page.evaluate(() => (window.fixture.pending = false));
  await page.getByRole("button", { name: "生成方案", exact: true }).click();
  await page
    .getByRole("tab", { name: "作品 · 2", exact: true, includeHidden: true })
    .waitFor({ state: "attached" });
  const feedbackDialog = page.getByRole("dialog", { name: "确认与补充意见" });
  await feedbackDialog.waitFor();
  await feedbackDialog
    .getByText("目录名与文件名不一致，请确认。", { exact: true })
    .waitFor();
  assert(
    await feedbackDialog
      .getByRole("button", { name: "修订方案", exact: true })
      .isDisabled(),
  );
  await page.screenshot({
    path: "test-results/organization-feedback.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 420, height: 640 });
  await page.waitForFunction(() => {
    const r = document
      .querySelector(".organization-feedback-modal")
      ?.getBoundingClientRect();
    return r && r.x >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  });
  const narrow = await feedbackDialog.boundingBox();
  await page.screenshot({
    path: "test-results/organization-feedback-420.png",
    animations: "disabled",
  });
  assert(
    narrow.x >= 0 &&
      narrow.y >= 0 &&
      narrow.x + narrow.width <= 420 &&
      narrow.y + narrow.height <= 640,
  );
  assert.equal(
    await feedbackDialog.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await page.screenshot({
    path: "test-results/organization-feedback-420.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".organization-feedback-modal")
        ?.getBoundingClientRect().width === 680,
  );
  const beforeDialog = await feedbackDialog.boundingBox();
  await feedbackDialog
    .getByRole("textbox")
    .fill("保留合理的分组，核实存在冲突的归属。");
  await page.evaluate(() => (window.fixture.pending = true));
  await feedbackDialog
    .getByRole("button", { name: "修订方案", exact: true })
    .click();
  await feedbackDialog
    .getByRole("button", { name: "正在修订", exact: true })
    .waitFor();
  const duringDialog = await feedbackDialog.boundingBox();
  assert.equal(beforeDialog.height, duringDialog.height);
  await feedbackDialog
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await feedbackDialog
    .getByRole("button", { name: "修订方案", exact: true })
    .waitFor();
  assert.equal(
    await feedbackDialog.getByRole("textbox").inputValue(),
    "保留合理的分组，核实存在冲突的归属。",
  );
  await page.evaluate(() => (window.fixture.pending = false));
  await feedbackDialog
    .getByRole("button", { name: "修订方案", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.fixture.calls.filter((c) => c.type === "organize-refine")
        .length === 2,
  );
  await feedbackDialog.getByRole("textbox").waitFor();
  await page.waitForFunction(
    () => document.querySelector("#organization-feedback")?.value === "",
  );
  assert.equal(
    await page.evaluate(() =>
      window.fixture.calls.some((c) => c.type === "organize-apply"),
    ),
    false,
  );
  await feedbackDialog
    .getByRole("button", { name: "查看方案", exact: true })
    .click();
  assert(
    await page
      .getByRole("checkbox", { name: "示例作品 · 第一季", exact: true })
      .isChecked(),
  );
  assert(
    !(await page
      .getByRole("checkbox", { name: "示例作品 · 第二季", exact: true })
      .isChecked()),
  );
  await page
    .getByRole("button", { name: "查看文件", exact: true })
    .first()
    .click();
  assert.equal(
    await page.getByText("原名称 · 混合目录", { exact: true }).count(),
    2,
  );
  await page.getByText("1 集 · 2 个版本 · 2 个文件", { exact: true }).waitFor();
  await page.getByText("版本 A", { exact: true }).waitFor();
  await page.getByText("版本 B", { exact: true }).waitFor();
  await page.getByText("涉及手动修改", { exact: true }).waitFor();
  await page.getByText("顺序调整", { exact: true }).waitFor();
  await page.screenshot({
    path: "test-results/organization-review.png",
    animations: "disabled",
  });
  await page
    .getByRole("checkbox", { name: "示例作品 · 第二季", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "作品名称 · 示例作品 · 第一季", exact: true })
    .fill("用户确认的第一季");
  await page.getByRole("tab", { name: "合集 · 1", exact: true }).click();
  assert(
    await page
      .getByRole("checkbox", { name: "示例作品系列", exact: true })
      .isChecked(),
  );
  await page.screenshot({
    path: "test-results/organization-collections.png",
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "未归组 · 1", exact: true }).click();
  await page.getByText("Example.S03E01.mkv", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "作品 · 2", exact: true }).click();
  for (const width of [620, 420]) {
    await page.setViewportSize({ width, height: 820 });
    assert.equal(
      await page
        .locator(".organization-page")
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await page.screenshot({
      path: `test-results/organization-review-${width}.png`,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.getByRole("button", { name: "应用整理", exact: true }).click();
  const applyDialog = page.getByRole("dialog");
  await applyDialog
    .getByText(
      "将按选中的方案更新片库分组，保留播放进度。源文件不会移动、重命名或删除；未选中的建议保持原状。",
      { exact: true },
    )
    .waitFor();
  await applyDialog
    .getByRole("button", { name: "应用整理", exact: true })
    .click();
  await page
    .locator(".page-title")
    .filter({ hasText: /^片库$/ })
    .waitFor();
  const payload = await page.evaluate(
    () => window.fixture.calls.find((c) => c.type === "organize-apply").value,
  );
  assert.equal(payload.groups.length, 2);
  assert.equal(payload.groups[0].title, "用户确认的第一季");
  assert.deepEqual(payload.collectionIds, ["c1"]);
  await page.goto(base + "?empty");
  await page
    .getByRole("button", { name: "测试合集", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "移除合集", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "移除", exact: true })
    .click();
  await page
    .locator(".page-title")
    .filter({ hasText: /^片库$/ })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Organization UI passed: setup, cancel, review selection, edits, flat collections, unassigned files, confirmation, responsive layout, and deletion of populated/empty collections.",
  );
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections();
}
