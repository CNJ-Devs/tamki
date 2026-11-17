import test from "node:test";
import assert from "node:assert/strict";
import {
  organizationDelta,
  reviewedOrganizationFiles,
} from "../src/library/organization-review";
import { OrganizationInput } from "../src/library/organization-input";
import { LibraryStore } from "../src/library/store";
import { scanScopes } from "../src/library/scan";
import {
  organizationSnapshot,
  organizationStateChanges,
} from "../src/library/organization-state";
import type { Entry } from "../src/shared/model";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compactOrganizationTask } from "../src/library/organization-compact-input";

const entry = (path: string, directory = false): Entry => ({
  path,
  name: path.split("/").at(-1)!,
  directory,
  size: directory ? 0 : 100,
  modified: 1,
});

test("manual relationship deletion survives restart and reaches incremental input without removing members", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "tamki-relationship-intent-"),
  );
  let store = new LibraryStore(path.join(directory, "library.sqlite"));
  try {
    store.saveConnection({
      id: "storage",
      name: "Fixture",
      type: "local",
      roots: ["/library"],
      status: "connected",
      error: null,
      scannedAt: 1,
    });
    const tree: Record<string, Entry[]> = {
      "/library": [
        entry("/library/A", true),
        entry("/library/B", true),
        entry("/library/C", true),
      ],
      "/library/A": [entry("/library/A/01.mkv")],
      "/library/B": [entry("/library/B/01.mkv")],
      "/library/C": [entry("/library/C/01.mkv")],
    };
    const scan = await scanScopes(
      { list: async (p: string) => tree[p] } as any,
      [{ root: "/library", depth: 1 }],
    );
    store.applyScan("storage", "/library", scan);
    const inventory = store.organizationCandidates("storage", scan).files;
    const original = store.snapshot().works;
    const workIds = original.slice(0, 2).map((w) => w.id);
    const series = store.saveSeries({ name: "Family", workIds }, false);
    assert.deepEqual(store.organizationContext([]).relationshipEdits, []);
    store.saveSeries({ ...series, name: "Family" });
    const collection = store.saveCollection({
      name: "Redundant selection",
      workIds: [],
      seriesIds: [series.id],
    });
    const before = store.organizationSnapshot();
    const files = reviewedOrganizationFiles(inventory, before);
    store.removeCollection(collection.id);
    store.removeCollection("does-not-exist");
    store.close();
    store = new LibraryStore(path.join(directory, "library.sqlite"));
    assert.deepEqual(store.snapshot().works, original);
    assert.deepEqual(store.snapshot().series, [series]);
    assert.equal(store.snapshot().collections.length, 0);
    const delta = organizationDelta(
      inventory,
      store.organizationSnapshot(),
      { version: 1, reviewedAt: 1, files },
      true,
    );
    assert.equal(delta.delta.modified.length, 2);
    assert.deepEqual(
      new Set(delta.files.map((f) => f.workId)),
      new Set(workIds),
    );
    const context = store.organizationContext(delta.files);
    const removed = context.relationshipEdits!.filter(
      (e) => e.action === "removed",
    );
    assert.equal(removed.length, 1);
    assert.deepEqual(removed[0].workIds, workIds);
    assert.equal(removed[0].name, collection.name);
    const input = new OrganizationInput(
      delta.files,
      [],
      context,
      [{ connectionId: "storage", path: "/library", depth: 1 }],
      true,
    );
    const task = input.directTask("", "en");
    const compact = compactOrganizationTask(task);
    const serialized = JSON.parse(
      compact.prompt.split("INPUT:\n")[1].split("\nUSER PREFERENCES:")[0],
    );
    const packet = input.packet();
    assert.deepEqual(
      serialized.current.relationshipEdits,
      packet.current.relationshipEdits,
    );
    assert.deepEqual(
      packet.current.relationshipEdits.find((e) => e.action === "removed")!
        .works,
      workIds.map((id) => input.workRefs.get(id)),
    );
    assert.match(task.system, /do not recreate a removed relationship/);
    const groups = inventory.map((f, i) => ({
      id: `g${i}`,
      title: f.currentTitle!,
      fileIds: [f.id],
      review: false,
      reason: "",
      existingWorkId: f.workId,
    }));
    const plan = {
      jobId: "approved-replacement",
      files: inventory,
      groups,
      collections: [
        {
          id: "new-selection",
          name: "Approved selection",
          groupIds: groups
            .filter((g) => workIds.includes(g.existingWorkId!))
            .map((g) => g.id),
        },
      ],
      unassigned: [],
      excludedCount: 0,
    };
    store.applyOrganization(
      plan,
      {
        jobId: plan.jobId,
        groups: groups.map(({ id, title }) => ({ id, title })),
        collectionIds: ["new-selection"],
      },
      store.organizationSnapshot(),
    );
    assert.equal(
      store
        .organizationContext([])
        .relationshipEdits!.filter((e) => e.action === "removed").length,
      0,
    );
    store.removeCollection(store.snapshot().collections[0].id);
    // Explicitly recreating the same grouping under a new ID supersedes its deletion.
    store.saveCollection({ name: "Requested selection", workIds });
    assert.equal(
      store
        .organizationContext([])
        .relationshipEdits!.filter((e) => e.action === "removed").length,
      0,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read-only work anchors connect incremental relationships without resending or rewriting stable media", async () => {
  const store = new LibraryStore(":memory:");
  try {
    store.saveConnection({
      id: "storage",
      name: "Fixture",
      type: "local",
      roots: ["/library"],
      status: "connected",
      error: null,
      scannedAt: 1,
    });
    const tree: Record<string, Entry[]> = {
      "/library": [entry("/library/Old", true), entry("/library/New", true)],
      "/library/Old": [entry("/library/Old/Old.E01.mkv")],
      "/library/New": [entry("/library/New/New.E01.mkv")],
    };
    const scan = await scanScopes(
      { list: async (p: string) => tree[p] } as any,
      [{ root: "/library", depth: 1 }],
    );
    store.applyScan("storage", "/library", scan);
    const inventory = store.organizationCandidates("storage", scan).files;
    const changed = inventory.filter((f) => f.path.includes("/New/"));
    const context = store.organizationContext(changed);
    const old = context.works.find((w) => !w.files.length)!;
    const before = store.snapshot().works.find((w) => w.id === old.id)!;
    const data = new OrganizationInput(
      changed,
      [],
      context,
      [{ connectionId: "storage", path: "/library", depth: 1 }],
      true,
    );
    const anchor = data.workRefs.get(old.id)!;
    const response = {
      groups: [
        {
          identity: "new-work",
          title: "New work",
          fileIds: [data.fileRefs.get(changed[0].id)!],
          episodes: [],
          review: false,
          reason: "",
        },
      ],
      collections: [
        {
          kind: "series",
          name: "Related works",
          groupIds: ["new-work", anchor],
        },
      ],
      unassigned: [],
    };
    const stabilized = data.stabilize(data.decode(JSON.stringify(response)));
    assert.equal(stabilized.groups.filter((g) => g.referenceOnly).length, 1);
    const anchorGroup = stabilized.groups.find((g) => g.referenceOnly)!;
    assert.equal(anchorGroup.existingWorkId, old.id);
    assert.deepEqual(anchorGroup.fileIds, []);
    const plan = {
      jobId: "incremental",
      files: changed,
      ...stabilized,
      excludedCount: 0,
      scopes: [{ connectionId: "storage", path: "/library", depth: 1 }],
    };
    const applied = store.applyOrganization(
      plan,
      {
        jobId: plan.jobId,
        groups: plan.groups.map(({ id, title }) => ({ id, title })),
        collectionIds: plan.collections.map((c) => c.id),
      },
      store.organizationSnapshot(),
    );
    assert.equal(applied.works, 1);
    const after = store.snapshot();
    assert.deepEqual(
      after.works.find((w) => w.id === old.id),
      before,
    );
    assert.equal(after.series!.length, 1);
    assert.equal(after.series![0].workIds.length, 2);
    assert(after.series![0].workIds.includes(old.id));
    assert.throws(
      () =>
        data.decode(
          JSON.stringify({
            ...response,
            groups: [{ ...response.groups[0], fileIds: [anchor] }],
          }),
        ),
      /organizationInvalid/,
    );
    assert.throws(
      () =>
        data.decode(
          JSON.stringify({
            ...response,
            collections: [
              { ...response.collections[0], groupIds: ["new-work", "w999"] },
            ],
          }),
        ),
      /organizationInvalid/,
    );
  } finally {
    store.close();
  }
});

