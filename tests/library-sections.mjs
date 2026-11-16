// Headless navigation and responsive layout with synthetic artwork and state.
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
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {LibraryPage,DetailPage} from './src/ui/library-page';import {TooltipProvider} from './src/ui/components/ui/tooltip';import {LocaleContext} from './src/ui/i18n';import {applyTheme} from './src/ui/theme';import {defaultSettings} from './src/shared/settings';
const p=new URLSearchParams(location.search),lang=p.get('lang')||'zh';
const preferences={language:lang,palette:'hazel',mode:p.get('mode')||'light',refreshOnOpen:false};applyTheme(preferences);
const titles=['春日来信','远山回响','星际旅人','夜航船','夏日手记','雨中漫步','蓝色星期天','光影之间'];
const works=Array.from({length:16},(_,i)=>({id:'w'+i,title:titles[Math.floor(i/2)]+' · '+(i%2?'第二部':'第一部'),cover:'cover-'+i,connectionId:'fixture',root:'/media',path:'/media/'+i,description:'',tags:[],createdAt:i,order:i,resumeId:'e'+i,episodes:[{id:'e'+i,workId:'w'+i,connectionId:'fixture',path:'/media/'+i+'.mp4',fileName:i+'.mp4',number:'1',title:'旅程',description:'',size:100,modified:1,duration:120,position:i%2?120:0,order:0,missing:false}]}));
let state={preferences,connections:[],works,series:titles.map((name,i)=>({id:'s'+i,name,workIds:['w'+(i*2),'w'+(i*2+1)]})),collections:titles.map((_,i)=>({id:'c'+i,name:['周末放映室','长途旅行','午后时光','好故事','夏日片单','经典回顾','朋友推荐','待看精选'][i],workIds:i===0?['w2']:['w'+(i*2)],seriesIds:i===0?['s0']:[]})),transfers:[],refreshing:false,settings:defaultSettings(lang)};
if(p.has('empty'))state={...state,works:[],series:[],collections:[]};
if(p.has('six'))state={...state,series:state.series.slice(0,6),collections:state.collections.slice(0,6)};
let emit=()=>{};window.fixture={calls:[],state};
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});
 if(type==='cover')return location.origin+'/cover/'+value;
 if(type==='save-series'){state={...state,series:[...state.series,{...value,id:'new-series'}]};emit(state);return;}
 if(type==='save-collection'){state={...state,collections:[...state.collections,{...value,id:'new-collection'}]};emit(state);return;}
 if(type==='remove-collection'){state={...state,collections:state.collections.filter(c=>c.id!==value)};emit(state);return;}
 if(type==='remove-series'){state={...state,series:state.series.filter(c=>c.id!==value)};emit(state);return;}
 throw new Error(type);
}};
function Harness(){const[s,set]=useState(state),[id,setId]=useState(null);emit=set;const work=s.works.find(w=>w.id===id);return <LocaleContext value={lang}><TooltipProvider><div style={{height:'100dvh'}}><div hidden={!!work} style={{height:'100%'}}><LibraryPage state={s} settings={()=>{}} tasks={()=>{}} detail={setId}/></div>{work&&<DetailPage key={work.id} state={s} work={work} onBack={()=>setId(null)} onSelectWork={setId} onEdit={()=>{}} onPlay={()=>{}}/>}</div></TooltipProvider></LocaleContext>};createRoot(document.getElementById('root')).render(<Harness/>);
`,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await readFile("dist/ui/style.css");
const palettes = [
  ["#ccb8aa", "#4e675b"],
  ["#a6b8bb", "#395566"],
  ["#232f47", "#bfa683"],
  ["#937e70", "#d6c5a9"],
  ["#bfad78", "#545f50"],
  ["#829d99", "#354d5d"],
  ["#8192b3", "#ded3bc"],
  ["#998f9d", "#5b4a5b"],
];
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else if (req.url.startsWith("/cover/")) {
    const i = Number(req.url.split("-").at(-1)),
      [a, b] = palettes[Math.floor(i / 2) % 8];
    res.setHeader("Content-Type", "image/svg+xml");
    res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480" viewBox="0 0 320 480"><rect width="320" height="480" fill="${a}"/><circle cx="${i % 2 ? 100 : 230}" cy="180" r="90" fill="${b}" opacity=".7"/><path d="M0 380 Q160 200 320 320 L320 480H0" fill="${b}"/><text x="25" y="420" font-size="38" fill="#fff" font-family="sans-serif">${String(i + 1).padStart(2, "0")}</text></svg>`,
    );
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
    viewport: { width: 1440, height: 1250 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = "http://127.0.0.1:" + server.address().port;
  await page.goto(base);
  const shelves = page.locator(".library-shelf");
  const works = page.locator(".library-works");
  assert.equal(await shelves.count(), 2);
  await shelves.nth(1).locator(".group-cover img").first().waitFor();
  assert.equal(
    await shelves
      .nth(1)
      .locator(".group-card")
      .first()
      .locator(".group-cover img")
      .count(),
    1,
  );
  assert.match(
    await shelves
      .nth(1)
      .locator(".group-card")
      .first()
      .locator(".group-cover img")
      .getAttribute("src"),
    /\/cover\/cover-0$/,
  );
  for (const shelf of await shelves.all()) {
    assert.equal(await shelf.locator(".group-card").count(), 6);
    await shelf.getByRole("button", { name: "更多", exact: true }).waitFor();
    const tops = await shelf
      .locator(".cover-button")
      .evaluateAll((ns) =>
        ns.map((n) => Math.round(n.getBoundingClientRect().top)),
      );
    assert.equal(new Set(tops).size, 1);
  }
  assert.equal(await works.locator(".media-card").count(), 16);
  await works.getByRole("radio", { name: "已看完", exact: true }).click();
  assert.equal(await works.locator(".media-card").count(), 8);
  assert.equal(await shelves.first().locator(".group-card").count(), 6);
  await works
    .getByRole("textbox", { name: "搜索", exact: true })
    .fill("不存在");
  assert.equal(await works.locator(".media-card").count(), 0);
  assert.equal(await shelves.last().locator(".group-card").count(), 6);
  await shelves
    .first()
    .getByRole("button", { name: "更多", exact: true })
    .click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.locator(".group-card").count(), 8);
  assert.equal(await page.locator(".page-header .actions button").count(), 1);
  await page.getByRole("button", { name: "新建合集", exact: true }).waitFor();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/library-collections-page.png" });
  await page
    .getByRole("button", { name: "周末放映室", exact: true })
    .first()
    .click();
  assert.equal(await page.locator(".group-card").count(), 1);
  assert.equal(await page.locator(".media-card:not(.group-card)").count(), 1);
  assert.equal(
    await page.getByRole("button", { name: "移除合集", exact: true }).count(),
    1,
  );
  assert.equal(await page.locator(".page-header .actions button").count(), 2);
  await page.getByRole("button", { name: "合集管理", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "移除合集", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "移除合集", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.calls.filter((c) => c.type === "remove-collection")
          .length,
    ),
    0,
  );
  await page
    .locator(".page-header")
    .screenshot({ path: "test-results/collection-header-actions.png" });
  await page
    .getByRole("button", { name: "春日来信", exact: true })
    .first()
    .click();
  assert.equal(await page.locator(".library-works .media-card").count(), 2);
  assert.equal(await page.locator(".page-header .actions button").count(), 2);
  await page.getByRole("button", { name: "管理系列", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "解散系列", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "解散系列", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page
    .locator(".page-header")
    .screenshot({ path: "test-results/series-header-actions.png" });

  await page
    .getByRole("button", { name: "春日来信 · 第一部", exact: true })
    .first()
    .click();
  await page.locator(".detail-hero").waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).last().click();
  assert.equal(await page.locator(".library-works .media-card").count(), 2);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "合集管理", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await page.locator(".group-card").count(), 8);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await works.locator(".media-card").count(), 0);
  await works.getByRole("textbox", { name: "搜索", exact: true }).fill("");
  await works.getByRole("radio", { name: "全部", exact: true }).click();
  await shelves
    .last()
    .getByRole("button", { name: "更多", exact: true })
    .click();
  assert.equal(await page.locator(".group-card").count(), 8);
  assert.equal(await page.locator(".page-header .actions button").count(), 1);
  await page.getByRole("button", { name: "新建系列", exact: true }).click();
  await page.getByRole("dialog", { name: "新建系列", exact: true }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".group-cover img")].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  await page.screenshot({
    path: "test-results/library-three-sections.png",
    animations: "disabled",
  });
  for (const [width, count] of [
    [980, 4],
    [700, 3],
    [420, 2],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.waitForFunction(
      (n) =>
        document.querySelector(".library-shelf .library-grid").children
          .length === n,
      count,
    );
    assert.equal(await shelves.first().locator(".group-card").count(), count);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    if (width === 420)
      await page.screenshot({
        path: "test-results/library-three-sections-narrow.png",
      });
  }
  await page.setViewportSize({ width: 1440, height: 1250 });
  await page.goto(base + "?six");
  assert.equal(
    await page.getByRole("button", { name: "更多", exact: true }).count(),
    0,
  );
  await page.goto(base + "?empty");
  assert.equal(await shelves.count(), 2);
  await shelves
    .first()
    .getByRole("button", { name: "新建合集", exact: true })
    .click();
  await page.getByRole("dialog", { name: "新建合集", exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "合集名称", exact: true })
    .fill("空合集");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByRole("button", { name: "空合集", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "合集管理", exact: true }).waitFor();
  await page.getByRole("button", { name: "移除合集", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "移除", exact: true })
    .click();
  await page
    .locator(".page-title")
    .filter({ hasText: /^片库$/ })
    .waitFor();
  assert.equal(await page.locator(".group-card").count(), 0);
  await page.goto(base);
  await page
    .getByRole("button", { name: "春日来信", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "解散系列", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "解散系列", exact: true })
    .click();
  await page
    .locator(".page-title")
    .filter({ hasText: /^片库$/ })
    .waitFor();
  assert.equal(await page.locator(".library-works .media-card").count(), 16);
  assert.equal(
    await page.evaluate(() => window.fixture.state.works.length),
    16,
  );
  await page.goto(base + "?lang=en&mode=dark");
  await page.locator(".group-cover img").first().waitFor();
  await page.screenshot({
    path: "test-results/library-three-sections-dark.png",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Passed independent shelves and work filters, six-card previews, responsive overflow, full catalogues, mixed collection/series navigation, back stack, creation and empty states.",
  );
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections();
}
