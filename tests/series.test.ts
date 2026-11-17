import test from "node:test";
import assert from "node:assert/strict";
import { LibraryStore } from "../src/library/store";
import { collectionSchema, seriesSchema } from "../src/shared/validation";
import {
  libraryEntries,
  collectionWorkIds,
  entryProgress,
} from "../src/shared/series";
import { OrganizationInput } from "../src/library/organization-input";
import { decodeColumnarOrganization } from "../src/library/organization-columnar";
import { organizationMembers } from "../src/shared/organization";
import type { OrganizationPlan } from "../src/shared/organization";
function fixture() {
  const store = new LibraryStore(":memory:");
  store.saveConnection({
    id: "local",
    type: "local",
    name: "Local",
    roots: ["/media"],
    status: "connected",
    error: null,
    scannedAt: null,
  });
  store.applyScan("local", "/media", {
    groups: ["One", "Two", "Other"].map((name) => ({
      path: "/media/" + name,
      name,
      files: [
        {
          path: `/media/${name}/1.mkv`,
          name: "1.mkv",
          directory: false,
          size: 100,
          modified: 1,
        },
      ],
    })),
    completeDirectories: ["/media", "/media/One", "/media/Two", "/media/Other"],
    failures: [],
  });
  return store;
}
test("series CRUD preserves independent works, order, progress and legacy collections", () => {
  const s = fixture();
  try {
    const before = s.snapshot(),
      ids = before.works.map((w) => w.id);
    const c = s.saveCollection({ name: "Existing", workIds: ids });
    assert.deepEqual(s.snapshot().series, []);
    const series = s.saveSeries({ name: "Related", workIds: ids.slice(0, 2) });
    assert.deepEqual(s.snapshot().works, before.works);
    assert.equal(libraryEntries(s.snapshot()).length, 2);
    assert.deepEqual(
      libraryEntries(s.snapshot(), c)
        .map((w) => w.id)
        .sort(),
      [series.id, ids[2]].sort(),
    );
    assert.equal(
      entryProgress(
        libraryEntries(s.snapshot()).find((w) => w.id === series.id)!,
        s.snapshot(),
      ),
      0,
    );
    const fingerprint = s.organizationFingerprint();
    s.saveSeries({ ...series, workIds: [ids[1], ids[0]] });
    assert.notEqual(s.organizationFingerprint(), fingerprint);
    assert.deepEqual(s.snapshot().series?.[0].workIds, [ids[1], ids[0]]);
    assert.throws(
      () => s.saveSeries({ name: "Overlap", workIds: [ids[0]] }),
      /invalidInput/,
    );
    assert.throws(
      () => s.saveSeries({ name: "Nested", workIds: [series.id] }),
      /invalidInput/,
    );
    assert.throws(
      () => s.saveCollection({ name: "Nested", workIds: [c.id] }),
      /invalidInput/,
    );
    const container = s.saveCollection({
      name: "Collection",
      workIds: [ids[2]],
      seriesIds: [series.id],
    });
    assert.equal(collectionWorkIds(container, s.snapshot()).length, 3);
    s.removeSeries(series.id);
    assert.deepEqual(s.snapshot().works, before.works);
    assert.deepEqual(s.snapshot().series, []);
    assert.deepEqual(
      new Set(
        s.snapshot().collections.find((x) => x.id === container.id)!.workIds,
      ),
      new Set(ids),
    );
    assert.ok(
      !seriesSchema.safeParse({ name: "x", workIds: ids, seriesIds: [] })
        .success,
    );
    assert.ok(collectionSchema.safeParse(container).success);
  } finally {
    s.close();
  }
});
test("AI relationship kinds survive compact decoding and reject overlapping series", () => {
  const files = [1, 2, 3].map((n) => ({
    id: `f${n}`,
    connectionId: "local",
    root: "/media",
    path: `/media/${n}.mkv`,
    relativePath: `${n}.mkv`,
    name: `${n}.mkv`,
    size: 100,
    modified: 1,
    duration: null,
  }));
  const input = new OrganizationInput(
    files,
    [],
    { works: [], collections: [] },
    [{ connectionId: "local", path: "/media", depth: 1 }],
  );
  const wire = {
    g: files.map((f, i) => ({
      i: `w${i}`,
      t: `Work ${i}`,
      f: [f.id],
      r: [],
      e: { n: [], t: [], v: [] },
      q: false,
      m: "",
    })),
    u: [],
    c: [
      { k: "series", n: "Related", g: ["w1", "w0"] },
      { k: "collection", n: "Broad", g: ["w0", "w1", "w2"] },
    ],
  };
  const decoded = input.decode(
    decodeColumnarOrganization(JSON.stringify(wire)),
  );
  assert.equal(decoded.collections[0].kind, "series");
  assert.deepEqual(decoded.collections[0].groupIds, ["w1", "w0"]);
  wire.c.push({ k: "series", n: "Conflict", g: ["w1", "w2"] });
  assert.throws(() =>
    input.decode(decodeColumnarOrganization(JSON.stringify(wire))),
  );
});
test("AI applies series and a containing collection atomically without merging episodes", () => {
  const s = fixture();
  try {
    const before = s.snapshot();
    const files = before.works.flatMap((w) =>
      w.episodes.map((e) => ({
        id: e.id,
        episodeId: e.id,
        workId: w.id,
        connectionId: e.connectionId,
        root: w.root,
        path: e.path,
        relativePath: e.fileName,
        name: e.fileName,
        size: e.size,
        modified: e.modified,
        duration: e.duration,
      })),
    );
    const groups = before.works.map((w, i) => ({
      id: `g${i}`,
      title: w.title,
      fileIds: files.filter((f) => f.workId === w.id).map((f) => f.id),
      existingWorkId: w.id,
      review: false,
      reason: "",
    }));
    const plan: OrganizationPlan = {
      jobId: "fixture",
      files,
      groups,
      collections: [
        { id: "s1", kind: "series", name: "Related", groupIds: ["g1", "g0"] },
        {
          id: "c1",
          kind: "collection",
          name: "Broad",
          groupIds: ["g0", "g1", "g2"],
        },
      ],
      unassigned: [],
      excludedCount: 0,
    };
    s.applyOrganization(
      plan,
      {
        jobId: "fixture",
        groups: groups.map((g) => ({ id: g.id, title: g.title })),
        collectionIds: ["s1", "c1"],
      },
      s.organizationFingerprint(),
    );
    const after = s.snapshot();
    assert.equal(after.series?.length, 1);
    assert.deepEqual(after.series![0].workIds, [
      before.works[1].id,
      before.works[0].id,
    ]);
    assert.deepEqual(
      after.works.map((w) => w.episodes),
      before.works.map((w) => w.episodes),
    );
    assert.deepEqual(after.collections[0].seriesIds, [after.series![0].id]);
    assert.deepEqual(after.collections[0].workIds, [before.works[2].id]);
    assert.equal(libraryEntries(after, after.collections[0]).length, 2);
    // Revising a collection must remove the old series reference, not add its
    // excluded members back through that reference after approval.
    const revised = {
      ...plan,
      collections: [
        {
          id: "c2",
          kind: "collection" as const,
          name: "Broad",
          existingCollectionId: after.collections[0].id,
          groupIds: ["g1", "g2"],
        },
      ],
    };
    s.applyOrganization(
      revised,
      {
        jobId: "fixture",
        groups: groups.map((g) => ({ id: g.id, title: g.title })),
        collectionIds: ["c2"],
      },
      s.organizationFingerprint(),
    );
    assert.deepEqual(s.snapshot().collections[0].seriesIds, []);
    assert.deepEqual(
      new Set(collectionWorkIds(s.snapshot().collections[0], s.snapshot())),
      new Set([before.works[1].id, before.works[2].id]),
    );
  } finally {
    s.close();
  }
});

