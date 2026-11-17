import test from "node:test";
import assert from "node:assert/strict";
import {
  recognitionPrompt,
  recognitionRequestSchema,
  validateRecognition,
} from "../src/shared/recognition";
import { aiRecognitionBatches } from "../src/providers/ai-recognition";
import { newSource } from "../src/shared/settings";
import { ProviderError } from "../src/providers/provider";
const file = {
  id: "episode",
  filename: "original.mkv",
  duration: 120,
  order: 1,
};
const previous = {
  work: null,
  files: [{ id: file.id, title: "Earlier", number: "1", description: null }],
};
const messages = [
  "Check https://reference.example/work",
  "Keep the verified title",
];
test("feedback preserves original evidence, ordered corrections and strict scope", () => {
  const input = {
    title: "Work",
    scope: "file" as const,
    files: [file],
    feedback: { previous, messages },
  };
  const prompt = recognitionPrompt(input, "Identify metadata");
  assert.ok(prompt.includes(JSON.stringify(input)));
  assert.deepEqual(validateRecognition(previous, input), previous);
  assert.throws(
    () =>
      validateRecognition(
        {
          ...previous,
          work: { title: "Changed work", description: null, tags: null },
        },
        input,
      ),
    /recognitionScopeInvalid/,
  );
  assert.throws(
    () =>
      validateRecognition(
        { ...previous, files: [{ ...previous.files[0], id: "other" }] },
        input,
      ),
    /recognitionScopeInvalid/,
  );
  const schema = recognitionRequestSchema.shape.feedback;
  assert.ok(schema.safeParse({ previous, messages }).success);
  for (const messages of [
    [],
    [" "],
    Array(9).fill("note"),
    ["x".repeat(8001)],
    Array(4).fill("x".repeat(7000)),
  ])
    assert.equal(schema.safeParse({ previous, messages }).success, false);
});
test("batched feedback retains work context and notes while limiting prior file IDs to each batch", async () => {
  const files = Array.from({ length: 26 }, (_, i) => ({
    ...file,
    id: `file-${i}`,
    order: i + 1,
  }));
  const proposal = {
    work: { title: "Earlier work", description: null, tags: null },
    files: files.map((f) => ({ ...previous.files[0], id: f.id })),
  };
  let calls = 0;
  const response = await aiRecognitionBatches(
    { ...newSource("openai-compatible"), model: "fixture" },
    "",
    "",
    {
      title: "Work",
      scope: "work",
      files,
      feedback: { previous: proposal, messages },
    },
    "Identify",
    AbortSignal.timeout(1000),
    fetch,
    async (input) => {
      calls++;
      if (input.files.length > 13)
        throw new ProviderError("recognitionTruncated");
      assert.deepEqual(input.feedback!.messages, messages);
      assert.deepEqual(input.feedback!.previous.work, proposal.work);
      assert.deepEqual(
        input.feedback!.previous.files.map((f) => f.id),
        input.files.map((f) => f.id),
      );
      return {
        kind: "result",
        result: input.feedback!.previous,
        citations: [],
      };
    },
  );
  assert.ok(calls > 1);
  assert.equal(response.kind, "result");
  if (response.kind === "result")
    assert.equal(response.result.files.length, 26);
});
