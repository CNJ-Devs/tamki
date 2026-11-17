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
window.fixture={calls:[],pending:false,reject:null,stale:false,template:plan,draft:null,plan:null,changes:null};
window.tamki={library:async(type,value)=>{window.fixture.calls.push({type,value});
 if(type==='ai-feature-models')return [{id:'model',name:'Fixture model'}];
 if(type==='organize-draft')return window.fixture.draft;
 if(type==='organize-review'){if(window.fixture.draft)window.fixture.draft.reviewSelection=value;return;}
 if(type==='organize'||type==='organize-refine'){if(window.fixture.pending)return new Promise((resolve,reject)=>{window.fixture.reject=reject;});return window.fixture.draft={...(window.fixture.plan||plan),jobId:value.jobId,liveChanges:window.fixture.changes||undefined};}
 if(type==='organize-progress')return {phase:'ready',completed:1,total:1,changes:window.fixture.changes||undefined};
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
  await page.getByRole("tab", { name: "合集", exact: true }).click();
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
  // An unavailable relationship explains its selection dependency alongside
  // the title; it is not another content question or a second vertical row.
  await page.getByRole("tab", { name: "合集 · 1", exact: true }).click();
  const relationship = page.locator(".organization-collection").first();
  assert(await relationship.getByRole("checkbox").isDisabled());
  await relationship.getByText("成员未勾选", { exact: true }).waitFor();
  const titleBox = await relationship
    .locator("[data-slot=field-label]")
    .boundingBox();
  const explanationBox = await relationship
    .getByRole("button", {
      name: "请先在作品页审阅并勾选以下成员：示例作品 · 第二季",
      exact: true,
    })
    .boundingBox();
  assert(
    Math.abs(
      titleBox.y +
        titleBox.height / 2 -
        explanationBox.y -
        explanationBox.height / 2,
    ) < 2,
  );
  await page.getByRole("tab", { name: "作品 · 2", exact: true }).click();
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
      "将按已勾选的方案整理片库，并保留播放进度。未勾选的作品保持原状。",
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
  // Incremental preview: retain additions, defer connected proposals, apply only
  // independent work and explicitly acknowledged missing-file records.
  await page.goto(base);
  await setup();
  await page.evaluate(() => {
    const f = window.fixture;
    const missing = {
      ...f.template.files[0],
      id: "gone",
      name: "Missing.mkv",
      relativePath: "Missing.mkv",
    };
    f.plan = {
      ...f.template,
      groups: f.template.groups.map((g) => ({ ...g, review: g.id === "g2" })),
      unassigned: [],
      relationshipRemovals: [
        {
          id: "remove-existing",
          kind: "collection",
          name: "旧测试合集",
          workIds: ["w1"],
        },
      ],
      delta: {
        mode: "incremental",
        totalFiles: 5,
        unchangedFiles: 1,
        pendingFiles: 4,
        added: f.template.files,
        modified: [],
        removed: [missing],
      },
    };
    f.changes = {
      blocked: true,
      added: [{ id: "new", connectionId: "storage", path: "/videos/New.mkv" }],
      removed: [],
      modified: [],
      changedWorkIds: ["w1"],
      conflictingGroupIds: ["g2"],
      deferredRemovalIds: [],
    };
  });
  await page.getByRole("button", { name: "生成方案", exact: true }).click();
  await page.getByRole("tab", { name: "暂缓处理 · 1", exact: true }).waitFor();
  assert(
    await page
      .getByRole("checkbox", { name: "示例作品 · 第二季", exact: true })
      .isDisabled(),
  );
  await page
    .getByText(
      "快照之后又新增了 1 个文件，留待下次增量处理；当前方案仍可应用。",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "确认与补充意见", exact: true })
    .click();
  const deferredFeedback = page.getByRole("dialog", { name: "确认与补充意见" });
  assert.equal(await deferredFeedback.getByText(/^已标记待确认/).count(), 0);
  assert.equal(
    await deferredFeedback
      .getByText("目录名与文件名不一致，请确认。", { exact: true })
      .count(),
    0,
  );
  await deferredFeedback
    .getByText(
      "这些关联作品不包含在本轮应用中，留待后续增量处理。仍可查看并修订当前快照的方案，受影响部分继续暂缓。",
      { exact: true },
    )
    .waitFor();
  await deferredFeedback
    .getByRole("textbox")
    .fill("仅调整独立作品，关联变化留待后续处理。");
  assert(
    !(await deferredFeedback
      .getByRole("button", { name: "修订方案", exact: true })
      .isDisabled()),
  );
  await deferredFeedback
    .getByRole("button", { name: "修订方案", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.fixture.calls.some((c) => c.type === "organize-refine"),
  );
  await deferredFeedback.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "暂缓处理 · 1", exact: true }).click();
  await page
    .getByText(
      "暂缓建议仍保留在此处，不删除、不算已确认，也不包含在本轮应用中。相关文件、上次方案和变化依据会进入下一轮增量审阅。",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: "test-results/organization-deferred.png",
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "合集 · 1", exact: true }).click();
  await page.getByText("成员暂缓", { exact: true }).waitFor();
  assert(
    await page
      .getByRole("checkbox", { name: "示例作品系列", exact: true })
      .isDisabled(),
  );
  assert.equal(await page.getByText("成员未勾选", { exact: true }).count(), 0);
  await page
    .getByRole("button", {
      name: "以下作品留待下次增量处理，此关系也随之暂缓：示例作品 · 第二季",
      exact: true,
    })
    .waitFor();
  await page.getByRole("tab", { name: "变更", exact: true }).click();
  assert(
    await page
      .getByRole("checkbox", { name: "移除关系 · 旧测试合集", exact: true })
      .isChecked(),
  );

  await page
    .getByRole("checkbox", {
      name: "确认移除片库记录 · Missing.mkv",
      exact: true,
    })
    .click();
  await page.screenshot({
    path: "test-results/organization-incremental.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "应用整理", exact: true }).click();
  const partialConfirmation = page.getByRole("dialog", {
    name: "应用整理",
    exact: true,
  });
  await partialConfirmation
    .getByRole("listitem")
    .filter({ hasText: "合集 · 旧测试合集" })
    .waitFor();
  await partialConfirmation
    .getByText("只移除这些分组，其中的作品和源文件都会保留。", { exact: true })
    .waitFor();
  await partialConfirmation
    .getByText(
      "本轮跳过 1 部暂缓作品，保留其当前片库记录，留待下次增量整理。",
      { exact: true },
    )
    .waitFor();
  await partialConfirmation
    .getByText(
      "将勾选的 1 个已缺失文件记录从片库移除。未勾选的记录保持不变。",
      { exact: true },
    )
    .waitFor();
  await partialConfirmation
    .getByText("源文件不会移动、重命名或删除。", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "test-results/organization-apply-summary.png",
    animations: "disabled",
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "应用整理", exact: true })
    .click();
  const partial = await page.evaluate(
    () => window.fixture.calls.find((c) => c.type === "organize-apply").value,
  );
  assert.deepEqual(
    partial.groups.map((g) => g.id),
    ["g1"],
  );
  assert.deepEqual(partial.collectionIds, []);
  assert.deepEqual(partial.acknowledgedRemovals, ["gone"]);
  assert.deepEqual(partial.relationshipRemovalIds, ["remove-existing"]);

  // Draft names and selections restore without another AI request. Missing name
  // keys inherit the generated title rather than disabling application.
  await page.goto(base);
  await page.evaluate(() => {
    const f = window.fixture;
    f.draft = {
      ...f.template,
      jobId: "restored-draft",
      fileExclusions: ["f3"],
      delta: {
        mode: "full",
        totalFiles: 4,
        unchangedFiles: 0,
        pendingFiles: 4,
        added: f.template.files,
        modified: [],
        removed: [],
      },
      reviewSelection: {
        groups: ["g1"],
        collections: [],
        names: { g1: "保留的草稿标题" },
      },
    };
  });
  await page.getByRole("button", { name: "智能整理", exact: true }).click();
  await page
    .getByRole("textbox", { name: "作品名称 · 示例作品 · 第一季", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", {
        name: "作品名称 · 示例作品 · 第一季",
        exact: true,
      })
      .inputValue(),
    "保留的草稿标题",
  );
  assert.equal(
    await page
      .getByRole("textbox", {
        name: "作品名称 · 示例作品 · 第二季",
        exact: true,
      })
      .inputValue(),
    "示例作品 · 第二季",
  );
  assert(
    !(await page
      .getByRole("checkbox", { name: "示例作品 · 第二季", exact: true })
      .isChecked()),
  );
  await page
    .getByRole("textbox", { name: "作品名称 · 示例作品 · 第一季", exact: true })
    .fill("新的草稿标题");
  await page.waitForFunction(() =>
    window.fixture.calls.some(
      (c) =>
        c.type === "organize-review" && c.value.names.g1 === "新的草稿标题",
    ),
  );
  assert(
    !(await page.evaluate(() =>
      window.fixture.calls.some((c) => c.type === "organize"),
    )),
  );
  await page.getByRole("tab", { name: "变更", exact: true }).click();
  assert(
    await page
      .getByRole("checkbox", {
        name: "移出片库 · Example.S03E01.mkv",
        exact: true,
      })
      .isChecked(),
  );
  await page
    .getByRole("checkbox", {
      name: "移出片库 · Example.S03E01.mkv",
      exact: true,
    })
    .click();
  await page.waitForFunction(() =>
    window.fixture.calls.some(
      (c) =>
        c.type === "organize-review" && c.value.fileExclusions?.length === 0,
    ),
  );
  await page.screenshot({
    path: "test-results/organization-restored-draft.png",
    animations: "disabled",
  });
  await page.goto(base + "?empty");
  await page.getByRole("tab", { name: "合集", exact: true }).click();
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
    "Organization UI passed: setup, cancel, review selection, edits, flat collections, unassigned files, confirmation, responsive layout, safe incremental/partial application, deferred proposals, draft restoration, and deletion of populated/empty collections.",
  );
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections();
}
