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
const work={id:'w',title:'作品',description:'',tags:[],episodes:[]};window.fixture={calls:[]};
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});if(type==='recognize')throw new Error('oauthUsageLimit');if(type==='cancel-recognition')return;if(type==='ai-feature-models')return connections[1].models;throw new Error(type);}};
createRoot(document.getElementById('root')).render(<LocaleContext value="zh"><TooltipProvider><RecognitionFlow work={work} config={config} connections={connections} draftInput={{id:'w',title:'作品',description:'',tags:[],removedEpisodeIds:[],episodes:[]}} onApply={async()=>{}} onClose={()=>{}}/></TooltipProvider></LocaleContext>);
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
  await page.getByRole("combobox", { name: "识别来源", exact: true }).click();
  assert.equal(
    await page.getByRole("option", { name: "Zoe", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("option", { name: "JZ", exact: true }).count(),
    1,
  );
  await page.screenshot({
    path: "test-results/recognition-shared-menu.png",
    animations: "disabled",
  });
  await page.getByRole("option", { name: "JZ", exact: true }).click();
  assert.ok(
    await page.getByRole("button", { name: "搜索", exact: true }).isDisabled(),
  );
  await page.getByRole("combobox", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: "Large", exact: true }).click();
  await page.screenshot({
    path: "test-results/recognition-shared-connections.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.waitForFunction(() =>
    window.fixture.calls.some((c) => c.type === "recognize"),
  );
  const call = await page.evaluate(() =>
    window.fixture.calls.find((c) => c.type === "recognize"),
  );
  assert.equal(call.value.sourceId, "connection:jz");
  assert.equal(call.value.model, "large");
  await page.getByRole("combobox", { name: "识别来源", exact: true }).click();
  await page.getByRole("option", { name: "Zoe", exact: true }).click();
  assert.ok(
    (
      await page
        .getByRole("combobox", { name: "模型", exact: true })
        .innerText()
    ).includes("Small"),
  );
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.fixture.calls.filter((c) => c.type === "recognize").length === 2,
  );
  const second = await page.evaluate(
    () => window.fixture.calls.filter((c) => c.type === "recognize")[1],
  );
  assert.equal(second.value.sourceId, "profile");
  assert.equal(second.value.model, "small");
  await page.setViewportSize({ width: 420, height: 640 });
  await page.getByRole("textbox").fill("窄屏核对");
  const inputBounds = await page.getByRole("textbox").boundingBox();
  const footerBounds = await page.locator(".modal-footer").boundingBox();
  assert.ok(
    inputBounds.y + inputBounds.height <= footerBounds.y,
    "input must not overlap footer",
  );
  await page.screenshot({
    path: "test-results/recognition-shared-420.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log("Shared recognition connections UI passed");
} finally {
  await browser?.close();
  server.close();
}
