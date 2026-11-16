import test from "node:test";
import assert from "node:assert/strict";
import { openAIStream, usedWebSearch } from "../src/providers/openai-stream";
import { aiStructured } from "../src/providers/ai-recognition";
import { newSource } from "../src/shared/settings";

const done = (output: unknown[]) => ({
  type: "response.completed",
  response: { status: "completed", output },
});
const message = {
  type: "message",
  content: [{ type: "output_text", text: '{"groups":[]}' }],
};
function stream(events: unknown[], finalBlank = true) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}`).join("\r\n\r\n") +
      (finalBlank ? "\r\n\r\n" : ""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, (offset += 11)));
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const run = (events: unknown[], finalBlank = true) =>
  openAIStream({}, new AbortController().signal, (async () =>
    stream(events, finalBlank)) as typeof fetch);

test("completed web calls accept optional action and page operations, never text citations or pending calls", () => {
  for (const action of [
    undefined,
    { type: "search" },
    { type: "open_page", url: "https://example.test" },
    { type: "find_in_page", pattern: "Episode" },
  ]) {
    assert(
      usedWebSearch({
        status: "completed",
        output: [{ type: "web_search_call", status: "completed", action }],
      }),
    );
  }
  for (const status of ["in_progress", "searching", "failed", "incomplete"])
    assert.equal(
      usedWebSearch({
        status: "completed",
        output: [{ type: "web_search_call", status }],
      }),
      false,
    );
  assert.equal(
    usedWebSearch({
      status: "failed",
      output: [{ type: "web_search_call", status: "completed" }],
    }),
    false,
  );
  assert.equal(
    usedWebSearch({
      status: "completed",
      output: [
        {
          ...message,
          content: [
            {
              type: "output_text",
              text: "I searched https://example.test",
              annotations: [
                { type: "url_citation", url: "https://example.test" },
              ],
            },
          ],
        },
      ],
    }),
    false,
  );
  assert.equal(usedWebSearch(null), false);
  assert.equal(usedWebSearch({ status: "completed" }), false);
});

test("stream retains tool completion events through terminal success without duplicating calls", async () => {
  const item = {
    id: "ws_fixture",
    type: "web_search_call",
    status: "completed",
  };
  for (const event of [
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.web_search_call.completed",
      output_index: 0,
      item_id: item.id,
    },
  ]) {
    const response = await run([event, done([message])], false);
    assert(usedWebSearch(response));
    assert.equal(
      response.output.filter((i: any) => i.type === "web_search_call").length,
      1,
    );
    assert.deepEqual(response.output[0], message);
    const repeated = await run([event, done([item, message])]);
    assert.equal(repeated.output.length, 2);
    assert(usedWebSearch(repeated));
  }
  // Evidence is local to a single request, not reused by the next batch.
  assert.equal(usedWebSearch(await run([done([message])])), false);
});

test("search evidence never overrides terminal failure, truncation or interruption", async () => {
  const search = {
    type: "response.web_search_call.completed",
    output_index: 0,
    item_id: "ws_fixture",
  };
  for (const status of ["failed", "incomplete"])
    assert.equal(
      usedWebSearch(
        await run([
          search,
          done([{ id: search.item_id, type: "web_search_call", status }]),
        ]),
      ),
      false,
    );
  await assert.rejects(run([search]), /oauthStreamInterrupted/);
  await assert.rejects(
    run([
      search,
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
    ]),
    /recognitionTruncated/,
  );
  await assert.rejects(
    run([
      search,
      {
        type: "response.failed",
        response: {
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      },
    ]),
    /oauthUsageLimit/,
  );
  const pending = await run([
    {
      type: "response.output_item.added",
      item: { id: "pending", type: "web_search_call", status: "searching" },
    },
    done([message]),
  ]);
  assert.equal(usedWebSearch(pending), false);
});

test("OAuth structured organization accepts completed search without optional action and rejects no-search responses", async () => {
  const source = { ...newSource("openai-oauth"), model: "fixture-model" };
  const task = {
    name: "tamki_organization",
    system: "Group synthetic files.",
    prompt: "Synthetic file data.",
    queries: ["Example"],
    schema: { type: "object", properties: { groups: { type: "array" } } },
  };
  for (const evidence of [
    [{ type: "web_search_call", id: "ws_fixture", status: "completed" }],
    [],
  ]) {
    const request = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tool_choice.type, "web_search");
      assert.equal(body.text.format.name, "tamki_organization");
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, undefined);
      return stream([done([...evidence, message])]);
    }) as typeof fetch;
    const result = aiStructured(
      source,
      "managed",
      "",
      task,
      new AbortController().signal,
      request,
    );
    if (evidence.length)
      assert.deepEqual(JSON.parse((await result).text), { groups: [] });
    else await assert.rejects(result, /oauthSearchUnverified/);
  }
});

test("completed message events supply the result when the terminal response has no output", async () => {
  const completed = {
    ...message,
    id: "msg_fixture",
    status: "completed",
    phase: "final_answer",
  };
  const events = [
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "ws_fixture", type: "web_search_call", status: "completed" },
    },
    { type: "response.output_item.done", output_index: 1, item: completed },
  ];
  const response = await run([...events, done([])]);
  assert.deepEqual(response.output[1], completed);
  assert(usedWebSearch(response));
  const source = { ...newSource("openai-oauth"), model: "fixture" };
  const result = await aiStructured(
    source,
    "managed",
    "",
    {
      name: "tamki_organization",
      system: "Synthetic",
      prompt: "Synthetic",
      schema: {},
      queries: [],
    },
    new AbortController().signal,
    (async () => stream([...events, done([])])) as typeof fetch,
  );
  assert.deepEqual(JSON.parse(result.text), { groups: [] });
  const terminal = {
    ...completed,
    content: [{ type: "output_text", text: "terminal wins" }],
  };
  const repeated = await run([...events, done([terminal])]);
  assert.equal(
    repeated.output.filter((i: any) => i.type === "message").length,
    1,
  );
  assert.deepEqual(repeated.output[0], terminal);
  assert.equal((await run([done([])])).output.length, 0);
});

test("streamed text cannot turn unfinished, failed or interrupted responses into success", async () => {
  const completed = {
    type: "response.output_item.done",
    item: { ...message, id: "msg_fixture", status: "completed" },
  };
  await assert.rejects(run([completed]), /oauthStreamInterrupted/);
  await assert.rejects(
    run([
      completed,
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
    ]),
    /recognitionTruncated/,
  );
  await assert.rejects(
    run([completed, { type: "response.failed" }]),
    /recognitionFailed/,
  );
  for (const event of [
    {
      type: "response.output_item.added",
      item: { ...message, id: "msg_fixture", status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_fixture",
      delta: '{"groups":[]}',
    },
    {
      type: "response.output_item.done",
      item: { ...message, id: "msg_fixture", status: "incomplete" },
    },
  ])
    assert.equal((await run([event, done([])])).output.length, 0);
  const failed = {
    ...message,
    id: "msg_fixture",
    status: "incomplete",
    content: [],
  };
  assert.deepEqual((await run([completed, done([failed])])).output, [failed]);
  await assert.rejects(
    run([
      completed,
      {
        type: "response.completed",
        response: { status: "completed", output: {} },
      },
    ]),
    /recognitionInvalid/,
  );
});

test("structured output excludes commentary and rejects an explicitly incomplete final message", async () => {
  const source = {
    ...newSource("openai-oauth"),
    model: "fixture",
    searchMode: "none" as const,
  };
  const task = {
    name: "tamki_organization",
    system: "Synthetic",
    prompt: "Synthetic",
    schema: {},
    queries: [],
  };
  const commentary = {
    ...message,
    id: "comment",
    status: "completed",
    phase: "commentary",
    content: [{ type: "output_text", text: "Looking up titles." }],
  };
  const final = {
    ...message,
    id: "final",
    status: "completed",
    phase: "final_answer",
  };
  const execute = (output: unknown[]) =>
    aiStructured(
      source,
      "managed",
      "",
      task,
      new AbortController().signal,
      (async () => stream([done(output)])) as typeof fetch,
    );
  assert.equal((await execute([commentary, final])).text, '{"groups":[]}');
  await assert.rejects(
    execute([{ ...final, status: "incomplete" }]),
    /recognitionInvalid/,
  );
  await assert.rejects(execute([commentary]), /recognitionEmpty/);
});

test("directory analysis keeps hosted search available without forcing it; context and content-filter errors differ", async () => {
  const source = {
    ...newSource("openai-oauth"),
    model: "fixture",
    searchMode: "native" as const,
  };
  const task = {
    name: "tamki_organization",
    system: "Group the tree",
    prompt: "data",
    schema: {},
    queries: [],
    searchPolicy: "optional" as const,
  };
  const result = await aiStructured(
    source,
    "managed",
    "",
    task,
    new AbortController().signal,
    (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.tools[0].type, "web_search");
      return stream([done([message])]);
    }) as typeof fetch,
  );
  assert.equal(result.text, '{"groups":[]}');
  await assert.rejects(
    run([
      {
        type: "response.failed",
        response: {
          error: { code: "context_length_exceeded", message: "private input" },
        },
      },
    ]),
    /recognitionContextLimit/,
  );
  await assert.rejects(
    run([
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "content_filter" } },
      },
    ]),
    /recognitionFailed/,
  );
});
