import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClaudeCode,
  runOfficialCLI,
  type RuntimeCall,
} from "../src/providers/claude-code";
import { newSource } from "../src/shared/settings";
import type { RecognitionInput } from "../src/shared/recognition";

import { runtimeFixture } from "./fixtures/claude-runtime";

test("Claude uses the unmodified runtime's own login, live catalog and safe structured recognition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tamki-claude-test-"));
  const fixture = runtimeFixture();
  const runtime = new ClaudeCode({
    root,
    runner: fixture.runner,
    resolve: async () => "/fixture/claude",
  });
  const source = { ...newSource("claude-code"), model: "fixture-model" };
  try {
    const account = await runtime.signIn(source);
    assert.equal(account.billing, "subscription");
    assert.equal(account.status, "connected");
    assert.equal(fixture.calls[0].capture, false);
    assert.match(fixture.calls[0].env.CLAUDE_CONFIG_DIR!, /config$/);
    assert(fixture.calls[0].env.CLAUDE_CONFIG_DIR!.startsWith(root));
    assert.deepEqual(await runtime.models(source), [
      { id: "fixture-model", name: "Fixture Model" },
    ]);
    const input: RecognitionInput = {
      title: "--dangerously-skip-permissions $(echo secret)",
      scope: "file",
      files: [
        {
          id: "stable",
          filename: "$(echo secret).mkv",
          duration: 10,
          order: 3,
        },
      ],
    };
    const result = await runtime.recognize(
      source,
      input,
      "{{title}}",
      AbortSignal.timeout(2000),
    );
    assert.equal(result.kind, "result");
    if (result.kind === "result") {
      assert.equal(result.result.files[0].id, "stable");
      assert.equal(result.citations[0].url, "https://example.test/film");
    }
    const call = fixture.calls.at(-1)!;
    assert(call.args.includes("--restricted"));
    assert(!call.args.includes("--bare"));
    assert.equal(
      call.args[call.args.indexOf("--tools") + 1],
      "WebSearch,WebFetch",
    );
    assert(call.args.includes("--strict-mcp-config"));
    assert(call.args.includes("--no-session-persistence"));
    assert(!call.args.join(" ").includes("$(echo secret)"));
    assert(call.input!.includes("$(echo secret)"));
    assert.equal(await runtime.signOut(source), true);
    assert.equal((await runtime.status(source)).status, "signedOut");
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude refuses unsuccessful runs, failed search evidence and scope drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tamki-claude-test-"));
  const fixture = runtimeFixture();
  fixture.h.loggedIn = true;
  const runtime = new ClaudeCode({
    root,
    runner: fixture.runner,
    resolve: async () => "/fixture/claude",
  });
  const source = { ...newSource("claude-code"), model: "fixture-model" };
  const input: RecognitionInput = {
    title: "Fixture",
    scope: "file",
    files: [{ id: "stable", filename: "1.mkv", duration: null, order: 1 }],
  };
  const run = () =>
    runtime.recognize(source, input, "{{title}}", AbortSignal.timeout(2000));
  try {
    fixture.h.failed = true;
    await assert.rejects(run(), /recognitionFailed/);
    fixture.h.failed = false;
    fixture.h.permissionDenied = true;
    await assert.rejects(run(), /oauthSearchUnverified/);
    fixture.h.permissionDenied = false;
    fixture.h.search = false;
    await assert.rejects(run(), /oauthSearchUnverified/);
    fixture.h.search = true;
    fixture.h.scopeWrong = true;
    await assert.rejects(run(), /recognitionScopeInvalid/);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime process preserves split UTF-8 output and terminates on cancellation without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tamki-runtime-test-"));
  const file = path.join(root, "fixture.cjs");
  try {
    await writeFile(
      file,
      "const b=Buffer.from('第一集'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.end(b.subarray(1)),20);",
    );
    const call: RuntimeCall = {
      executable: process.execPath,
      args: [file],
      cwd: root,
      env: process.env,
      signal: AbortSignal.timeout(2000),
    };
    assert.equal((await runOfficialCLI(call)).output, "第一集");
    await writeFile(file, "setInterval(()=>{},1000);");
    const controller = new AbortController();
    const pending = runOfficialCLI({ ...call, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, /oauthCancelled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
