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
plan.groups[1].review=false;
plan.groups.push({id:'g3',title:'独立作品',fileIds:['f3'],review:false,reason:''});plan.unassigned=[];
plan.collections=[{id:'s1',kind:'series',name:'样例系列',groupIds:['g1','g2']},{id:'c1',kind:'collection',name:'样例合集',groupIds:['g1','g2','g3']}];
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
    .getByRole("tab", { name: "作品 · 3", exact: true, includeHidden: true })
    .waitFor({ state: "attached" });
  await page.getByRole("tab", { name: "系列 · 1", exact: true }).click();
  assert.equal(
    await page.getByRole("checkbox", { name: "样例系列", exact: true }).count(),
    1,
  );
  await page.getByRole("tab", { name: "合集 · 1", exact: true }).click();
  const collection = page.locator(".organization-collection");
  assert.ok((await collection.innerText()).includes("样例系列"));
  assert.ok((await collection.innerText()).includes("独立作品"));
  assert.ok(!(await collection.innerText()).includes("示例作品 · 第一季"));
  await page.screenshot({
    path: "test-results/organization-collection-hierarchy.png",
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "系列 · 1", exact: true }).click();
  await page.getByRole("checkbox", { name: "样例系列", exact: true }).uncheck();
  await page.getByRole("tab", { name: "合集 · 1", exact: true }).click();
  assert.ok((await collection.innerText()).includes("示例作品 · 第一季"));
  assert.ok(!(await collection.innerText()).includes("样例系列"));
  await page.getByRole("tab", { name: "作品 · 3", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "示例作品 · 第一季", exact: true })
    .uncheck();
  await page.getByRole("tab", { name: "系列 · 1", exact: true }).click();
  assert.ok(
    await page
      .getByRole("checkbox", { name: "样例系列", exact: true })
      .isDisabled(),
  );
  const help = page.getByRole("button", {
    name: "请先在作品页审阅并勾选以下成员：示例作品 · 第一季",
    exact: true,
  });
  await help.focus();
  await page.getByRole("tooltip").waitFor();
  assert.ok(
    (await page.getByRole("tooltip").innerText()).includes("示例作品 · 第一季"),
  );
  await page.setViewportSize({ width: 420, height: 640 });
  await page.getByRole("tab", { name: "系列 · 1", exact: true }).click();
  await page.screenshot({
    path: "test-results/organization-series-420.png",
    animations: "disabled",
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Separate series/collection tabs and mixed membership preview passed",
  );
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections();
}
