import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LibraryStore } from "../src/library/store";
import { AutomaticRecognition } from "../src/library/automatic-recognition";
import { defaultSettings } from "../src/shared/settings";
import {
  batchRecognitionSchema,
  type RecognitionRequest,
  type RecognitionResponse,
} from "../src/shared/recognition";

function setup(file = ":memory:") {
  const store = new LibraryStore(file);
  store.saveConnection({
    id: "local",
    type: "local",
    name: "Fixture",
    roots: ["/media"],
    status: "connected",
    error: null,
    scannedAt: 1,
  });
  store.applyScan("local", "/media", {
    groups: Array.from({ length: 5 }, (_, i) => ({
      path: `/media/Work${i}`,
      name: `Work${i}`,
      files: [
        {
          path: `/media/Work${i}/01.mp4`,
          name: "01.mp4",
          directory: false,
          size: 10,
          modified: 1,
        },
      ],
    })),
    completeDirectories: [],
    failures: [],
  });
  return store;
}
const result = (request: RecognitionRequest): RecognitionResponse => ({
  kind: "result",
  citations: [],
  result: {
    work: {
      title: request.query,
      description: "Synopsis",
      tags: null,
      cover: "a".repeat(64),
    },
    files: [],
  },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail("Queue did not reach the expected state");
}
function deferredEngine() {
  const jobs = new Map<
    string,
    {
      request: RecognitionRequest;
      resolve(response: RecognitionResponse): void;
      reject(error: Error): void;
    }
  >();
  const calls: RecognitionRequest[] = [];
  let active = 0,
    peak = 0;
  return {
    jobs,
    calls,
    get peak() {
      return peak;
    },
    run(request: RecognitionRequest) {
      calls.push(request);
      active++;
      peak = Math.max(peak, active);
      return new Promise<RecognitionResponse>((resolve, reject) =>
        jobs.set(request.jobId, { request, resolve, reject }),
      ).finally(() => {
        active--;
        jobs.delete(request.jobId);
      });
    },
    cancel(job: string) {
      jobs.get(job)?.reject(new Error("recognitionCancelled"));
    },
  };
}

test("explicit batches run at most three works concurrently with automatic identification off and preserve manual edits", async () => {
  const store = setup(),
    config = defaultSettings("en");
  config.recognition.automatic = false;
  const engine = deferredEngine();
  const queue = new AutomaticRecognition(
    store,
    { snapshot: () => config },
    engine,
    () => {},
    0,
  );
  const works = store.snapshot().works,
    ids = works.slice(0, 4).map((w) => w.id);
  try {
    queue.start();
    assert.equal(engine.calls.length, 0);
    store.setRecognition(ids[0], {
      status: "complete",
      sourceId: "bilibili",
      signature: "previous",
      candidate: "bilibili:season:999",
    });
    queue.enqueue(ids, "bilibili");
    await until(() => engine.calls.length === 3);
    assert.equal(engine.calls.length, 3);
    assert.equal(engine.peak, 3);
    assert.equal(
      engine.calls[0].candidate,
      undefined,
      "explicit identification must search using current intent rather than reuse an old candidate",
    );
    assert.equal(
      store.snapshot().works.find((w) => w.id === ids[3])?.recognition?.status,
      "queued",
    );
    queue.schedule();
    assert(engine.calls.every((c) => c.sourceId === "bilibili"));
    const work = works[0];
    store.edit({
      ...work,
      title: "My title",
      description: "My synopsis",
      removedEpisodeIds: [],
      attachments: [],
      episodes: work.episodes.map(({ id, number, title, description }) => ({
        id,
        number,
        title,
        description,
      })),
    });
    const first = [...engine.jobs.values()][0];
    first.resolve(result(first.request));
    await until(() => engine.calls.length === 4);
    for (const job of engine.jobs.values()) job.resolve(result(job.request));
    await until(
      () =>
        store
          .snapshot()
          .works.filter(
            (w) => ids.includes(w.id) && w.recognition?.status === "complete",
          ).length === 4,
    );
    assert.equal(engine.peak, 3);
    assert(engine.calls.every((c) => c.sourceId === "bilibili"));
    assert.equal(
      store.snapshot().works.find((w) => w.id === work.id)?.title,
      "My title",
    );
    assert.equal(
      store.snapshot().works.find((w) => w.id === work.id)?.description,
      "My synopsis",
    );
    assert.equal(
      store.snapshot().works.find((w) => w.id === works[4].id)?.recognition,
      undefined,
    );
  } finally {
    await queue.close();
    store.close();
  }
});

test("new batches wake a running automatic queue; ordinary background jobs remain serial", async () => {
  const store = setup(),
    config = defaultSettings("en"),
    engine = deferredEngine();
  const queue = new AutomaticRecognition(
    store,
    { snapshot: () => config },
    engine,
    () => {},
    0,
  );
  try {
    queue.start();
    assert.equal(engine.calls.length, 1);
    const automaticId = engine.calls[0].draft.id;
    queue.enqueue(
      store
        .snapshot()
        .works.filter((w) => w.id !== automaticId)
        .map((w) => w.id),
      "bilibili",
    );
    await until(() => engine.calls.length === 3);
    assert.equal(
      engine.calls.filter((c) => c.sourceId === "bangumi").length,
      1,
    );
    assert.equal(engine.peak, 3);
    await queue.pause();
    assert(
      store.snapshot().works.every((w) => w.recognition?.status === "queued"),
    );
  } finally {
    await queue.close();
    store.close();
  }
});

test("batch cancellation preserves completed siblings and never applies late cancelled results; explicit retry is allowed", async () => {
  const store = setup(),
    config = defaultSettings("en");
  config.recognition.automatic = false;
  const engine = deferredEngine(),
    queue = new AutomaticRecognition(
      store,
      { snapshot: () => config },
      engine,
      () => {},
      0,
    );
  const ids = store
    .snapshot()
    .works.slice(0, 4)
    .map((w) => w.id);
  try {
    queue.enqueue(ids, "bilibili");
    const first = [...engine.jobs.values()][0];
    first.resolve(result(first.request));
    await until(() => engine.calls.length === 4);
    queue.cancel(ids);
    await until(() => engine.jobs.size === 0);
    const after = store.snapshot().works.filter((w) => ids.includes(w.id));
    assert.equal(
      after.filter((w) => w.recognition?.status === "complete").length,
      1,
    );
    assert.equal(
      after.filter((w) => w.recognition?.error === "recognitionCancelled")
        .length,
      3,
    );
    assert(
      after
        .filter((w) => w.recognition?.status === "failed")
        .every((w) => !w.description && !w.cover),
    );
    const retry = after.find((w) => w.recognition?.status === "failed")!;
    queue.enqueue([retry.id], "bilibili");
    await until(() => engine.jobs.size === 1);
    const next = [...engine.jobs.values()][0];
    next.resolve(result(next.request));
    await until(
      () =>
        store.snapshot().works.find((w) => w.id === retry.id)?.recognition
          ?.status === "complete",
    );
  } finally {
    await queue.close();
    store.close();
  }
});

test("explicit jobs resume from persisted state after restart with automatic recognition disabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tamki-batch-")),
    file = path.join(directory, "library.sqlite");
  let store = setup(file);
  const config = defaultSettings("en");
  config.recognition.automatic = false;
  let engine = deferredEngine(),
    queue = new AutomaticRecognition(
      store,
      { snapshot: () => config },
      engine,
      () => {},
      0,
    );
  try {
    const ids = store
      .snapshot()
      .works.slice(0, 4)
      .map((w) => w.id);
    queue.enqueue(ids, "bilibili");
    assert.equal(engine.calls.length, 3);
    await queue.close();
    store.close();
    store = new LibraryStore(file);
    engine = deferredEngine();
    queue = new AutomaticRecognition(
      store,
      { snapshot: () => config },
      engine,
      () => {},
      0,
    );
    queue.start();
    assert.equal(engine.calls.length, 3);
    for (const job of engine.jobs.values()) job.resolve(result(job.request));
    await until(() => engine.calls.length === 4);
    for (const job of engine.jobs.values()) job.resolve(result(job.request));
    await until(
      () =>
        store
          .snapshot()
          .works.filter((w) => w.recognition?.status === "complete").length ===
        4,
    );
  } finally {
    await queue.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("one failure or ambiguous search does not stop siblings or choose the first result", async () => {
  const store = setup(),
    config = defaultSettings("en");
  config.recognition.automatic = false;
  let calls = 0;
  const queue = new AutomaticRecognition(
    store,
    { snapshot: () => config },
    {
      async run(request) {
        const index = calls++;
        if (index === 0) throw Error("sourceRateLimited");
        if (index === 1)
          return {
            kind: "candidates",
            candidates: [
              {
                id: "bilibili:season:1",
                title: "Other",
                description: "",
                date: "",
              },
              {
                id: "bilibili:season:2",
                title: "Other",
                description: "",
                date: "",
              },
            ],
          } as RecognitionResponse;
        if (index === 2)
          return { kind: "candidates", candidates: [] } as RecognitionResponse;
        return result(request);
      },
      cancel() {},
    },
    () => {},
    0,
  );
  try {
    queue.enqueue(
      store.snapshot().works.map((w) => w.id),
      "bilibili",
    );
    await until(
      () =>
        calls === 5 &&
        store
          .snapshot()
          .works.every(
            (w) => !["running", "queued"].includes(w.recognition?.status || ""),
          ),
    );
    const statuses = store.snapshot().works.map((w) => w.recognition?.status);
    assert.equal(statuses.filter((s) => s === "failed").length, 1);
    assert.equal(statuses.filter((s) => s === "needs-choice").length, 1);
    assert.equal(statuses.filter((s) => s === "no-match").length, 1);
    assert.equal(statuses.filter((s) => s === "complete").length, 2);
    assert.equal(
      batchRecognitionSchema.safeParse({
        sourceId: "bilibili",
        workIds: ["same", "same"],
      }).success,
      false,
    );
  } finally {
    await queue.close();
    store.close();
  }
});
