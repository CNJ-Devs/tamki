import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LibraryStore } from "../src/library/store";
import { OrganizationInput } from "../src/library/organization-input";
import type { OrganizationPlan } from "../src/shared/organization";
import { progress } from "../src/shared/model";

function fixture() {
  const store = new LibraryStore(":memory:");
  store.saveConnection({
    id: "storage",
    type: "local",
    name: "Local",
    roots: ["/library"],
    status: "connected",
    error: null,
    scannedAt: null,
  });
  const names = [
    "A/01.mkv",
    "B/01.mkv",
    "Backup/01.mkv",
    "A/02.mkv",
    "B/02.mkv",
  ];
  const scan = {
    groups: [
      {
        path: "/library",
        root: "/library",
        name: "Series",
        files: names.map((name) => ({
          path: `/library/${name}`,
          name: name.split("/").at(-1)!,
          size: 123,
          modified: 1,
          directory: false,
        })),
      },
    ],
    completeDirectories: [
      "/library",
      "/library/A",
      "/library/B",
      "/library/Backup",
    ],
    failures: [],
  };
  store.applyScan("storage", "/library", scan);
  const files = store.organizationCandidates("storage", scan).files;
  const input = new OrganizationInput(
    files,
    [],
    store.organizationContext(files),
    [{ connectionId: "storage", path: "/library", depth: 2 }],
  );
  const group = {
    identity: "series",
    title: "Series",
    review: false,
    reason: "",
    fileIds: ["d1"],
    episodes: [
      {
        number: "01",
        title: "Opening",
        versions: [
          { label: "Release A", releaseKey: "A", fileIds: ["f1", "f3"] },
          { label: "Release B", releaseKey: "B", fileIds: ["f2"] },
        ],
      },
      {
        number: "02",
        title: "Next",
        versions: [
          { label: "Release A", releaseKey: "A", fileIds: ["f4"] },
          { label: "Release B", releaseKey: "B", fileIds: ["f5"] },
        ],
      },
    ],
  };
  const raw = { groups: [group], collections: [], unassigned: [] };
  const plan: OrganizationPlan = {
    jobId: "job",
    files,
    ...input.stabilize(input.decode(JSON.stringify(raw))),
    excludedCount: 0,
  };
  const apply = () =>
    store.applyOrganization(
      plan,
      {
        jobId: "job",
        groups: plan.groups.map((g) => ({ id: g.id, title: g.title })),
        collectionIds: [],
      },
      store.organizationFingerprint(),
    );
  return { store, scan, files, input, raw, plan, apply };
}

test("logical episodes contain versions and copies; playback selection, progress and scans preserve every file", () => {
  const f = fixture(),
    { store } = f;
  try {
    const old = store.snapshot().works[0];
    store.setProgress(old.episodes[0].id, 20, 100, true);
    f.apply();
    let work = store.snapshot().works[0];
    assert.equal(work.id, old.id);
    assert.equal(work.episodes.length, 2);
    const first = work.episodes[0],
      second = work.episodes[1];
    assert.equal(first.versions!.length, 2);
    assert.equal(first.versions![0].files.length, 2);
    assert.equal(first.number, "01");
    assert.equal(first.title, "Opening");
    assert.equal(first.position, 20);
    assert.equal(work.resumeId, first.id);
    assert.equal(store.organizationContext(f.files).works[0].files.length, 5);
    assert.equal(
      store.organizationCandidates("storage", f.scan).files.length,
      5,
    );
    const fingerprint = store.organizationFingerprint();
    const versionA = first.versions![0],
      versionB = first.versions![1];
    store.selectVersion(first.id, versionB.id);
    assert.equal(store.episode(first.id).activeVersionId, versionB.id);
    assert.equal(
      store
        .episode(second.id)
        .versions!.find(
          (v) => v.id === store.episode(second.id).activeVersionId,
        )!.releaseKey,
      "B",
    );
    store.setProgress(
      first.id,
      35,
      120,
      true,
      versionB.id,
      versionB.files[0].id,
    );
    store.setProgress(second.id, 0, 120, false);
    assert.equal(progress(store.snapshot().works[0]), 35 / 240);
    assert.equal(
      store.organizationFingerprint(),
      fingerprint,
      "playback does not invalidate a pending organization plan",
    );
    store.selectVersion(first.id, versionA.id);
    assert.equal(
      store.episode(first.id).position,
      20,
      "different cuts retain separate positions",
    );
    store.setProgress(
      first.id,
      42,
      100,
      true,
      versionA.id,
      versionA.files[0].id,
    );
    assert(
      store
        .episode(first.id)
        .versions![0].files.every((file) => file.position === 42),
      "copies share version progress",
    );
    assert.throws(
      () => store.media(first.id, second.versions![0].id),
      /invalidInput/,
    );
    assert.throws(
      () =>
        store.setProgress(
          first.id,
          99,
          100,
          true,
          versionA.id,
          versionB.files[0].id,
        ),
      /invalidInput/,
    );
    store.applyScan("storage", "/library", f.scan);
    work = store.snapshot().works[0];
    assert.equal(work.episodes.length, 2);
    assert.equal(work.episodes[0].id, first.id);
    assert.equal(work.episodes[0].versions!.flatMap((v) => v.files).length, 3);
    f.apply();
    assert.deepEqual(
      store
        .snapshot()
        .works[0].episodes.map((e) => [e.id, e.versions!.map((v) => v.id)]),
      work.episodes.map((e) => [e.id, e.versions!.map((v) => v.id)]),
    );
    const absent = {
      ...f.scan,
      groups: f.scan.groups.map((g) => ({
        ...g,
        files: g.files.filter((e) => !e.path.includes("/A/01")),
      })),
    };
    store.applyScan("storage", "/library", absent);
    const fallback = store.media(first.id, versionA.id);
    assert.match(fallback.path, /Backup/);
    assert.equal(fallback.position, 42);
  } finally {
    store.close();
  }
});

