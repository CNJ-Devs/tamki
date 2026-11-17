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
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{LibraryPage}from'./src/ui/library-page';import{TooltipProvider}from'./src/ui/components/ui/tooltip';import{LocaleContext}from'./src/ui/i18n';import{applyTheme}from'./src/ui/theme';import{defaultSettings,newSource}from'./src/shared/settings';
const preferences={language:'zh',palette:'hazel',mode:'light',refreshOnOpen:false};applyTheme(preferences);
const works=Array.from({length:6},(_,i)=>({id:'w'+i,title:['完整作品','待补作品1','待补作品2','待补作品3','离线作品','需要选择的作品'][i],description:i===1||i===0?'Existing synopsis':'',cover:i===0||i===2?'cover':undefined,tags:[],connectionId:'fixture',root:'/media',path:'/media/'+i,createdAt:i,order:i,resumeId:null,recognition:i===5?{status:'needs-choice',sourceId:'bilibili',signature:'fixture'}:undefined,episodes:[{id:'e'+i,workId:'w'+i,connectionId:'fixture',path:'/media/'+i+'.mkv',fileName:'01.mkv',number:'1',title:'',description:'',size:10,modified:1,duration:120,position:0,order:0,missing:i===4}]}));
let current={preferences,connections:[],works,series:[],collections:[],transfers:[],refreshing:false,settings:defaultSettings('zh')};current.settings.recognition.automatic=false;
current.settings.recognition.sources=[{...newSource('openai-compatible'),id:'profile',name:'我的识别来源',connectionId:'connection',model:'fixture',hasKey:true,hasSearchKey:false,models:[]}];
let emit=()=>{};window.fixture={calls:[],state:()=>current,finish:(id,status='complete')=>{current={...current,works:current.works.map(w=>w.id===id?{...w,description:'Filled synopsis',recognition:{...w.recognition,status}}:w)};emit(current);}};
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});
if(type==='recognize-batch'){current={...current,works:current.works.map(w=>value.workIds.includes(w.id)?{...w,recognition:{status:'queued',requested:true,sourceId:value.sourceId,signature:'batch'}}:w)};emit(current);return{queued:value.workIds,skipped:0};}
if(type==='cancel-recognition-batch'){current={...current,works:current.works.map(w=>value.workIds.includes(w.id)?{...w,recognition:{...w.recognition,status:'failed',error:'recognitionCancelled'}}:w)};emit(current);return true;}
if(type==='cover')return null;throw Error(type);}};
function Harness(){const[state,setState]=useState(current);emit=setState;return <LocaleContext value="zh"><TooltipProvider><div style={{height:'100dvh'}}><LibraryPage state={state} settings={()=>{}} tasks={()=>{}} detail={id=>window.fixture.inspected=id}/></div></TooltipProvider></LocaleContext>}createRoot(document.getElementById('root')).render(<Harness/>);
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
    res.setHeader("content-type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("content-type", "text/css");
    res.end(css);
  } else
    res.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByRole("button", { name: "批量识别", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "识别 4 部作品", exact: true })
    .waitFor();
  assert(
    await dialog
      .getByRole("checkbox", { name: "离线作品", exact: true })
      .isDisabled(),
  );
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "全选", exact: true })
      .getAttribute("data-state"),
    "indeterminate",
  );
  assert(
    (await dialog.boundingBox()).width >= 700,
    "batch dialog should use available width",
  );
  await dialog.getByRole("checkbox", { name: "全选", exact: true }).click();
  await dialog
    .getByRole("button", { name: "识别 5 部作品", exact: true })
    .waitFor();
  await dialog.getByRole("checkbox", { name: "全选", exact: true }).click();
  assert(
    await dialog
      .getByRole("button", { name: "识别 0 部作品", exact: true })
      .isDisabled(),
  );
  await dialog
    .getByRole("button", { name: "只选资料不全的作品", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "搜索", exact: true })
    .fill("待补作品1");
  await dialog.getByRole("checkbox", { name: "全选", exact: true }).click();
  await dialog.getByRole("textbox", { name: "搜索", exact: true }).fill("");
  await dialog
    .getByRole("button", { name: "识别 3 部作品", exact: true })
    .waitFor();
  await dialog
    .getByRole("button", { name: "只选资料不全的作品", exact: true })
    .click();
  await dialog.getByRole("combobox", { name: "识别来源", exact: true }).click();
  await page
    .getByRole("option", { name: "我的识别来源", exact: true })
    .waitFor();
  await page.getByRole("option", { name: "Bilibili", exact: true }).click();
  await dialog
    .getByRole("button", { name: "识别 4 部作品", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "取消未完成", exact: true })
    .waitFor();
  const call = await page.evaluate(() =>
    window.fixture.calls.find((c) => c.type === "recognize-batch"),
  );
  assert.equal(call.value.sourceId, "bilibili");
  assert.deepEqual(call.value.workIds, ["w1", "w2", "w3", "w5"]);
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.calls.filter(
          (c) => c.type === "cancel-recognition-batch",
        ).length,
    ),
    0,
  );
  await page.getByRole("button", { name: "批量识别", exact: true }).click();
  await dialog
    .getByRole("button", { name: "取消未完成", exact: true })
    .waitFor();
  assert.match(
    await dialog
      .getByRole("combobox", { name: "识别来源", exact: true })
      .innerText(),
    /Bilibili/,
  );
  await page.evaluate(() => window.fixture.finish("w1"));
  await dialog.getByText("已处理 1 / 4", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "取消未完成", exact: true }).click();
  await dialog.getByText("已处理 4 / 4", { exact: true }).waitFor();
  const cancelled = await page.evaluate(() =>
    window.fixture.calls.find((c) => c.type === "cancel-recognition-batch"),
  );
  assert.deepEqual(cancelled.value.workIds, ["w2", "w3", "w5"]);
  await page.setViewportSize({ width: 420, height: 640 });
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/batch-recognition-420.png" });
  assert((await dialog.boundingBox()).width <= 420);
  assert(
    await dialog
      .locator(".modal-body")
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  );
  assert(
    await dialog
      .locator(".modal-footer")
      .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Batch identification UI passed: source selection, incomplete defaults, filtered select-all, persisted progress, cancellation, close-without-cancel and narrow single-scroll layout.",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
