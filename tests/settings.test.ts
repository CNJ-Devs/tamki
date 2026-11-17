import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings,
  newSource,
  sourceSchema,
  promptSchema,
} from "../src/shared/settings";
import { promptDocument, serializePrompt } from "../src/shared/prompt";
import { discoverModels } from "../src/providers/models";
import { LibraryStore } from "../src/library/store";

test("existing profiles receive independent settings defaults; preferences do not contain secrets", () => {
  const s = new LibraryStore(":memory:", "zh");
  try {
    const settings = s.snapshot().settings;
    assert.deepEqual(settings, defaultSettings("zh"));
    assert.equal(settings.recognition.sources.length, 0);
    assert.match(settings.recognition.aiPrompt, /\{\{scope\}\}/);
    settings.downloads.series.fixed = {
      connectionId: "storage",
      path: "/Media",
    };
    assert.equal(s.snapshot().settings.downloads.series.fixed, null);
  } finally {
    s.close();
  }
});
test("prompt variables round-trip as atomic nodes with scope and preserve Unicode/newlines", () => {
  const value = "识别 {{scope}}\n{{title}} 和 {{files}}\n\n尾行";
  const doc = promptDocument(value);
  assert.equal(serializePrompt(doc), value);
  assert.equal(doc.content![0].content![1].type, "promptVariable");
  assert(promptSchema.safeParse(value).success);
  assert(!promptSchema.safeParse("{{episodeName}}").success);
});
test("source validation enforces provider protocols and safe credential endpoints", () => {
  const source = newSource("openai");
  assert(sourceSchema.safeParse(source).success);
  assert(
    !sourceSchema.safeParse({ ...source, endpoint: "https://wrong.example" })
      .success,
  );
  assert(
    !sourceSchema.safeParse({ ...source, protocol: "chat-completions" })
      .success,
  );
  const compatible = {
    ...newSource("openai-compatible"),
    endpoint: "http://127.0.0.1:11434/v1",
  };
  assert(sourceSchema.safeParse(compatible).success);
  for (const endpoint of [
    "http://remote.example/v1",
    "file:///etc/passwd",
    "https://user:password@example.com",
    "https://example.com?key=secret",
  ]) {
    assert(!sourceSchema.safeParse({ ...compatible, endpoint }).success);
  }
  assert(
    !sourceSchema.safeParse({ ...compatible, searchMode: "native" }).success,
  );
  assert(
    !sourceSchema.safeParse({ ...source, timeoutSeconds: Infinity }).success,
  );
});
test("model discovery uses each provider's authentication, filters Gemini and honors pagination", async () => {
  for (const provider of [
    "openai",
    "deepseek",
    "anthropic",
    "gemini",
  ] as const) {
    const source = newSource(provider);
    let calls = 0;
    const models = await discoverModels(source, "fixture-key", (async (
      input,
      init,
    ) => {
      calls++;
      const url = new URL(String(input)),
        headers = init!.headers as Record<string, string>;
      assert.equal(init!.redirect, "error");
      assert(!url.href.includes("fixture-key"));
      if (provider === "gemini") {
        assert.equal(headers["x-goog-api-key"], "fixture-key");
        assert.equal(url.pathname, "/v1beta/models");
        if (calls === 1)
          return Response.json({
            models: [
              {
                name: "models/embed",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
            nextPageToken: "page2",
          });
        assert.equal(url.searchParams.get("pageToken"), "page2");
        return Response.json({
          models: [
            {
              name: "models/text",
              displayName: "Text",
              supportedGenerationMethods: ["generateContent"],
              outputTokenLimit: 8192,
            },
          ],
        });
      }
      if (provider === "anthropic") {
        assert.equal(headers["x-api-key"], "fixture-key");
        assert.equal(headers["anthropic-version"], "2023-06-01");
        assert.equal(url.pathname, "/v1/models");
      } else assert.equal(headers.Authorization, "Bearer fixture-key");
      return Response.json({
        data: [{ id: "text", display_name: "Text", max_output_tokens: 8192 }],
      });
    }) as typeof fetch);
    assert.deepEqual(models, [{ id: "text", name: "Text", outputLimit: 8192 }]);
  }
});
test("discovery rejects credentials and malformed/cyclic listings without leaking provider bodies", async () => {
  const source = newSource("anthropic");
  await assert.rejects(() => discoverModels(source, "", fetch), /keyRequired/);
  await assert.rejects(
    () =>
      discoverModels(
        source,
        "fixture",
        (async () =>
          new Response("private secret", { status: 401 })) as typeof fetch,
      ),
    /^Error: sourceUnauthorized$/,
  );
  await assert.rejects(
    () =>
      discoverModels(source, "fixture", (async () =>
        Response.json({
          data: [],
          has_more: true,
          last_id: "same",
        })) as typeof fetch),
    /^Error: modelListFailed$/,
  );
  await assert.rejects(
    () =>
      discoverModels(source, "fixture", (async () =>
        Response.json({ private: "secret" })) as typeof fetch),
    /^Error: modelListFailed$/,
  );
});
