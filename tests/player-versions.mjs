// Real browser decoder, synthetic IPC/state, local video bytes; never opens a desktop window.
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
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Player} from './src/ui/player';import {TooltipProvider} from './src/ui/components/ui/tooltip';
import {LocaleContext} from './src/ui/i18n';import {applyTheme} from './src/ui/theme';
applyTheme({mode:'light',palette:'hazel'});
let emit=()=>{};
const make=(id,order)=>({id,workId:'w',number:String(order+1),title:'Episode',description:'',order,versions:['A','B'].map(v=>({id:id+v,label:'Release '+v,releaseKey:v,files:[{id:id+v+'file',connectionId:'local',path:'/video',fileName:v+'.webm',size:100,modified:1,position:v==='B'?0.6:0.2,duration:null,missing:false}]}))});
const project=(e,key)=>{const v=e.versions.find(v=>v.releaseKey===key);return {...e,...v.files[0],id:e.id,activeFileId:v.files[0].id,activeVersionId:v.id};};
let work={id:'w',title:'Version test',episodes:[project(make('e1',0),'A'),project(make('e2',1),'A')]};
const online = new URLSearchParams(location.search).has('online');
if (online) work={id:'w',title:'示例动画',resumeId:'e2',playbackGroups:[{id:'s1',title:'示例动画 · 第一季',episodeIds:['e1','e2']},{id:'s2',title:'示例动画 · 第二季',episodeIds:['e3']},{id:'film',title:'示例动画 · 剧场版',episodeIds:['e4']}],episodes:[1,2,3,4].map((n)=>({...project(make('e'+n,n-1),'A'),versions:undefined,title:'旅途的开始',number:String(n),duration:1440}))};
window.fixture={calls:[],work};
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});
if(type==='online-player-error')return;
if(type==='online-media')return {url:location.origin+'/video?episode='+value.episodeId+'&quality='+value.quality,dash:false,quality:value.quality||80,qualities:[{id:80,label:'1080P 高清'},{id:64,label:'720P 高清'}]};
if(type==='media')return location.origin+'/video?file='+value.fileId;
if(type==='progress'){for(const e of work.episodes)for(const v of e.versions)for(const f of v.files)if(f.id===value.fileId){f.position=value.position;f.duration=value.duration;}return;}
if(type==='select-version'){window.fixture.switchPosition=document.querySelector('video').currentTime;const chosen=work.episodes.find(e=>e.id===value.id).versions.find(v=>v.id===value.versionId);work={...work,episodes:work.episodes.map(e=>project(e,chosen.releaseKey))};window.fixture.work=work;emit(work);return;}
throw new Error('Unexpected IPC '+type);}};
function Harness(){const [state,set]=useState(work);emit=set;return <LocaleContext value={online?"zh":"en"}><TooltipProvider><Player online={online} work={state} active activate={()=>{}}/></TooltipProvider></LocaleContext>};
createRoot(document.getElementById('root')).render(<Harness/>);`,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await readFile("dist/ui/style.css"),
  video = await readFile("tests/fixtures/video.webm");
const server = createServer((req, res) => {
  if (req.url.startsWith("/video")) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = match ? Number(match[1]) : 0,
      end =
        match && match[2]
          ? Math.min(Number(match[2]), video.length - 1)
          : video.length - 1;
    res.writeHead(match ? 206 : 200, {
      "Content-Type": "video/webm",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(match
        ? { "Content-Range": `bytes ${start}-${end}/${video.length}` }
        : {}),
    });
    res.end(video.subarray(start, end + 1));
  } else if (req.url === "/app.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else
    res.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser, page;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  page = await browser.newPage({ viewport: { width: 980, height: 680 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.waitForFunction(
    () => document.querySelector("video").readyState >= 2,
  );
  await page.evaluate(() => {
    const v = document.querySelector("video");
    v.pause();
    v.currentTime = 0.35;
  });
  await page.waitForFunction(() =>
    window.fixture.calls.some(
      (c) =>
        c.type === "progress" &&
        c.value.fileId === "e1Afile" &&
        Math.abs(c.value.position - 0.35) < 0.05,
    ),
  );
  await page.getByRole("combobox", { name: "Version", exact: true }).click();
  await page.getByRole("option", { name: "Release B", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("video").readyState >= 2 &&
      document.querySelector("video").currentSrc.includes("e1Bfile"),
  );
  await page.waitForFunction(
    () => Math.abs(document.querySelector("video").currentTime - 0.35) < 0.05,
  );
  assert(
    await page.locator("video").evaluate((v) => v.paused),
    "switching while paused stays paused",
  );
  await page.locator("video").evaluate((v) => {
    v.currentTime = 0.5;
  });
  await page.getByRole("combobox", { name: "Version", exact: true }).click();
  await page.getByRole("option", { name: "Release A", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("video").readyState >= 2 &&
      document.querySelector("video").currentSrc.includes("e1Afile"),
  );
  await page.waitForFunction(
    () => Math.abs(document.querySelector("video").currentTime - 0.5) < 0.05,
  );
  // Zero is an explicit handoff, not a request to use the target's saved position.
  await page.locator("video").evaluate((v) => {
    v.currentTime = 0;
  });
  for (const [label, file] of [
    ["Release B", "e1Bfile"],
    ["Release A", "e1Afile"],
  ]) {
    await page.getByRole("combobox", { name: "Version", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await page.waitForFunction((file) => {
      const v = document.querySelector("video");
      return (
        v.readyState >= 2 &&
        v.currentSrc.includes(file) &&
        v.currentTime < 0.04 &&
        v.paused
      );
    }, file);
  }
  await page.getByRole("button", { name: "Next episode", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("video").readyState >= 2 &&
      document.querySelector("video").currentSrc.includes("e2Afile"),
  );
  await page.locator("video").evaluate((v) => v.pause());
  assert(
    (await page.locator("video").evaluate((v) => v.currentTime)) >= 0.15,
    "a different episode uses its own resume position",
  );
  const calls = await page.evaluate(() => window.fixture.calls);
  assert(
    calls
      .filter((c) => c.type === "progress" && c.value.id === "e1")
      .every((c) => c.value.fileId.startsWith("e1")),
  );
  assert(
    calls
      .filter((c) => c.type === "progress" && c.value.id === "e2")
      .every((c) => c.value.fileId.startsWith("e2")),
  );
  await page.setViewportSize({ width: 620, height: 600 });
  assert(
    await page
      .getByRole("combobox", { name: "Version", exact: true })
      .isVisible(),
  );
  assert(
    await page.locator(".player-options").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }),
  );
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.getByRole("combobox", { name: "Version", exact: true }).click();
  assert(
    await page
      .getByRole("option", { name: "Release B", exact: true })
      .isVisible(),
  );
  await page.getByRole("option", { name: "Release B", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("video").readyState >= 2 &&
      document.querySelector("video").currentSrc.includes("e2Bfile"),
  );
  // The same position handoff also retains active playback.
  await page.getByRole("combobox", { name: "Version", exact: true }).click();
  await page.getByRole("option", { name: "Release A", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("video").currentSrc.includes("e2Afile") &&
      document.querySelector("video").readyState >= 2,
  );
  await page.locator("video").evaluate(async (v) => {
    v.currentTime = 0.1;
    await v.play();
  });
  await page.getByRole("combobox", { name: "Version", exact: true }).click();
  await page.getByRole("option", { name: "Release B", exact: true }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v.currentSrc.includes("e2Bfile") && v.readyState >= 2 && !v.paused;
  });
  const playing = await page.locator("video").evaluate((v) => {
    const result = {
      position: v.currentTime,
      expected: window.fixture.switchPosition,
    };
    v.pause();
    return result;
  });
  assert(
    Math.abs(playing.position - playing.expected) < 0.2,
    "playing switch continues at the current timeline position",
  );
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await page.locator(".player-queue").waitFor();
  assert(
    await page
      .locator(".player-queue")
      .evaluate((n) => !!document.fullscreenElement?.contains(n)),
    "fullscreen menu stays in the fullscreen surface",
  );
  await page.keyboard.press("Escape");
  await page.locator(".player-queue").waitFor({ state: "hidden" });
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/player-versions.png" });
  await page.goto("http://127.0.0.1:" + server.address().port + "?online");
  await page.waitForFunction(
    () => document.querySelector("video").readyState >= 2,
  );
  await page.evaluate(() => {
    document.querySelector("video").pause();
    document.querySelector("video").currentTime = 0.6;
  });
  await page.getByRole("combobox", { name: "清晰度", exact: true }).click();
  await page.getByRole("option", { name: "720P 高清", exact: true }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return (
      v.readyState >= 2 &&
      v.currentSrc.includes("quality=64") &&
      v.currentTime >= 0.5
    );
  });
  const queueButton = page.getByRole("button", { name: "选集", exact: true });
  const episodeMenu = page.locator(".player-queue");
  await queueButton.click();
  await episodeMenu.waitFor();
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".player-queue")
        .getAnimations()
        .some((a) => a.playState === "running"),
  );
  const menuPosition = await episodeMenu.evaluate((n) => {
    const button = document.querySelector('[aria-label="选集"]'),
      b = button.getBoundingClientRect(),
      r = n.getBoundingClientRect();
    return {
      gap: b.top - r.bottom,
      left: r.left,
      right: r.right,
      viewport: innerWidth,
    };
  });
  assert(
    Math.abs(menuPosition.gap - 8) < 1,
    "episode menu is anchored 8px above its trigger",
  );
  assert(menuPosition.left >= 0 && menuPosition.right <= menuPosition.viewport);
  assert.equal(
    await episodeMenu
      .getByRole("button", { name: "关闭", exact: true })
      .count(),
    0,
  );
  await page.locator(".player-header").click();
  await episodeMenu.waitFor({ state: "hidden" });
  await queueButton.click();
  await page.getByRole("combobox", { name: "清晰度", exact: true }).focus();
  await episodeMenu.waitFor({ state: "hidden" });
  await queueButton.click();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await episodeMenu.waitFor({ state: "hidden" });
  await queueButton.click();
  await page.keyboard.press("Escape");
  await episodeMenu.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "选集", exact: true }).click();
  assert.equal(
    await page.locator(".player-queue > .fade-scroll button").count(),
    2,
  );
  await page
    .getByRole("button", { name: "示例动画 · 第二季", exact: true })
    .click();
  assert.equal(
    await page.locator(".player-queue > .fade-scroll button").count(),
    1,
  );
  await page.locator(".player-queue > .fade-scroll button").click();
  await page.waitForFunction(() =>
    document.querySelector("video").currentSrc.includes("episode=e3"),
  );
  assert(
    await page
      .getByRole("button", { name: "上一集", exact: true })
      .isDisabled(),
  );
  assert(
    await page
      .getByRole("button", { name: "下一集", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "选集", exact: true }).click();
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.evaluate(async () => {
    document.querySelector("video").pause();
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  if (!(await page.locator(".player-queue").isVisible()))
    await queueButton.click();
  await page.screenshot({
    path: "test-results/player-series-preview.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 620, height: 700 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  if (!(await page.locator(".player-queue").isVisible()))
    await queueButton.click();
  const strip = page.locator(".player-queue-groups");
  await strip.locator(".horizontal-scroll-items").evaluate((n) => {
    n.scrollLeft = 0;
  });
  await strip.getByRole("button", { name: "向右翻页", exact: true }).waitFor();
  assert.equal(
    await strip.getByRole("button", { name: "向左翻页", exact: true }).count(),
    0,
  );
  await strip.getByRole("button", { name: "向右翻页", exact: true }).click();
  await strip
    .getByRole("button", { name: "向右翻页", exact: true })
    .waitFor({ state: "hidden" });
  await strip.getByRole("button", { name: "向左翻页", exact: true }).waitFor();
  const rows = await strip
    .locator(".horizontal-scroll-items > button")
    .evaluateAll((nodes) =>
      nodes.map((n) => Math.round(n.getBoundingClientRect().top)),
    );
  assert.equal(new Set(rows).size, 1);
  await page.screenshot({
    path: "test-results/player-series-narrow.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Passed real media version switching, continuous positions across versions, paused/playing/zero handoffs, next episode, anchored episode menu with outside/focus/blur/Escape dismissal, narrow/fullscreen selectors and IPC identity checks.",
  );
} catch (error) {
  console.log(
    await page?.evaluate(() => ({
      calls: window.fixture?.calls,
      queue: [...document.querySelectorAll(".player-queue")].map((n) => ({
        rect: n.getBoundingClientRect().toJSON(),
        visible: getComputedStyle(n).visibility,
        groups: n.querySelector(".horizontal-scroll-items")?.outerHTML,
      })),
      video: (() => {
        const v = document.querySelector("video");
        return (
          v && {
            src: v.currentSrc,
            ready: v.readyState,
            time: v.currentTime,
            duration: v.duration,
            error: v.error?.message,
            paused: v.paused,
          }
        );
      })(),
    })),
  );
  throw error;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