test("playback and artwork caches do not create review deltas; semantic changes and removals do", () => {
  const works = [
    {
      id: "w1",
      title: "Work",
      excluded: false,
      cover: "old",
      recognition: { status: "pending" },
      resumeId: null,
    },
  ];
  const files = [
    {
      id: "f1",
      workId: "w1",
      connectionId: "storage",
      path: "/library/Work/a.mkv",
      size: 100,
      modified: 1,
      position: 0,
      duration: null,
      cover: "old",
      excluded: false,
    },
  ];
  const roots = [{ connectionId: "storage", path: "/library", depth: 1 }];
  const before = organizationSnapshot(works, files, [], roots, {});
  const volatile = organizationSnapshot(
    [
      {
        ...works[0],
        cover: "new",
        resumeId: "f1",
        recognition: { status: "complete" },
      },
    ],
    [{ ...files[0], position: 55, duration: 120, cover: "new" }],
    [],
    roots,
    {},
  );
  assert.deepEqual(organizationStateChanges(before, volatile), {
    added: [],
    removed: [],
    modified: [],
    changedWorkIds: [],
    rootsChanged: false,
  });
  const addition = organizationSnapshot(
    works,
    [...files, { ...files[0], id: "f2", path: "/library/Work/b.mkv" }],
    [],
    roots,
    {},
  );
  const delta = organizationStateChanges(before, addition);
  assert.equal(delta.added.length, 1);
  assert.equal(delta.changedWorkIds.length, 0);
  assert.equal(delta.modified.length, 0);
  const modified = organizationSnapshot(
    [{ ...works[0], title: "Human title" }],
    [{ ...files[0], size: 200 }],
    [],
    roots,
    {},
  );
  assert.equal(organizationStateChanges(before, modified).modified.length, 1);
  assert.deepEqual(organizationStateChanges(before, modified).changedWorkIds, [
    "w1",
  ]);
  assert.equal(
    organizationStateChanges(
      before,
      organizationSnapshot(works, [], [], roots, {}),
    ).removed.length,
    1,
  );
});

test("explicit pending files return even if their signatures still match an approved checkpoint", () => {
  const file = {
    id: "f1",
    connectionId: "storage",
    root: "/library",
    path: "/library/Work/a.mkv",
    relativePath: "Work/a.mkv",
    name: "a.mkv",
    size: 100,
    modified: 1,
    duration: null,
    workId: "w1",
  };
  const state = organizationSnapshot(
    [{ id: "w1", title: "Work" }],
    [{ ...file, id: "raw1" }],
    [],
    [],
    {},
  );
  const checkpoint = {
    version: 1 as const,
    reviewedAt: 1,
    files: reviewedOrganizationFiles([file], state),
    pendingFileIds: [file.id],
  };
  const delta = organizationDelta([file], state, checkpoint, true);
  assert.equal(delta.delta.added.length, 0);
  assert.equal(delta.delta.modified.length, 0);
  assert.deepEqual(delta.files, [file]);
});