test("series progress aggregates independent works without marking another work watched", () => {
  const s = fixture();
  try {
    const [a, b] = s.snapshot().works;
    s.setProgress(a.episodes[0].id, 100, 100, true);
    s.setProgress(b.episodes[0].id, 0, 300, false);
    const series = s.saveSeries({ name: "Sequence", workIds: [a.id, b.id] });
    const state = s.snapshot(),
      entry = libraryEntries(state).find((w) => w.id === series.id)!;
    assert.equal(entryProgress(entry, state), 0.25);
    assert.equal(
      state.works.find((w) => w.id === b.id)!.episodes[0].position,
      0,
    );
    s.removeSeries(series.id);
    assert.equal(
      s.snapshot().works.find((w) => w.id === a.id)!.episodes[0].position,
      100,
    );
  } finally {
    s.close();
  }
});

test("organization review separates series members from mixed collection membership", () => {
  const series = {
    id: "s",
    kind: "series" as const,
    name: "Sequence",
    groupIds: ["a", "b"],
  };
  const collection = {
    id: "c",
    kind: "collection" as const,
    name: "Collection",
    groupIds: ["a", "b", "c"],
  };
  const plan = { collections: [series, collection] } as OrganizationPlan;
  assert.deepEqual(organizationMembers(plan, series, ["s"]), [
    { id: "a", kind: "work", groupIds: ["a"] },
    { id: "b", kind: "work", groupIds: ["b"] },
  ]);
  assert.deepEqual(organizationMembers(plan, collection, ["s"]), [
    { id: "s", kind: "series", groupIds: ["a", "b"] },
    { id: "c", kind: "work", groupIds: ["c"] },
  ]);
  assert.deepEqual(
    organizationMembers(plan, collection, []).map((m) => m.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    organizationMembers(plan, { ...collection, groupIds: ["a", "c"] }, [
      "s",
    ]).map((m) => m.id),
    ["a", "c"],
  );
});