test("editing and removing a logical episode updates all versions and exclusions survive rescan", () => {
  const f = fixture();
  try {
    f.apply();
    const work = f.store.snapshot().works[0];
    f.store.edit({
      id: work.id,
      title: work.title,
      description: "",
      tags: [],
      removedEpisodeIds: [],
      episodes: [...work.episodes].reverse().map((e) => ({
        id: e.id,
        number: e.number,
        title: "Authored",
        description: "Manual",
      })),
    });
    let next = f.store.snapshot().works[0];
    assert.equal(next.episodes[0].id, work.episodes[1].id);
    assert(next.episodes.every((e) => e.title === "Authored"));
    assert(
      f.store
        .organizationContext(f.files)
        .works[0].files.every((e) => e.manualFields.includes("title")),
    );
    f.store.edit({
      id: work.id,
      title: work.title,
      description: "",
      tags: [],
      removedEpisodeIds: [work.episodes[0].id],
      episodes: [
        {
          id: work.episodes[1].id,
          number: "02",
          title: "Authored",
          description: "Manual",
        },
      ],
    });
    f.store.applyScan("storage", "/library", f.scan);
    next = f.store.snapshot().works[0];
    assert.equal(next.episodes.length, 1);
    assert.equal(next.episodes[0].versions!.length, 2);
    assert.equal(
      f.store.organizationCandidates("storage", f.scan).excludedCount,
      3,
    );
  } finally {
    f.store.close();
  }
});

test("version output rejects cross-work, duplicate, unknown and directory references before application", () => {
  const f = fixture();
  try {
    for (const bad of ["d1", "f9", "f2"]) {
      const raw = structuredClone(f.raw);
      raw.groups[0].episodes[0].versions[0].fileIds.push(bad);
      assert.throws(
        () => f.input.decode(JSON.stringify(raw)),
        /organizationInvalid/,
      );
    }
    const raw = structuredClone(f.raw);
    raw.groups[0].fileIds = ["f1", "f2", "f3"];
    raw.unassigned = ["f4", "f5"] as never[];
    assert.throws(
      () => f.input.decode(JSON.stringify(raw)),
      /organizationInvalid/,
    );
    const before = f.store.organizationFingerprint();
    const bad = structuredClone(f.plan);
    bad.groups[0].episodes![0].versions[0].fileIds.push(f.files[3].id);
    assert.throws(
      () =>
        f.store.applyOrganization(
          bad,
          {
            jobId: "job",
            groups: bad.groups.map((g) => ({ id: g.id, title: g.title })),
            collectionIds: [],
          },
          before,
        ),
      /invalidInput/,
    );
    assert.equal(
      f.store.organizationFingerprint(),
      before,
      "bad layouts roll back work edits too",
    );
  } finally {
    f.store.close();
  }
});

test("v1 migration retains IDs, metadata, progress and one version per file across restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tamki-version-migration-")),
    file = path.join(dir, "library.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id)); PRAGMA user_version=1;",
    );
    const put = db.prepare("INSERT INTO records VALUES(?,?,?)");
    put.run(
      "work",
      "w",
      JSON.stringify({
        id: "w",
        title: "Manual",
        description: "",
        tags: [],
        connectionId: "c",
        root: "/",
        path: "/x",
        createdAt: 1,
        order: 0,
        resumeId: "e",
        excluded: false,
      }),
    );
    put.run(
      "episode",
      "e",
      JSON.stringify({
        id: "e",
        workId: "w",
        connectionId: "c",
        path: "/x/1.mkv",
        fileName: "1.mkv",
        number: "A",
        title: "Authored",
        description: "",
        size: 123,
        modified: 1,
        duration: 100,
        position: 35,
        order: 0,
        missing: false,
        excluded: false,
        manual: true,
      }),
    );
    db.close();
    const first = new LibraryStore(file),
      state = first.snapshot();
    assert.equal(state.works[0].episodes[0].id, "e");
    assert.equal(state.works[0].episodes[0].versions!.length, 1);
    assert.equal(state.works[0].episodes[0].position, 35);
    first.close();
    const next = new LibraryStore(file);
    assert.deepEqual(next.snapshot(), state);
    next.close();
    const read = new DatabaseSync(file, { readOnly: true });
    assert.equal(read.prepare("PRAGMA user_version").get()!.user_version, 2);
    read.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict provider schema requires episode mappings without default keywords; reconciliation resolves nested file refs", () => {
  const f = fixture();
  try {
    const task = f.input.task("", "en");
    assert(!JSON.stringify(task.schema).includes('"default":'));
    const item = (task.schema.properties as any).groups.items;
    const group = item.$ref
      ? (task.schema.$defs as any)[item.$ref.split("/").at(-1)]
      : item;
    assert(group.required.includes("episodes"));
    const raw = structuredClone(f.raw);
    raw.groups[0].fileIds = ["p1"];
    const decoded = f.input.decode(
      JSON.stringify(raw),
      f.files,
      new Map([["p1", f.files.map((f) => f.id)]]),
    );
    assert.equal(decoded.groups[0].episodes[0].versions[0].fileIds.length, 2);
  } finally {
    f.store.close();
  }
});
