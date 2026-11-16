// Headless source editor with synthetic saved connections. No live accounts or desktop control.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SourceEditor } from './src/ui/source-editor';
import { TooltipProvider } from './src/ui/components/ui/tooltip';
import { LocaleContext } from './src/ui/i18n';
import { newSource, providers, searchSettingsKey } from './src/shared/settings';
import { newAIConnection } from './src/shared/ai-connections';
import { recognitionSourceInput, resolveRecognitionSource } from './src/shared/recognition-source';
import { applyTheme } from './src/ui/theme';
const params = new URLSearchParams(location.search);
const language=params.get('lang') === 'zh' ? 'zh' : 'en';
applyTheme({ language, palette:'hazel',mode:params.get('mode') || 'light', refreshOnOpen:false });
const connections = params.has('empty') ? [] : providers.map(p => ({...newAIConnection(p.id),id:p.id,name:p.name + ' account',endpoint:p.id === 'openai-compatible' ? 'https://example.test/v1' : p.endpoint,hasKey:true,account:{email:'example@example.test',status:'connected'},project:p.id === 'gemini-oauth' ? 'test-project' : '',oauthClientId:p.id === 'gemini-oauth' ? 'test.apps.googleusercontent.com' : ''}));
connections.push(...(params.has('empty') ? [] : [{...connections.find(c=>c.id==='openai'),id:'openai-work',name:'Work account'}]));
window.fixture={calls:[],saved:null};
window.tamki={library:async(type,value)=>{
  window.fixture.calls.push({type,value});
  const input=recognitionSourceInput.parse(value), connection=connections.find(c=>c.id===input.source.connectionId);
  if(!connection) throw new Error('aiConnectionMissing');
  const source=resolveRecognitionSource(input.source,connection);
  if(type==='recognition-source-models') return [{id:connection.id+'-model',name:'Fixture model',outputLimit:8192}];
  if(type==='recognition-source-search') return {...connection.account,search:{model:source.model,settingsKey:searchSettingsKey(source),checkedAt:Date.now()}};
  if(type==='save-recognition-source') {window.fixture.saved=input;return;}
  throw new Error('Unexpected IPC: '+type);
}};
function Harness(){
 const [open,setOpen]=useState(true),[manage,setManage]=useState(false);
 const [initial]=useState(()=>({...newSource('openai'),name:params.has('edit')?'Existing source':'',hasKey:false,hasSearchKey:false,models:params.has('edit')?[{id:'openai-model',name:'Fixture model'}]:[],...(params.has('edit')?{connectionId:'openai',model:'openai-model'}:{})}));
 return <LocaleContext value={language}><TooltipProvider>{manage?<div>Manage connections</div>:open?<SourceEditor initial={initial} isNew={!params.has('edit')} connections={connections} onConnections={()=>setManage(true)} onClose={()=>setOpen(false)}/>:<div>Closed</div>}</TooltipProvider></LocaleContext>;
}
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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mkdir("test-results", { recursive: true });
  const dialog = page.getByRole("dialog");
  async function checkAdvancedLayout() {
    const panel = dialog.locator('[data-slot="accordion-content"]');
    await panel.evaluate(async (el) => {
      await Promise.all(
        el.getAnimations().map((animation) => animation.finished),
      );
    });
    assert(
      await panel.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      "Expanded fields must fit the accordion after content or width changes",
    );
    for (const control of await panel
      .locator('[data-slot="input"], [data-slot="select-trigger"]')
      .all()) {
      await control.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await control.focus();
      assert(
        await control.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          const clip = el
            .closest('[data-slot="accordion-content"]')
            .getBoundingClientRect();
          const style = getComputedStyle(el);
          const outset =
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          return (
            bounds.left - outset >= clip.left - 0.5 &&
            bounds.right + outset <= clip.right + 0.5 &&
            bounds.top - outset >= clip.top - 0.5 &&
            bounds.bottom + outset <= clip.bottom + 0.5
          );
        }),
        "The full input focus outline must fit inside the clipping container",
      );
    }
    assert(
      await dialog
        .locator(".modal-body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "Form focus spacing must not introduce horizontal scrolling",
    );
  }
  for (const account of [
    "DeepSeek account",
    "Anthropic account",
    "Google Gemini account",
    "OpenAI account",
    "OpenAI · ChatGPT account",
    "OpenAI Compatible account",
    "Claude Code account",
    "Gemini · Google Cloud account",
  ]) {
    await page.goto(base);
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("Recognition preference");
    await dialog.evaluate(async (el) => {
      await Promise.all(
        el.getAnimations().map((animation) => animation.finished),
      );
    });
    const before = await dialog.boundingBox();
    await dialog
      .getByRole("combobox", { name: "AI connection", exact: true })
      .click();
    await page.getByRole("option", { name: account, exact: true }).click();
    assert.equal(
      await dialog.getByLabel("Name", { exact: true }).inputValue(),
      "Recognition preference",
    );
    for (const label of [
      "Source type",
      "API Key",
      "Service URL",
      "Protocol",
      "Authentication",
      "Project ID",
      "Organization ID",
      "Desktop OAuth client ID",
      "Claude executable path",
    ])
      assert.equal(
        await dialog.getByLabel(label, { exact: true }).count(),
        0,
        label,
      );
    assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
    await dialog
      .getByRole("button", { name: "Load models", exact: true })
      .click();
    await dialog.getByRole("combobox", { name: "Model", exact: true }).click();
    await page
      .getByRole("option", { name: "Fixture model", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Advanced settings", exact: true })
      .click();
    assert.equal(
      Math.round((await dialog.boundingBox()).height),
      Math.round(before.height),
    );
    assert.equal(
      await dialog
        .getByLabel("Request timeout (seconds)", { exact: true })
        .inputValue(),
      "300",
    );
    await checkAdvancedLayout();
    if (
      await dialog
        .getByRole("button", { name: "Test web search", exact: true })
        .count()
    )
      await dialog
        .getByRole("button", { name: "Test web search", exact: true })
        .click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Closed", { exact: true }).waitFor();
    const payload = await page.evaluate(() => window.fixture.saved);
    assert.equal(payload.source.name, "Recognition preference");
    assert(payload.source.connectionId);
    assert(payload.source.model);
    assert(!("provider" in payload.source));
    assert(!("apiKey" in payload));
  }
  await page.goto(base + "?edit");
  await dialog
    .getByRole("combobox", { name: "AI connection", exact: true })
    .click();
  await page.getByRole("option", { name: "Work account", exact: true }).click();
  assert.equal(
    await dialog
      .getByRole("combobox", { name: "Model", exact: true })
      .innerText(),
    "",
  );
  assert(
    await dialog
      .getByRole("button", { name: "Save", exact: true })
      .isDisabled(),
  );
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Existing source",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
  await page.goto(base + "?empty");
  assert(
    await dialog
      .getByRole("combobox", { name: "AI connection", exact: true })
      .isDisabled(),
  );
  assert(
    await dialog
      .getByRole("button", { name: "Save", exact: true })
      .isDisabled(),
  );
  await dialog
    .getByRole("button", { name: "Manage AI connections", exact: true })
    .click();
  await page.getByText("Manage connections", { exact: true }).waitFor();
  await page.goto(base + "?lang=zh&mode=dark");
  await dialog.getByLabel("名称", { exact: true }).fill("动画信息识别");
  await dialog.getByRole("combobox", { name: "AI 连接", exact: true }).click();
  await page
    .getByRole("option", { name: "OpenAI · ChatGPT account", exact: true })
    .click();
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await dialog.getByRole("combobox", { name: "模型", exact: true }).click();
  await page
    .getByRole("option", { name: "Fixture model", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/recognition-source-linked.png",
    animations: "disabled",
  });
  for (const width of [620, 420]) {
    await page.setViewportSize({ width, height: 720 });
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await page.screenshot({
      path: `test-results/recognition-source-linked-${width}.png`,
      animations: "disabled",
    });
  }
  // The panel must reflow when optional fields are added and columns collapse.
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(base + "?edit&lang=zh");
  await dialog.getByRole("button", { name: "高级设置", exact: true }).click();
  await dialog.getByRole("combobox", { name: "搜索范围", exact: true }).click();
  await page.getByRole("option", { name: "仅限指定域名", exact: true }).click();
  for (const width of [1180, 420]) {
    await page.setViewportSize({ width, height: 720 });
    await checkAdvancedLayout();
    await page.screenshot({
      path: `test-results/recognition-source-corners-${width}.png`,
      animations: "disabled",
    });
  }
  await page.goto(base + "?edit&lang=zh&mode=dark");
  await dialog.getByRole("button", { name: "高级设置", exact: true }).click();
  await checkAdvancedLayout();
  await page.screenshot({
    path: "test-results/recognition-source-corners-dark.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Linked source UI passed: all connection types, no duplicate authentication, independent names/models, switching, empty-state management, stable responsive dialog.",
  );
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections();
}
