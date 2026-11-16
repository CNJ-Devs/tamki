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
import React from 'react';import{createRoot}from'react-dom/client';
import{RecognitionFlow}from'./src/ui/recognition-flow';import{TooltipProvider}from'./src/ui/components/ui/tooltip';import{LocaleContext}from'./src/ui/i18n';import{applyTheme}from'./src/ui/theme';import{defaultSettings,newSource}from'./src/shared/settings';import{newAIConnection}from'./src/shared/ai-connections';
applyTheme({language:'zh',palette:'hazel',mode:'dark',refreshOnOpen:false});
const connections=['Zoe','JZ'].map(name=>({...newAIConnection('openai-compatible'),id:name.toLowerCase(),name,auth:'none',endpoint:'https://example.test/v1',models:[{id:'small',name:'Small'},{id:'large',name:'Large'}]}));
const config={...defaultSettings('zh').recognition,defaultSourceId:'profile',sources:[{...newSource('openai-compatible'),id:'profile',name:'Old provider label',connectionId:'zoe',model:'small',hasKey:false,hasSearchKey:false,models:connections[0].models}]};
const work={id:'w',title:'作品',description:'',tags:[],episodes:[{id:'e',fileName:'original.mkv',title:'旧集名',description:'',number:'1'}]};window.fixture={calls:[],applied:0,mode:'success',revision:0};
const episodeId=location.search.includes('episode')?'e':undefined;
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});if(type==='recognize'){if(window.fixture.mode==='fail')throw new Error('recognitionUnavailable');if(window.fixture.mode==='pending')return new Promise(resolve=>{window.fixture.resolve=resolve;});window.fixture.revision++;return {kind:'result',citations:[],artworkSource:{cover:'https://example.org/poster.jpg',coverPage:'https://example.org/work'},result:{work:episodeId?null:{title:'新作品'+window.fixture.revision,description:null,tags:null,cover:null},files:[{id:'e',title:'新集名'+window.fixture.revision,description:null,number:'1'}]}};}if(type==='cancel-recognition')return;throw new Error(type);}};
createRoot(document.getElementById('root')).render(<LocaleContext value="zh"><TooltipProvider><RecognitionFlow work={work} config={config} connections={connections} episodeId={episodeId} draftInput={{id:'w',title:'作品',description:'',tags:[],removedEpisodeIds:[],episodes:[{id:'e',number:'1',title:'旧集名',description:''}]}} onApply={async()=>{window.fixture.applied++;}} onClose={()=>{}}/></TooltipProvider></LocaleContext>);

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
  for (const scope of ["work", "episode"]) {
    await page.goto("http://127.0.0.1:" + server.address().port + "?" + scope);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "补充意见", exact: true }).click();
    const note = page.getByRole("textbox", { name: "调整意见或参考资料" });
    await note.fill("参考 https://example.org/work 补全信息");
    await page.evaluate(() => (window.fixture.mode = "fail"));
    await page.getByRole("button", { name: "再次识别", exact: true }).click();
    await page.waitForFunction(
      () =>
        window.fixture.calls.filter((c) => c.type === "recognize").length === 2,
    );
    await page.getByRole("button", { name: "再次识别", exact: true }).waitFor();
    assert.equal(
      await note.inputValue(),
      "参考 https://example.org/work 补全信息",
    );
    await page.evaluate(() => (window.fixture.mode = "pending"));
    await page.getByRole("button", { name: "再次识别", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(
      await note.inputValue(),
      "参考 https://example.org/work 补全信息",
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.fixture.calls.filter((c) => c.type === "cancel-recognition")
            .length,
      ),
      1,
    );
    await page.evaluate(() => (window.fixture.mode = "success"));
    await page.getByRole("button", { name: "再次识别", exact: true }).click();
    await page.getByRole("button", { name: "补充意见", exact: true }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".recognition-feedback-modal"),
    );
    const calls = await page.evaluate(() =>
      window.fixture.calls.filter((c) => c.type === "recognize"),
    );
    const last = calls.at(-1).value;
    assert.equal(last.sourceId, calls[0].value.sourceId);
    assert.equal(last.model, calls[0].value.model);
    assert.equal(last.scope, scope === "episode" ? "file" : "work");
    assert.deepEqual(last.feedback.messages, [
      "参考 https://example.org/work 补全信息",
    ]);
    assert.equal(last.feedback.previous.files[0].title, "新集名1");
    if (scope === "episode") assert.equal(last.feedback.previous.work, null);
    else
      assert.equal(
        last.feedback.previous.work.cover,
        "https://example.org/poster.jpg",
      );
    assert.equal(await page.evaluate(() => window.fixture.applied), 0);
    await page.getByRole("button", { name: "补充意见", exact: true }).click();
    await note.fill("第二轮修正");
    await page.getByRole("button", { name: "再次识别", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector(".recognition-feedback-modal"),
    );
    assert.deepEqual(
      await page.evaluate(
        () =>
          window.fixture.calls.filter((c) => c.type === "recognize").at(-1)
            .value.feedback.messages,
      ),
      ["参考 https://example.org/work 补全信息", "第二轮修正"],
    );
    // A cancelled request finishing late cannot replace the newer preview.
    await page.evaluate(() =>
      window.fixture.resolve({
        kind: "result",
        result: { work: null, files: [] },
        citations: [],
      }),
    );
    await page.getByText("新集名3", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.applied), 0);
    await page.setViewportSize({ width: 420, height: 640 });
    await page.getByRole("button", { name: "补充意见", exact: true }).click();
    const box = await note.boundingBox();
    const footer = await page
      .locator(".recognition-feedback-modal .modal-footer")
      .boundingBox();
    assert.ok(box.y + box.height <= footer.y);
    await mkdir("test-results", { recursive: true });
    await page.locator('.recognition-feedback-modal').evaluate(async (el) => {
      await Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})));
    });
    await page.screenshot({
      path: "test-results/recognition-feedback-" + scope + ".png",
    });
    await page.setViewportSize({ width: 1100, height: 780 });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Work and episode feedback, failure, cancellation, history and explicit apply UI passed",
  );
} finally {
  await browser?.close();
  server.close();
}
