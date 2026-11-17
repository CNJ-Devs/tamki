import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RuntimeLog,
  setRuntimeLog,
  logEvent,
  traced,
  observedFetch,
  diagnosticError,
} from "../src/diagnostics";
import { ProviderError } from "../src/providers/provider";

const temporary = () => mkdtempSync(path.join(tmpdir(), "tamki-log-test-"));
const lines = (directory: string) =>
  readFileSync(path.join(directory, "runtime.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
test("logs allow only operational metadata and bounded private files", () => {
  const directory = temporary();
  try {
    const log = new RuntimeLog(directory);
    log.write("request.test", {
      model: "fixture-model",
      status: 200,
      origin: "https://user:SECRET@example.test/v1/SECRET?api_key=SECRET",
      apiKey: "SECRET",
      headers: { Authorization: "SECRET" },
      prompt: "SECRET",
      body: "SECRET",
      output: "SECRET",
      error: new Error("SECRET"),
      message: "SECRET",
      path: "/private/SECRET",
    });
    const text = readFileSync(path.join(directory, "runtime.log"), "utf8");
    assert(!text.includes("SECRET"));
    assert.equal(lines(directory)[0].origin, "https://example.test");
    // Windows reports emulated mode bits; access is inherited from the profile
    // directory's NTFS ACL. POSIX permission bits are meaningful only on Unix.
    if (process.platform !== "win32")
      assert.equal(
        statSync(path.join(directory, "runtime.log")).mode & 0o777,
        0o600,
      );
    assert.deepEqual(diagnosticError(new Error("Bearer SECRET")), {
      errorName: "Error",
    });
    assert.equal(
      diagnosticError(new ProviderError("recognitionInvalid")).errorCode,
      "recognitionInvalid",
    );
    const rotating = new RuntimeLog(directory, 500, 2);
    for (let i = 0; i < 30; i++) rotating.write("request.test", { status: i });
    assert.deepEqual(readdirSync(directory).sort(), [
      "runtime.1.log",
      "runtime.2.log",
      "runtime.log",
    ]);
    for (const file of readdirSync(directory)) {
      assert(statSync(path.join(directory, file)).size <= 500);
      readFileSync(path.join(directory, file), "utf8")
        .trim()
        .split("\n")
        .forEach((line) => JSON.parse(line));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nested and concurrent operations retain distinct request traces and failures without raw data", async () => {
  const directory = temporary();
  setRuntimeLog(new RuntimeLog(directory));
  try {
    const request = observedFetch(
      (async () =>
        new Response("SECRET", {
          status: 429,
          headers: { "x-request-id": "req-fixture", "set-cookie": "SECRET" },
        })) as typeof fetch,
    );
    await Promise.all(
      ["first", "second"].map((operation) =>
        traced("feature", { operation }, async () => {
          const response = await request(
            "https://example.test/private/SECRET?key=SECRET",
            {
              method: "POST",
              headers: { authorization: "SECRET" },
              body: "SECRET",
            },
          );
          assert.equal(await response.text(), "SECRET");
          logEvent("feature.parsed");
        }),
      ),
    );
    await assert.rejects(
      traced("feature", {}, async () => {
        throw new ProviderError("recognitionInvalid");
      }),
      /recognitionInvalid/,
    );
    const entries = lines(directory);
    const starts = entries.filter((e) => e.event === "feature.start");
    assert.equal(new Set(starts.map((e) => e.traceId)).size, 3);
    for (const root of starts.slice(0, 2)) {
      const related = entries.filter((e) => e.traceId === root.traceId);
      const http = related.find((e) => e.event === "http.start");
      assert.equal(http.parentSpanId, root.spanId);
      assert.equal(related.find((e) => e.event === "http.headers").status, 429);
      assert.equal(
        related.find((e) => e.event === "http.headers").level,
        "warn",
      );
      assert(related.find((e) => e.event === "feature.done").durationMs >= 0);
    }
    assert.equal(entries.at(-1).errorCode, "recognitionInvalid");
    assert(
      !readFileSync(path.join(directory, "runtime.log"), "utf8").includes(
        "SECRET",
      ),
    );
  } finally {
    setRuntimeLog(undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unwritable logging destination never changes application results or errors", async () => {
  const directory = temporary();
  try {
    const file = path.join(directory, "not-a-directory");
    writeFileSync(file, "fixture");
    setRuntimeLog(new RuntimeLog(file));
    assert.equal(await traced("feature", {}, async () => 42), 42);
    const error = new Error("private error");
    await assert.rejects(
      traced("feature", {}, async () => {
        throw error;
      }),
      (e) => e === error,
    );
  } finally {
    setRuntimeLog(undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});
