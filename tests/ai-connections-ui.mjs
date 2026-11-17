// Headless settings checks with synthetic IPC. Never opens the user's desktop app.
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
import { Settings } from './src/ui/settings';
import { TooltipProvider } from './src/ui/components/ui/tooltip';
import { LocaleContext } from './src/ui/i18n';
import { defaultSettings, usesAccount, newSource } from './src/shared/settings';
import { applyTheme } from './src/ui/theme';
const language = new URLSearchParams(location.search).get('lang') === 'zh' ? 'zh' : 'en';
const preferences = { language, palette: 'hazel', mode: new URLSearchParams(location.search).get('mode') === 'dark' ? 'dark' : 'light', refreshOnOpen: false };
applyTheme(preferences);
let config = defaultSettings(language), emit = () => {};
if (new URLSearchParams(location.search).has('source-options')) {
  config.aiConnections = ['Account A', 'Account B'].map((name, i) => ({ id: 'account-' + i, name, provider: 'openai', hasKey: true, models: [] }));
  config.recognition.sources = [{ ...newSource('openai'), id: 'configured-source', name: 'Configured GPT', connectionId: 'account-0', model: 'fixture', hasKey: true, models: [], hasSearchKey: false }];
  config.recognition.defaultSourceId = 'configured-source';
}
const accounts = new Map(), keys = new Map();
window.fixture = { calls: [], config, pending: false, authorization: null, copied: null, opened: null, rejectLogin: null, lifetime: 300000, expiryTimer: null, profiles: [], profileId: null };
window.tamki = { library: async (type, value) => {
  window.fixture.calls.push({ type, value });
  const connection = value?.connection;
  switch (type) {
    case 'recognition-preferences': config = { ...config, recognition: { ...config.recognition, ...value } }; window.fixture.config = config; emit(config); return;
    case 'tmdb-credentials': config = { ...config, recognition: { ...config.recognition, tmdbConfigured: !!value } }; window.fixture.config = config; emit(config); return;
    case 'retry-recognition': return;

    case 'source-oauth-profiles': return { selectedId: window.fixture.profileId || window.fixture.profiles[0]?.id || value.source.id, profiles: window.fixture.profiles, account: accounts.get(value.source.id) || { email: '', status: 'signedOut' } };
    case 'source-oauth-select': {
      window.fixture.profileId = value.profileId || 'new';
      accounts.delete(value.source.id);
      return { selectedId: window.fixture.profileId, profiles: window.fixture.profiles, account: { email: '', status: 'signedOut' } };
    }

    case 'ai-connection-login': {
      if (window.fixture.pending) {
        window.fixture.authorization = { id: crypto.randomUUID(), status: 'waiting', expiresAt: Date.now() + window.fixture.lifetime, url: 'https://auth.openai.com/api/accounts/authorize?state=' + crypto.randomUUID() + '&code_challenge=fixture' };
        return new Promise((_, reject) => {
          window.fixture.rejectLogin = reject;
          window.fixture.expiryTimer = setTimeout(() => {
            window.fixture.authorization = null; window.fixture.rejectLogin = null;
            reject(new Error('authExpired'));
          }, window.fixture.lifetime);
        });
      }
      const account = { email: 'person@example.test', status: 'connected', billing: connection.provider === 'gemini-oauth' ? 'api' : 'subscription' };
      accounts.set(connection.id, account); return { account, firstUse: false };
    }
    case 'ai-connection-projects': return [{ id: 'fixture-project', name: 'Fixture project' }];
    case 'ai-connection-test': return { modelCount: 2 };
    case 'ai-connection-save': {
      if (!usesAccount(connection.provider) && connection.auth !== 'none' && !value.apiKey && !keys.has(connection.id)) throw new Error('keyRequired');
      if (value.apiKey) keys.set(connection.id, value.apiKey);
      const item = { ...connection, hasKey: keys.has(connection.id), models: [], account: accounts.get(connection.id) };
      config = { ...config, aiConnections: [...config.aiConnections.filter(c => c.id !== item.id), item] };
      window.fixture.config = config; emit(config); return;
    }
    case 'ai-connection-logout': accounts.delete(value); return { revoked: true, account: { email: '', status: 'signedOut' } };
    case 'ai-connection-discard':
      clearTimeout(window.fixture.expiryTimer); window.fixture.rejectLogin?.(new Error('oauthCancelled')); window.fixture.rejectLogin = null; window.fixture.authorization = null;
      return { revoked: true };
    case 'source-authorization': return window.fixture.authorization;
    case 'source-authorization-copy': window.fixture.copied = window.fixture.authorization.url; return;
    case 'source-authorization-open': window.fixture.opened = window.fixture.authorization.url; return;
    case 'source-authorization-cancel':
      clearTimeout(window.fixture.expiryTimer); window.fixture.rejectLogin?.(new Error('oauthCancelled')); window.fixture.rejectLogin = null; window.fixture.authorization = null; return;
    case 'ai-connection-remove': config = { ...config, aiConnections: config.aiConnections.filter(c => c.id !== value) }; emit(config); return { revoked: true };
    case 'source-oauth-discard': return { revoked: true };
  }
} };
function Harness() {
  const [settings, setSettings] = useState(config); emit = setSettings;
  return <LocaleContext value={language}><TooltipProvider><div style={{height:'100dvh'}}><Settings state={{preferences, connections:[], settings}} onBack={() => {}} /></div></TooltipProvider></LocaleContext>;
}
createRoot(document.getElementById('root')).render(<Harness />);
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  const region = page.getByRole("region", {
    name: "AI connections",
    exact: true,
  });
  await region.scrollIntoViewIfNeeded();
  await region.getByText("No AI connections", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("No custom sources", { exact: true }).count(),
    0,
  );
  await region
    .getByRole("button", { name: "Add AI connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const selectType = async (name) => {
    await dialog
      .getByRole("combobox", { name: "Service type", exact: true })
      .click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const noInferenceControls = async () => {
    for (const label of [
      "Model",
      "Output token limit",
      "Request timeout (seconds)",
      "Web search",
      "AI recognition prompt",
    ])
      assert.equal(
        await dialog.getByLabel(label, { exact: true }).count(),
        0,
        label,
      );
  };
  for (const name of [
    "DeepSeek · API Key",
    "Anthropic · API Key",
    "Google Gemini · API Key",
    "OpenAI · API Key",
  ]) {
    await selectType(name);
    await dialog.getByLabel("API Key", { exact: true }).waitFor();
    await noInferenceControls();
  }
  await dialog.getByLabel("Name", { exact: true }).fill("Personal OpenAI");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog
    .getByText("Enter an API Key for this endpoint.", { exact: true })
    .waitFor();
  await dialog.getByLabel("API Key", { exact: true }).fill("fixture-api-key");
  await dialog
    .getByRole("button", { name: "Advanced settings", exact: true })
    .click();
  await dialog.getByLabel("Project ID", { exact: true }).fill("project_one");
  await noInferenceControls();
  await dialog
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await dialog.getByText("Connection successful", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => window.fixture.config.recognition.sources.length),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      window.fixture.calls.some((c) => c.type === "source-models"),
    ),
    false,
  );
  await region
    .getByRole("button", { name: "Edit AI connection", exact: true })
    .click();
  assert(
    await dialog
      .getByRole("combobox", { name: "Service type", exact: true })
      .isDisabled(),
  );
  assert.equal(
    await dialog.getByLabel("API Key", { exact: true }).inputValue(),
    "",
  );
  await dialog.getByLabel("Name", { exact: true }).fill("Personal account");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await region
    .getByRole("button", { name: "Add AI connection", exact: true })
    .click();
  await selectType("OpenAI Compatible");
  await dialog
    .getByLabel("Service URL", { exact: true })
    .fill("http://127.0.0.1:11434/v1");
  await dialog
    .getByRole("combobox", { name: "Authentication", exact: true })
    .click();
  await page
    .getByRole("option", { name: "No authentication", exact: true })
    .click();
  assert.equal(await dialog.getByLabel("API Key", { exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  for (const [name, login] of [
    ["Claude · Official app login", "Sign in with Claude Code"],
    ["OpenAI · ChatGPT login", "Start authorization"],
  ]) {
    await region
      .getByRole("button", { name: "Add AI connection", exact: true })
      .click();
    if (name !== "OpenAI · ChatGPT login") await selectType(name);
    await noInferenceControls();
    await dialog.getByRole("button", { name: login, exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  // Source management is reached through Information recognition.
  await page
    .getByRole("button", { name: "Source settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "AI connection", exact: true })
    .waitFor();
  assert.equal(await dialog.getByLabel("API Key", { exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.goto(base + "?lang=zh");
  const chineseRegion = page.getByRole("region", {
    name: "AI 连接",
    exact: true,
  });
  await chineseRegion
    .getByRole("button", { name: "添加 AI 连接", exact: true })
    .click();
  await dialog.getByRole("combobox", { name: "接入类型", exact: true }).click();
  await page
    .getByRole("option", { name: "Gemini · Google Cloud 登录", exact: true })
    .click();
  await dialog.getByLabel("名称", { exact: true }).fill("我的 Google 账号");
  await dialog
    .getByLabel("桌面 OAuth 客户端 ID", { exact: true })
    .fill("fixture.apps.googleusercontent.com");
  await dialog
    .getByLabel("OAuth 客户端密钥（可选）", { exact: true })
    .fill("fixture-secret");
  const before = await dialog.boundingBox();
  await dialog.getByRole("button", { name: "开始授权", exact: true }).click();
  await dialog.getByRole("combobox", { name: "计费项目", exact: true }).click();
  await page
    .getByRole("option", { name: "Fixture project", exact: true })
    .click();
  assert.equal((await dialog.boundingBox()).height, before.height);
  await mkdir("test-results", { recursive: true });
  await dialog.locator(".modal-body").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: "test-results/ai-connection-google.png" });
  await page.setViewportSize({ width: 620, height: 720 });
  await page.screenshot({
    path: "test-results/ai-connection-google-narrow.png",
  });
  assert.equal(
    await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await page.evaluate(
    () =>
      window.fixture.calls.find((c) => c.type === "ai-connection-save").value,
  );
  assert.equal(saved.oauthClientSecret, undefined);
  assert.equal(saved.connection.project, "fixture-project");
  for (const key of [
    "model",
    "searchMode",
    "maxOutputTokens",
    "timeoutSeconds",
    "aiPrompt",
  ])
    assert(!(key in saved.connection));
  await page.setViewportSize({ width: 1180, height: 820 });
  await chineseRegion.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/settings-ai-connections.png" });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Add AI connection", exact: true })
    .click();
  await page.evaluate(() => {
    window.fixture.pending = true;
  });
  const authorizationURL = dialog.getByLabel("Authorization link", {
    exact: true,
  });
  const copyLink = dialog.getByRole("button", {
    name: "Copy link",
    exact: true,
  });
  assert.equal(await authorizationURL.inputValue(), "");
  assert(await authorizationURL.isDisabled());
  assert(await copyLink.isDisabled());
  assert.equal(
    await dialog
      .getByRole("button", { name: "Open in browser", exact: true })
      .count(),
    0,
  );
  // Measure settled layout, excluding the dialog's opening scale animation.
  await dialog.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      if (animation.effect?.getComputedTiming().iterations !== Infinity)
        animation.finish();
    }
  });
  const initialBounds = await dialog.boundingBox();
  const initialInputBounds = await authorizationURL.boundingBox();
  await dialog
    .getByRole("button", { name: "Start authorization", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("input[readonly]")
      ?.value.startsWith("https://auth.openai.com/"),
  );
  const firstURL = await authorizationURL.inputValue();
  const waitingBounds = await dialog.boundingBox();
  assert.deepEqual(await authorizationURL.boundingBox(), initialInputBounds);
  assert.equal(waitingBounds.height, initialBounds.height);
  assert.equal(await page.evaluate(() => window.fixture.opened), null);
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.copied), firstURL);
  await dialog
    .getByRole("button", { name: "Open in browser", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.fixture.opened), firstURL);
  await dialog
    .getByRole("button", { name: "Cancel authorization", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Start authorization", exact: true })
    .waitFor();
  assert.equal(await authorizationURL.inputValue(), firstURL);
  assert(await authorizationURL.isDisabled());
  assert(await copyLink.isDisabled());
  await dialog.getByText("Cancelled · link expired", { exact: true }).waitFor();
  assert.deepEqual(await authorizationURL.boundingBox(), initialInputBounds);
  assert.equal((await dialog.boundingBox()).height, waitingBounds.height);
  assert.equal(
    await dialog
      .getByText("Authorization or connection test cancelled.", { exact: true })
      .count(),
    0,
  );
  await dialog
    .getByRole("button", { name: "Start authorization", exact: true })
    .click();
  await page.waitForFunction((previous) => {
    const input = document.querySelector("input[readonly]");
    return input && !input.disabled && input.value !== previous;
  }, firstURL);
  assert.notEqual(await authorizationURL.inputValue(), firstURL);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => window.fixture.calls.at(-1)?.type === "ai-connection-discard",
  );
  assert.equal(
    await page.evaluate(() => window.fixture.config.aiConnections.length),
    0,
  );
  await page.goto(base + "?lang=zh");
  await page.getByRole("button", { name: "添加 AI 连接", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("我的 ChatGPT");
  await page.screenshot({
    path: "test-results/authorization-idle.png",
    animations: "disabled",
  });
  await page.evaluate(() => {
    window.fixture.pending = true;
  });
  await dialog.getByRole("button", { name: "开始授权", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("input[readonly]")
      ?.value.startsWith("https://auth.openai.com/"),
  );
  await page.screenshot({
    path: "test-results/authorization-link.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 620, height: 720 });
  await page.screenshot({
    path: "test-results/authorization-link-narrow.png",
    animations: "disabled",
  });
  assert.equal(
    await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await dialog.getByRole("button", { name: "取消授权", exact: true }).click();
  await dialog.getByRole("button", { name: "开始授权", exact: true }).waitFor();
  await dialog.getByText("已取消，链接已失效", { exact: true }).waitFor();
  await page.screenshot({
    path: "test-results/authorization-cancelled.png",
    animations: "disabled",
  });
  await page.evaluate(() => {
    window.fixture.lifetime = 1500;
  });
  await dialog.getByRole("button", { name: "开始授权", exact: true }).click();
  const chineseURL = dialog.getByLabel("授权地址", { exact: true });
  await page.waitForFunction(
    () => !document.querySelector("input[readonly]")?.disabled,
  );
  const expiringURL = await chineseURL.inputValue();
  await dialog.getByText("授权地址已失效", { exact: true }).waitFor();
  assert.equal(await chineseURL.inputValue(), expiringURL);
  assert(await chineseURL.isDisabled());
  assert(
    await dialog
      .getByRole("button", { name: "复制链接", exact: true })
      .isDisabled(),
  );
  assert(
    await dialog
      .getByRole("button", { name: "开始授权", exact: true })
      .isEnabled(),
  );
  assert.equal(await page.evaluate(() => window.fixture.opened), null);
  await page.screenshot({
    path: "test-results/authorization-expired.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => {
    window.fixture.profiles = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Tamki",
        email: "saved@example.test",
        verified: true,
      },
    ];
  });
  await chineseRegion
    .getByRole("button", { name: "添加 AI 连接", exact: true })
    .click();
  const identities = dialog.getByRole("combobox", {
    name: "已保存的授权",
    exact: true,
  });
  await identities.waitFor();
  assert.match(await identities.innerText(), /saved@example.test/);
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const identityHeight = (await dialog.boundingBox()).height;
  const logins = await page.evaluate(
    () =>
      window.fixture.calls.filter((c) => c.type === "ai-connection-login")
        .length,
  );
  await identities.click();
  await page
    .getByRole("option", { name: "添加其他账号或工作区", exact: true })
    .click();
  await page.waitForFunction(() => window.fixture.profileId === "new");
  assert.equal((await dialog.boundingBox()).height, identityHeight);
  await identities.click();
  await page
    .getByRole("option", { name: "Tamki · saved@example.test", exact: true })
    .click();
  await page.waitForFunction(
    () => window.fixture.profileId === "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.calls.filter((c) => c.type === "ai-connection-login")
          .length,
    ),
    logins,
  );
  assert.equal(await page.evaluate(() => window.fixture.opened), null);
  await page.screenshot({
    path: "test-results/authorization-identity.png",
    animations: "disabled",
  });
  assert.equal(
    await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await page.goto(base + "?lang=zh&mode=dark");
  await page.setViewportSize({ width: 1180, height: 820 });
  const recognition = page.getByRole("region", {
    name: "信息识别",
    exact: true,
  });
  await recognition.scrollIntoViewIfNeeded();
  const parser = recognition.getByRole("combobox", {
    name: "文件名解析",
    exact: true,
  });
  const defaultSource = recognition.getByRole("combobox", {
    name: "默认识别来源",
    exact: true,
  });
  const automatic = recognition.getByRole("checkbox", {
    name: "自动识别新入库内容",
    exact: true,
  });
  const center = async (locator) => {
    const b = await locator.boundingBox();
    return b.y + b.height / 2;
  };
  assert.equal(
    await recognition.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  assert(Math.abs((await center(parser)) - (await center(defaultSource))) < 2);
  assert(Math.abs((await center(parser)) - (await center(automatic))) < 2);
  for (const name of ["重试未完成识别", "AI 识别提示词", "来源配置"])
    assert(
      Math.abs(
        (await center(
          recognition.getByRole("heading", { name: "信息识别", exact: true }),
        )) -
          (await center(
            recognition.getByRole("button", { name, exact: true }),
          )),
      ) < 2,
    );
  assert.equal(
    await recognition
      .getByRole("button", { name: "TMDB 授权", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await recognition.getByText("自定义来源", { exact: true }).count(),
    0,
  );
  await recognition.screenshot({
    path: "test-results/recognition-settings-wide.png",
    animations: "disabled",
  });
  await defaultSource.click();
  assert.equal(
    await page
      .getByRole("option", { name: "TMDB · 未配置", exact: true })
      .getAttribute("aria-disabled"),
    "true",
  );
  await page.keyboard.press("Escape");
  const scrollBefore = await recognition.evaluate(
    (el) => el.closest(".page-body").scrollTop,
  );
  await recognition
    .getByRole("button", { name: "来源配置", exact: true })
    .click();
  const sources = page.getByRole("region", { name: "来源配置", exact: true });
  await sources.getByRole("group", { name: "Bangumi", exact: true }).waitFor();
  await sources.getByRole("group", { name: "文件名", exact: true }).waitFor();
  await sources.screenshot({
    path: "test-results/recognition-sources.png",
    animations: "disabled",
  });
  await sources
    .getByRole("group", { name: "TMDB", exact: true })
    .getByRole("button", { name: "TMDB 授权", exact: true })
    .click();
  await dialog
    .getByLabel("API 读取访问令牌", { exact: true })
    .fill("synthetic-tmdb-token");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await sources
    .getByRole("group", { name: "TMDB", exact: true })
    .getByText("已配置", { exact: true })
    .waitFor();
  await sources.getByRole("button", { name: "返回", exact: true }).click();
  await recognition.waitFor();
  assert.equal(
    await recognition.evaluate((el) => el.closest(".page-body").scrollTop),
    scrollBefore,
  );
  await defaultSource.click();
  assert.notEqual(
    await page
      .getByRole("option", { name: "TMDB", exact: true })
      .getAttribute("aria-disabled"),
    "true",
  );
  await page.getByRole("option", { name: "TMDB", exact: true }).click();
  await page.waitForFunction(
    () => window.fixture.config.recognition.defaultSourceId === "tmdb",
  );
  await automatic.click();
  await page.waitForFunction(
    () => window.fixture.config.recognition.automatic === false,
  );
  assert(
    await recognition
      .getByRole("button", { name: "重试未完成识别", exact: true })
      .isDisabled(),
  );
  await automatic.click();
  await recognition
    .getByRole("button", { name: "重试未完成识别", exact: true })
    .click();
  assert(
    await page.evaluate(() =>
      window.fixture.calls.some((c) => c.type === "retry-recognition"),
    ),
  );
  for (const width of [620, 420]) {
    await page.setViewportSize({ width, height: 820 });
    await recognition.scrollIntoViewIfNeeded();
    assert.equal(
      await recognition.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    if (width === 420)
      assert(
        (await defaultSource.boundingBox()).y > (await parser.boundingBox()).y,
      );
    await recognition.screenshot({
      path: `test-results/recognition-settings-${width}.png`,
      animations: "disabled",
    });
  }
  await page.goto(base + "?lang=zh&source-options");
  const configuredDefault = page.getByRole("combobox", {
    name: "默认识别来源",
    exact: true,
  });
  assert.equal(await configuredDefault.textContent(), "Configured GPT");
  await configuredDefault.click();
  assert.deepEqual(await page.getByRole("option").allTextContents(), [
    "Bangumi",
    "Bilibili",
    "TMDB · 未配置",
    "文件名",
    "Configured GPT",
  ]);
  await page
    .getByRole("option", { name: "Configured GPT", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () => window.fixture.config.recognition.defaultSourceId,
    ),
    "configured-source",
  );
  assert.deepEqual(errors, []);
  console.log(
    "AI connection UI passed: all provider fields, independent saving, named accounts, secret clearing, fixed-height responsive dialogs, responsive recognition settings and unified source configuration.",
  );
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections();
}
