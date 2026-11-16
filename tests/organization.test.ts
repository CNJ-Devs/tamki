import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LibraryStore } from "../src/library/store";
import { OrganizationService as ProductionOrganizationService } from "../src/library/organization";
import {
  canonicalFixtureTask,
  columnarFixtureResponse,
  originalWireTasks,
  restoreOrganizationPacket,
} from "./fixtures/organization-wire";
import {
  OrganizationInput,
  OrganizationOutputError,
} from "../src/library/organization-input";
import { RuntimeLog, setRuntimeLog } from "../src/diagnostics";
import { ProviderError } from "../src/providers/provider";
import { scanScopes } from "../src/library/scan";
import { newSource } from "../src/shared/settings";
import {
  validateOrganizationGroups,
  validateOrganizationCollections,
} from "../src/shared/organization";
import { aiStructured } from "../src/providers/ai-recognition";
import type { StructuredTask } from "../src/providers/ai-recognition";
import type { Entry } from "../src/shared/model";

// Adapt readable canonical mock decisions to the actual columnar transport.
// Actual wire tasks remain available to assertions through originalWireTasks.
class OrganizationService extends ProductionOrganizationService {
  constructor(
    ...[store, settings, provider, release]: ConstructorParameters<
      typeof ProductionOrganizationService
    >
  ) {
    super(
      store,
      {
        ...settings,
        structured: async (runtime, task, signal) => {
          const canonical = canonicalFixtureTask(task);
          const response = await settings.structured(
            runtime,
            canonical,
            signal,
          );
          return canonical === task
            ? response
            : {
                ...response,
                text: JSON.stringify(
                  columnarFixtureResponse(JSON.parse(response.text)),
                ),
              };
        },
      },
      provider,
      release,
    );
  }
}

const unchangedRevision = () => ({
  text: JSON.stringify({
    removeGroupIds: [],
    groups: [],
    replaceCollections: false,
    collections: [],
    replaceUnassigned: false,
    unassigned: [],
  }),
  citations: [],
});

const file = (p: string, directory = false): Entry => ({
  path: p,
  name: path.posix.basename(p),
  size: directory ? 0 : 100,
  modified: 1,
  directory,
});
function fixture() {
  const store = new LibraryStore(":memory:", "en");
  store.saveConnection({
    id: "storage",
    type: "local",
    name: "Storage",
    roots: ["/library"],
    scanDepths: { "/library": 2 },
    status: "connected",
    error: null,
    scannedAt: null,
  });
  const tree: Record<string, Entry[]> = {
    "/library": [file("/library/Mixed", true), file("/library/Other", true)],
    "/library/Mixed": [
      file("/library/Mixed/Example.S01E01.mkv"),
      file("/library/Mixed/Example.S01E02.mkv"),
      file("/library/Mixed/Example.S02E01.mkv"),
      file("/library/Mixed/Example.S02E02.mkv"),
    ],
    "/library/Other": [file("/library/Other/Movie.mkv")],
  };
  const calls: StructuredTask[] = [];
  const state = {
    invalid: false,
    omit: false,
    delay: null as Promise<void> | null,
  };
  const settings = {
    featureRuntime: () => ({
      ...newSource("openai"),
      model: "fixture",
      searchMode: "none" as const,
    }),
    structured: async (
      _source: unknown,
      task: StructuredTask,
      signal: AbortSignal,
    ) => {
      calls.push(originalWireTasks.get(task) || task);
      if (task.responseFormat === "text")
        return {
          text: "Group by released identity using the full inventory.",
          citations: [],
        };
      await state.delay;
      signal.throwIfAborted();
      if (task.name === "tamki_organization_review") return unchangedRevision();
      const packet = JSON.parse(task.prompt.split("\n")[1]);
      const rows = packet.files.map(([id, directory, name]: string[]) => ({
        id,
        path:
          (packet.fileNameAffixes?.[directory]?.[0] || "") +
          name +
          (packet.fileNameAffixes?.[directory]?.[1] || ""),
      }));
      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const name = row.path.includes("S01")
          ? "Example · Season 1"
          : row.path.includes("S02")
            ? "Example · Season 2"
            : "Movie";
        groups.set(name, [...(groups.get(name) || []), row.id]);
      }
      return {
        text: JSON.stringify({
          ...(task.name === "tamki_organization_revision"
            ? {
                removeGroupIds: [],
                replaceCollections: true,
                replaceUnassigned: true,
              }
            : {}),
          groups: [...groups].map(([name, fileIds]) => ({
            identity: name,
            title: name,
            fileIds: state.invalid
              ? ["foreign-id"]
              : state.omit
                ? fileIds.slice(1)
                : fileIds,
            review: false,
            reason: "",
          })),
          unassigned: [],
          collections:
            [...groups.keys()].filter((name) => name.startsWith("Example"))
              .length === 2
              ? [
                  {
                    name: "Example series",
                    groupIds: [...groups.keys()].filter((name) =>
                      name.startsWith("Example"),
                    ),
                  },
                ]
              : [],
        }),
        citations: [],
      };
    },
  };
  const provider = {
    list: async (p: string) => {
      if (!tree[p]) throw new Error("offline");
      return tree[p];
    },
  };
  const organizer = new OrganizationService(
    store,
    settings,
    async () => provider,
  );
  const request = {
    jobId: "job",
    connectionId: "ai",
    model: "fixture",
    roots: [{ connectionId: "storage", path: "/library" }],
    webSearch: false,
    instructions: "",
  };
  return {
    store,
    tree,
    calls,
    state,
    provider,
    settings,
    organizer,
    request,
    close: () => {
      organizer.close();
      store.close();
    },
  };
}

test("organization splits mixed folders into works and collections, preserves playback, and survives rescan", async () => {
  const f = fixture();
  try {
    const scan = await scanScopes(f.provider, [{ root: "/library", depth: 2 }]);
    f.store.applyScan("storage", "/library", scan);
    const mixed = f.store.snapshot().works.find((w) => w.title === "Mixed")!;
    f.store.saveCollection({ name: "Existing", workIds: [mixed.id] });
    f.store.setProgress(mixed.episodes[2].id, 40, 100, true);
    const before = f.store.snapshot();
    const plan = await f.organizer.run(f.request);
    assert.deepEqual(
      JSON.parse(f.store.config("organization-last-review")!).plan,
      plan,
    );
    assert.equal(plan.groups.length, 3);
    assert.equal(plan.collections.length, 1);
    assert.deepEqual(f.store.snapshot().works, before.works); // Preview is read-only.
    f.store.setProgress(mixed.episodes[2].id, 55, 100, true); // Playback does not stale the plan.
    f.organizer.apply({
      jobId: "job",
      groups: plan.groups.map(({ id, title }) => ({ id, title })),
      collectionIds: plan.collections.map((c) => c.id),
    });
    const after = f.store.snapshot();
    assert.deepEqual(after.works.map((w) => w.title).sort(), [
      "Example · Season 1",
      "Example · Season 2",
      "Movie",
    ]);
    assert.equal(
      after.works.find((w) => w.title.endsWith("2"))!.episodes[0].position,
      55,
    );
    assert.equal(
      after.works.find((w) => w.title.endsWith("2"))!.resumeId,
      mixed.episodes[2].id,
    );
    assert.equal(
      after.collections.find((c) => c.name === "Example series")!.workIds
        .length,
      2,
    );
    assert.equal(
      after.collections.find((c) => c.name === "Example series")!.workIds
        .length,
      2,
    );
    f.store.applyScan("storage", "/library", scan);
    assert.deepEqual(
      f.store
        .snapshot()
        .works.map((w) => [w.id, w.title, w.episodes.map((e) => e.id)]),
      after.works.map((w) => [w.id, w.title, w.episodes.map((e) => e.id)]),
    );
    const videos = after.works.flatMap((w) => w.episodes);
    assert.equal(new Set(videos.map((e) => e.path)).size, 5);
    const collection = after.collections.find(
      (c) => c.name === "Example series",
    )!;
    f.store.removeCollection(collection.id);
    assert.equal(f.store.snapshot().works.length, 3);
    assert.equal(f.store.snapshot().collections.length, 0);
  } finally {
    f.close();
  }
});

test("organization imports unindexed files and keeps manual attachments stable on subsequent scans", async () => {
  const f = fixture();
  try {
    const plan = await f.organizer.run(f.request);
    assert.equal(f.store.snapshot().works.length, 0);
    f.organizer.apply({
      jobId: "job",
      groups: plan.groups.map(({ id, title }) => ({ id, title })),
      collectionIds: [],
    });
    const movie = f.store.snapshot().works.find((w) => w.title === "Movie")!;
    const extraFile = file("/library/Other/Extra.mkv");
    const additions = f.store.prepareEpisodes(movie.id, "storage", [extraFile]);
    f.store.edit(
      {
        ...movie,
        removedEpisodeIds: [],
        episodes: [...movie.episodes, ...additions],
      },
      additions,
    );
    f.store.setProgress(additions[0].id, 31, 90, true);
    f.tree["/library/Other"].push(extraFile);
    const second = await f.organizer.run({ ...f.request, jobId: "second" });
    f.organizer.apply({
      jobId: "second",
      groups: second.groups.map(({ id, title }) => ({ id, title })),
      collectionIds: [],
    });
    const organized = f.store.snapshot();
    const nextMovie = organized.works.find((w) => w.id === movie.id)!;
    assert.equal(nextMovie.episodes.length, 2);
    assert.equal(
      nextMovie.episodes.find((e) => e.id === additions[0].id)!.position,
      31,
    );
    f.store.applyScan(
      "storage",
      "/library",
      await scanScopes(f.provider, [{ root: "/library", depth: 2 }]),
    );
    assert.deepEqual(f.store.snapshot().works, organized.works);
    assert.equal(f.store.snapshot().works.flatMap((w) => w.episodes).length, 6);

    // Changed files need duration reprobed; unchanged playback metadata is retained.
    f.tree["/library/Other"][1] = { ...extraFile, modified: 2 };
    const changed = await f.organizer.run({ ...f.request, jobId: "changed" });
    assert.equal(
      changed.files.find((item) => item.path === extraFile.path)!.duration,
      null,
    );
    f.organizer.apply({
      jobId: "changed",
      groups: changed.groups.map(({ id, title }) => ({ id, title })),
      collectionIds: [],
    });
    const changedEpisode = f.store.episode(additions[0].id);
    assert.equal(changedEpisode.duration, null);
    assert.equal(changedEpisode.position, 31);
  } finally {
    f.close();
  }
});

test("partial apply preserves unselected files and collections, and removed works stay ignored", async () => {
  const f = fixture();
  try {
    const scan = await scanScopes(f.provider, [{ root: "/library", depth: 2 }]);
    f.store.applyScan("storage", "/library", scan);
    const movie = f.store.snapshot().works.find((w) => w.title === "Other")!;
    f.store.removeWork(movie.id);
    const plan = await f.organizer.run(f.request);
    assert.equal(plan.files.length, 4);
    assert.equal(plan.excludedCount, 1);
    const group = plan.groups[0];
    f.organizer.apply({
      jobId: "job",
      groups: [{ id: group.id, title: "Reviewed title" }],
      collectionIds: plan.collections.map((c) => c.id),
    });
    const result = f.store.snapshot();
    assert.equal(result.works.length, 2);
    assert.equal(result.works.flatMap((w) => w.episodes).length, 4);
    assert.equal(result.collections.length, 0);
    assert(result.works.some((w) => w.title === "Mixed"));
    f.store.applyScan("storage", "/library", scan);
    assert(!f.store.snapshot().works.some((w) => w.id === movie.id));
  } finally {
    f.close();
  }
});

test("organization rejects unknown IDs, omissions, nested collections, stale edits and invented selections", async () => {
  const f = fixture();
  try {
    f.state.invalid = true;
    await assert.rejects(f.organizer.run(f.request), /organizationInvalid/);
    assert.equal(f.store.snapshot().works.length, 0);
    f.state.invalid = false;
    f.state.omit = true;
    await assert.rejects(f.organizer.run(f.request), /organizationInvalid/);
    f.state.omit = false;
    const plan = await f.organizer.run(f.request);
    assert.throws(
      () =>
        f.organizer.apply({
          jobId: "job",
          groups: [{ id: "invented", title: "Unsafe" }],
          collectionIds: [],
        }),
      /invalidInput/,
    );
    f.store.saveCollection({ name: "Concurrent collection", workIds: [] });
    assert.throws(
      () =>
        f.organizer.apply({
          jobId: "job",
          groups: plan.groups.map(({ id, title }) => ({ id, title })),
          collectionIds: [],
        }),
      /organizationStale/,
    );
    assert.throws(
      () =>
        validateOrganizationCollections(
          {
            collections: [
              { name: "Nested", groupIds: ["collection-x", "collection-y"] },
            ],
          },
          plan.groups,
        ),
      /organizationInvalid/,
    );
    assert.throws(
      () =>
        validateOrganizationGroups({ groups: [], unassigned: [] }, plan.files),
      /organizationInvalid/,
    );
  } finally {
    f.close();
  }
});

test("organization respects registered roots and scan depth, fails on partial listings, and cancels without writing", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.organizer.run({
        ...f.request,
        roots: [{ connectionId: "storage", path: "/outside" }],
      }),
      /outsideRoot/,
    );
    f.tree["/library"].push(file("/library/Offline", true));
    await assert.rejects(f.organizer.run(f.request), /organizationIncomplete/);
    assert.equal(f.calls.length, 0);
    f.tree["/library"].pop();
    let release = () => {};
    f.state.delay = new Promise<void>((r) => {
      release = r;
    });
    const pending = f.organizer.run(f.request),
      rejected = assert.rejects(pending, /recognitionCancelled/);
    while (!f.calls.length) await new Promise((r) => setTimeout(r, 1));
    f.organizer.cancel("job");
    release();
    await rejected;
    assert.equal(f.store.snapshot().works.length, 0);
    await assert.rejects(
      scanScopes(f.provider, [{ root: "/library", depth: 2 }], undefined, {
        files: 2,
        directories: 20,
      }),
      /organizationTooLarge/,
    );
  } finally {
    f.close();
  }
});

test("structured provider requests use the organization schema without the metadata contract", async () => {
  for (const provider of [
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
  ] as const) {
    const source = {
      ...newSource(provider),
      model: "fixture",
      searchMode: "none" as const,
    };
    const task: StructuredTask = {
      name: "tamki_organization",
      system: "Only group files.",
      prompt: "Directory data.",
      schema: {
        type: "object",
        properties: { groups: { type: "array", items: { type: "string" } } },
        required: ["groups"],
        additionalProperties: false,
      },
      queries: [],
    };
    const request = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert(!JSON.stringify(body).includes("tamki_metadata"));
      assert(JSON.stringify(body).includes("Only group files."));
      if (provider === "openai") {
        assert.equal(body.text.format.name, "tamki_organization");
        return Response.json({
          status: "completed",
          output: [
            { content: [{ type: "output_text", text: '{"groups":[]}' }] },
          ],
        });
      }
      if (provider === "anthropic")
        return Response.json({
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"groups":[]}' }],
        });
      if (provider === "gemini")
        return Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: '{"groups":[]}' }] },
            },
          ],
        });
      return Response.json({
        choices: [
          { finish_reason: "stop", message: { content: '{"groups":[]}' } },
        ],
      });
    }) as typeof fetch;
    const result = await aiStructured(
      source,
      "fixture-key",
      "",
      task,
      new AbortController().signal,
      request,
    );
    assert.deepEqual(JSON.parse(result.text), { groups: [] });
  }
});

test("1,851 videos and current relationships are organized by one complete structured request", async () => {
  const f = fixture();
  try {
    f.tree["/library/Mixed"] = Array.from({ length: 1850 }, (_, i) =>
      file(
        `/library/Mixed/Example.S${i < 925 ? "01" : "02"}E${(i % 925) + 1}.mkv`,
      ),
    );
    f.store.applyScan(
      "storage",
      "/library",
      await scanScopes(f.provider, [{ root: "/library", depth: 2 }]),
    );
    const works = f.store.snapshot().works;
    f.store.saveCollection({
      name: "User collection",
      workIds: works.map((w) => w.id),
    });
    const plan = await f.organizer.run(f.request);
    assert.equal(f.calls.length, 1);
    assert.equal(plan.files.length, 1851);
    const wirePacket = JSON.parse(f.calls[0].prompt.split("\n")[1]);
    assert.deepEqual(wirePacket.compactInput, {
      version: 1,
      extends: "evidence-locality-v1",
    });
    assert.equal(f.calls[0].reasoningEffort, "medium");
    assert(Array.isArray(wirePacket.files.fRuns));
    const packet = restoreOrganizationPacket(wirePacket);
    assert.equal(packet.counts.files, 1851);
    assert.equal(packet.counts.works, 2);
    assert.equal(packet.counts.collections, 1);
    assert.equal(packet.current.collections[0].name, "User collection");
    assert(!Object.hasOwn(packet, "allocationUnits"));
    assert(!f.calls[0].system.includes("Initial assignment contract"));
    assert.equal(f.calls[0].responseFormat, undefined);
    assert(Object.hasOwn(f.calls[0].schema.properties!, "g"));
    assert(!Object.hasOwn(f.calls[0].schema.properties!, "groups"));
    assert(!Object.hasOwn(f.calls[0].schema.properties!, "allocations"));
    assert.equal(packet.directories.length, 3);
    assert(packet.files.every((row: unknown[]) => row.length === 6));
    assert.deepEqual(packet.files[0].slice(3), [100, 1, null]);
    assert(!f.calls[0].prompt.includes("/library/"));
    assert.equal(f.calls[0].searchPolicy, "optional");
  } finally {
    f.close();
  }
});

test("same membership retains proposed names/order, flags manual changes, and preserves IDs/playback after approval", async () => {
  const f = fixture();
  let organizer: OrganizationService | undefined;
  try {
    f.store.applyScan(
      "storage",
      "/library",
      await scanScopes(f.provider, [{ root: "/library", depth: 2 }]),
    );
    const work = f.store.snapshot().works.find((w) => w.title === "Mixed")!;
    f.store.edit({
      ...work,
      title: "My title",
      description: "My synopsis",
      tags: ["Personal"],
      removedEpisodeIds: [],
      episodes: [...work.episodes].reverse().map((e, i) => ({
        ...e,
        number: `Day ${i}`,
        title: `My episode ${i}`,
        description: "Episode notes",
      })),
    });
    f.store.setProgress(work.episodes[0].id, 41, 120, true);
    f.store.saveCollection({
      name: "My collection",
      workIds: f.store.snapshot().works.map((w) => w.id),
    });
    const before = f.store.snapshot();
    const fingerprint = f.store.organizationFingerprint();
    organizer = new OrganizationService(
      f.store,
      {
        ...f.settings,
        structured: async (_runtime, task) => {
          if (task.responseFormat === "text")
            return {
              text: "Group by released identity using the full inventory.",
              citations: [],
            };
          if (task.name === "tamki_organization_review")
            return unchangedRevision();
          const packet = JSON.parse(task.prompt.split("\n")[1]);
          const current = packet.current.works.find(
            (w: any) => w.title === "My title",
          );
          assert.deepEqual(current.manualFields.sort(), [
            "description",
            "files",
            "tags",
            "title",
          ]);
          assert(
            current.files.every(
              (e: any) =>
                e.description === "Episode notes" &&
                e.manualFields.includes("number"),
            ),
          );
          assert.equal(current.description, "My synopsis");
          return {
            text: JSON.stringify({
              groups: packet.current.works.map((w: any, i: number) => ({
                identity: `g${i}`,
                title: w.title + " (normalized)",
                fileIds: w.files.map((e: any) => e.id).reverse(),
                review: false,
                reason: "",
              })),
              collections: [
                {
                  name: "My collection normalized",
                  groupIds: packet.current.works.map(
                    (_: any, i: number) => `g${i}`,
                  ),
                },
              ],
              unassigned: [],
            }),
            citations: [],
          };
        },
      },
      async () => f.provider,
    );
    const plan = await organizer.run(f.request);
    assert.equal(plan.collections[0].name, "My collection normalized");
    const proposed = plan.groups.find(
      (g) => g.title === "My title (normalized)",
    )!;
    assert(proposed);
    assert.equal(proposed.review, true);
    assert.deepEqual(proposed.changes, {
      previousTitles: ["My title"],
      title: true,
      membership: false,
      order: true,
      manual: true,
    });
    assert.deepEqual(f.store.snapshot(), before); // Preview is read-only.
    organizer.apply({
      jobId: "job",
      groups: plan.groups.map(({ id, title }) => ({ id, title })),
      collectionIds: plan.collections.map((c) => c.id),
    });
    const after = f.store.snapshot();
    const updated = after.works.find((w) => w.id === work.id)!;
    const original = before.works.find((w) => w.id === work.id)!;
    assert.equal(updated.title, "My title (normalized)");
    assert.deepEqual(
      updated.episodes.map((e) => e.id),
      original.episodes.map((e) => e.id).reverse(),
    );
    assert.deepEqual(
      updated.episodes.map(({ order, ...e }) => e),
      original.episodes
        .slice()
        .reverse()
        .map(({ order, ...e }) => e),
    );
    assert.equal(updated.description, original.description);
    assert.deepEqual(updated.tags, original.tags);
    assert.equal(updated.resumeId, original.resumeId);
    assert.equal(after.collections[0].id, before.collections[0].id);
    assert.equal(after.collections[0].name, "My collection normalized");
    assert.notEqual(f.store.organizationFingerprint(), fingerprint);
    const context = f.store
      .organizationContext(plan.files)
      .works.find((w) => w.id === work.id)!;
    assert(!context.manualFields.includes("title")); // Accepted AI edit, not a newly typed title.
    assert(context.manualFields.includes("description"));
    assert(context.files.every((e) => e.manualFields.includes("number")));
  } finally {
    organizer?.close();
    f.close();
  }
});

test("automatic title corrections survive same-membership stabilization without becoming manual edits", async () => {
  const f = fixture();
  try {
    f.store.applyScan(
      "storage",
      "/library",
      await scanScopes(f.provider, [{ root: "/library", depth: 2 }]),
    );
    const scan = await scanScopes(f.provider, [{ root: "/library", depth: 2 }]);
    const files = f.store.organizationCandidates("storage", scan).files;
    const data = new OrganizationInput(
      files,
      [],
      f.store.organizationContext(files),
      [{ connectionId: "storage", path: "/library", depth: 2 }],
    );
    const packet = data.packet();
    const result = data.decode(
      JSON.stringify({
        groups: packet.current.works.map((w) => ({
          identity: w.id,
          title: "Content identified: " + w.title,
          fileIds: [w.id],
          review: false,
          reason: "Ancestor and filenames identify content.",
        })),
        collections: [],
        unassigned: [],
      }),
    );
    const stabilized = data.stabilize(result);
    assert(
      stabilized.groups.every((g) => g.title.startsWith("Content identified:")),
    );
    assert(
      stabilized.groups.every(
        (g) => !g.review && !g.changes!.manual && !g.changes!.membership,
      ),
    );
    const plan = { ...stabilized, jobId: "test", files, excludedCount: 0 };
    const ids = f.store
      .snapshot()
      .works.map((w) => w.id)
      .sort();
    f.store.applyOrganization(
      plan,
      {
        jobId: "test",
        groups: plan.groups.map(({ id, title }) => ({ id, title })),
        collectionIds: [],
      },
      f.store.organizationFingerprint(),
    );
    assert.deepEqual(
      f.store
        .snapshot()
        .works.map((w) => w.id)
        .sort(),
      ids,
    );
    assert(
      f.store
        .organizationContext(files)
        .works.every((w) => !w.manualFields.includes("title")),
    );
  } finally {
    f.close();
  }
});

test("approving a regrouping protects it on rescan without claiming manual field authorship", async () => {
  const f = fixture();
  try {
    const plan = await f.organizer.run(f.request);
    f.organizer.apply({
      jobId: "job",
      groups: plan.groups.map(({ id, title }) => ({ id, title })),
      collectionIds: [],
    });
    const context = f.store.organizationContext(
      f.store.organizationCandidates(
        "storage",
        await scanScopes(f.provider, [{ root: "/library", depth: 2 }]),
      ).files,
    );
    assert(context.works.every((w) => !w.manualFields.length));
    assert(
      context.works.every((w) =>
        w.files.every((e) => e.assignmentOrigin === "organization"),
      ),
    );
    const w = f.store.snapshot().works[0];
    f.store.edit({ ...w, title: "Manually typed", removedEpisodeIds: [] });
    const next = f.store
      .organizationContext([])
      .works.find((item) => item.id === w.id)!;
    assert(next.manualFields.includes("title"));
  } finally {
    f.close();
  }
});

test("organization sends its complete contract with medium ChatGPT reasoning and decodes the streamed result", async () => {
  const f = fixture();
  try {
    const scan = await scanScopes(f.provider, [{ root: "/library", depth: 2 }]);
    const files = f.store.organizationCandidates("storage", scan).files;
    const data = new OrganizationInput(
      files,
      [],
      f.store.organizationContext(files),
      [{ connectionId: "storage", path: "/library", depth: 2 }],
    );
    const task = data.task("Keep suitable existing decisions.", "zh");
    assert.match(task.system, /Use Simplified Chinese for proposed names/);
    assert.match(data.task("", "en").system, /Use English for proposed names/);
    const output = {
      groups: data.rows.map(([id], index) => ({
        identity: `group-${index}`,
        title: `Work ${index}`,
        fileIds: [id],
        review: false,
        reason: "",
      })),
      unassigned: [],
      collections: [
        { name: "Related works", groupIds: ["group-0", "group-1"] },
      ],
    };
    const request: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.instructions, task.system);
      assert.equal(body.input[0].content, task.prompt);
      assert.deepEqual(body.reasoning, { effort: "medium" });
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.conversation, undefined);
      const embeddedSchema = JSON.parse(
        body.input[0].content.split("\nOUTPUT CONTRACT:\n")[1],
      );
      assert.deepEqual(embeddedSchema, task.schema);
      delete embeddedSchema.$schema;
      assert.deepEqual(body.text.format, {
        type: "json_schema",
        name: "tamki_organization",
        strict: true,
        schema: embeddedSchema,
      });
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify(output) },
                ],
              },
            ],
          },
        })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    const response = await aiStructured(
      { ...newSource("openai-oauth"), model: "fixture" },
      "managed",
      "",
      task,
      new AbortController().signal,
      request,
    );
    const decoded = data.decode(response.text);
    assert.deepEqual(
      decoded.groups.flatMap((g) => g.fileIds),
      files.map((file) => file.id),
    );
    assert.deepEqual(decoded.collections, output.collections);
    assert.deepEqual(decoded.unassigned, []);
    assert.throws(
      () => data.decode(JSON.stringify({ ...output, collections: null })),
      /organizationInvalid/,
    );
  } finally {
    f.close();
  }
});

test("compact selectors reject overlaps/omissions and can group files across directory boundaries", async () => {
  const f = fixture();
  try {
    const scan = await scanScopes(f.provider, [{ root: "/library", depth: 2 }]);
    const files = f.store.organizationCandidates("storage", scan).files;
    const data = new OrganizationInput(
      files,
      [],
      f.store.organizationContext(files),
      [{ connectionId: "storage", path: "/library", depth: 2 }],
    );
    const make = (fileIds: string[]) =>
      JSON.stringify({
        groups: [
          {
            identity: "g1",
            title: "Together",
            fileIds,
            review: false,
            reason: "",
          },
        ],
        collections: [],
        unassigned: [],
      });
    const root = data.directories.find(([, parent]) => parent === null)![0];
    assert.equal(data.decode(make([root])).groups[0].fileIds.length, 5);
    assert.throws(() => data.decode(make([root, "f1"])), /organizationInvalid/);
    assert.throws(() => data.decode(make(["f1"])), /organizationInvalid/);
    assert.throws(() => data.decode(make(["d999"])), /organizationInvalid/);
  } finally {
    f.close();
  }
});

test("organization validation distinguishes malformed output, references, coverage and collection constraints", async () => {
  const f = fixture();
  try {
    const scan = await scanScopes(f.provider, [{ root: "/library", depth: 2 }]);
    const files = f.store.organizationCandidates("storage", scan).files;
    const data = new OrganizationInput(
      files,
      [],
      f.store.organizationContext(files),
      [{ connectionId: "storage", path: "/library", depth: 2 }],
    );
    data.references.set("empty", []);
    const valid = {
      groups: [
        {
          identity: "g1",
          title: "PRIVATE_TITLE",
          fileIds: ["f1", "f2"],
          review: false,
          reason: "PRIVATE_REASON",
        },
        {
          identity: "g2",
          title: "Another",
          fileIds: ["f3", "f4", "f5"],
          review: false,
          reason: "",
        },
      ],
      collections: [{ name: "PRIVATE_COLLECTION", groupIds: ["g1", "g2"] }],
      unassigned: [] as string[],
    };
    type Proposal = typeof valid;
    const cases: [
      OrganizationOutputError["reason"],
      string,
      (v: Proposal) => void,
    ][] = [
      [
        "schema",
        "groups.0.fileIds",
        (v) => {
          v.groups[0].fileIds = [];
        },
      ],
      [
        "unknownReference",
        "groups.0.fileIds.0",
        (v) => {
          v.groups[0].fileIds[0] = "PRIVATE_UNKNOWN";
        },
      ],
      [
        "emptyReference",
        "groups.0.fileIds.0",
        (v) => {
          v.groups[0].fileIds[0] = "empty";
        },
      ],
      [
        "coverage",
        "groups",
        (v) => {
          v.unassigned.push("f1");
        },
      ],
      [
        "coverage",
        "groups",
        (v) => {
          v.groups[0].fileIds.pop();
        },
      ],
      [
        "duplicateGroupIdentity",
        "groups",
        (v) => {
          v.groups[1].identity = "g1";
        },
      ],
      [
        "duplicateCollectionName",
        "collections.1.name",
        (v) => {
          v.collections.push(structuredClone(v.collections[0]));
        },
      ],
      [
        "duplicateCollectionMember",
        "collections.0.groupIds",
        (v) => {
          v.collections[0].groupIds.push("g1");
        },
      ],
      [
        "unknownCollectionGroup",
        "collections.0.groupIds.1",
        (v) => {
          v.collections[0].groupIds[1] = "PRIVATE_UNKNOWN";
        },
      ],
    ];
    assert.equal(data.decode(JSON.stringify(valid)).groups.length, 2);
    for (const [reason, field, mutate] of cases) {
      const value = structuredClone(valid);
      mutate(value);
      assert.throws(
        () => data.decode(JSON.stringify(value)),
        (error: unknown) => {
          assert(error instanceof OrganizationOutputError);
          assert.equal(error.code, "organizationInvalid");
          assert.equal(error.reason, reason);
          assert.equal(error.field, field);
          assert(!JSON.stringify(error.diagnostics()).includes("PRIVATE"));
          return true;
        },
      );
    }
    assert.throws(
      () => data.decode('{"PRIVATE_BROKEN":'),
      (error: unknown) =>
        error instanceof OrganizationOutputError && error.reason === "json",
    );
  } finally {
    f.close();
  }
});

test("both organization attempts log safe validation details and the rejected plan remains unapplied", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tamki-organization-log-"));
  const f = fixture();
  let calls = 0;
  const organizer = new OrganizationService(
    f.store,
    {
      ...f.settings,
      structured: async (runtime, task, signal) => {
        if (task.responseFormat === "text")
          return {
            text: "Group by released identity using the full inventory.",
            citations: [],
          };
        if (++calls === 1)
          return {
            text: JSON.stringify({
              groups: [],
              collections: [],
              unassigned: [],
            }),
            citations: [],
          };
        if (task.name === "tamki_organization_review")
          return {
            text: JSON.stringify({
              removeGroupIds: ["unknown"],
              groups: [],
              replaceCollections: false,
              collections: [],
              replaceUnassigned: false,
              unassigned: [],
            }),
            citations: [],
          };
        const response = await f.settings.structured(runtime, task, signal);
        const broken = JSON.parse(response.text);
        broken.groups[0].fileIds[0] = "PRIVATE_RESPONSE_SECRET";
        response.text = JSON.stringify(broken);
        return response;
      },
    },
    async () => f.provider,
  );
  setRuntimeLog(new RuntimeLog(directory));
  try {
    await assert.rejects(organizer.run(f.request), /organizationInvalid/);
    const text = readFileSync(path.join(directory, "runtime.log"), "utf8");
    const entries = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failures = entries.filter(
      (e) => e.event === "organization.validation.failed",
    );
    assert.equal(failures.length, 2);
    assert.equal(failures[0].phase, "initial");
    assert.equal(failures[0].reason, "coverage");
    assert.equal(failures[0].missingFiles, 5);
    assert.equal(failures[0].duplicateFiles, 0);
    assert.equal(failures[1].phase, "correction");
    assert.equal(failures[1].reason, "unknownReference");
    assert.equal(failures[1].field, "groups.0.fileIds.0");
    assert.equal(failures[1].traceId, failures[0].traceId);
    assert(!text.includes("PRIVATE_RESPONSE_SECRET"));
    assert(!text.includes("Movie.mkv"));
    assert(!text.includes("/library"));
    assert.equal(calls, 2);
    assert.equal(f.store.snapshot().works.length, 0);
    assert.throws(() =>
      organizer.apply({
        jobId: "job",
        groups: [{ id: "g1", title: "Fake" }],
        collectionIds: [],
      }),
    );
  } finally {
    setRuntimeLog(undefined);
    organizer.close();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only a real capacity error splits complete subtrees, retaining global context and reconciling all proposals", async () => {
  const f = fixture();
  let organizer: OrganizationService | undefined;
  try {
    f.store.applyScan(
      "storage",
      "/library",
      await scanScopes(f.provider, [{ root: "/library", depth: 2 }]),
    );
    f.store.saveCollection({
      name: "Current",
      workIds: f.store.snapshot().works.map((w) => w.id),
    });
    const requests: StructuredTask[] = [];
    organizer = new OrganizationService(
      f.store,
      {
        ...f.settings,
        structured: async (_runtime, task, signal) => {
          if (task.responseFormat === "text")
            return {
              text: "Group by released identity using the full inventory.",
              citations: [],
            };
          signal.throwIfAborted();
          requests.push(task);
          if (requests.length === 1)
            throw new ProviderError("recognitionContextLimit");
          if (task.name === "tamki_organization_review")
            return unchangedRevision();
          const packet = JSON.parse(task.prompt.split("\n")[1]);
          assert.equal(packet.counts.files, 5);
          assert.equal(packet.current.collections[0].name, "Current");
          assert.equal(packet.directories.length, 3);
          if (!task.prompt.includes("\nPROPOSALS:\n")) {
            assert([1, 4].includes(packet.files.length)); // Whole Other and Mixed subtrees.
            const response = await f.settings.structured(
              _runtime,
              task,
              signal,
            );
            const proposal = JSON.parse(response.text);
            for (const group of proposal.groups)
              if (group.fileIds.length === 2)
                group.episodes = [
                  {
                    number: "01",
                    title: "",
                    versions: group.fileIds.map((id: string, i: number) => ({
                      label: `Variant ${i}`,
                      releaseKey: String(i),
                      fileIds: [id],
                    })),
                  },
                ];
            return { ...response, text: JSON.stringify(proposal) };
          }
          const proposals = JSON.parse(task.prompt.split("\nPROPOSALS:\n")[1]);
          assert(proposals.some((p: any) => p.episodes.length));
          return {
            text: JSON.stringify({
              groups: [
                {
                  identity: "combined",
                  title: "Whole tree",
                  fileIds: proposals.map((p: any) => p.id),
                  review: false,
                  reason: "",
                },
              ],
              collections: [],
              unassigned: [],
            }),
            citations: [],
          };
        },
      },
      async () => f.provider,
    );
    const plan = await organizer.run(f.request);
    assert.equal(requests.length, 4); // Capacity rejection + two subtrees + global reconciliation.
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].fileIds.length, 5);
    assert.equal(
      plan.groups[0].episodes?.filter((e) => e.versions.length === 2).length,
      2,
      "global sparse revisions preserve validated episode/version mappings",
    );
    assert.equal(f.store.snapshot().works.length, 2); // Preview never writes.
  } finally {
    organizer?.close();
    f.close();
  }
});

test("network, invalid output and content-filter failures never trigger capacity retries", async () => {
  for (const code of [
    "recognitionInvalid",
    "requestTimeout",
    "recognitionFailed",
    "sourceRateLimited",
  ]) {
    const f = fixture();
    let calls = 0;
    const organizer = new OrganizationService(
      f.store,
      {
        ...f.settings,
        structured: async () => {
          calls++;
          throw new ProviderError(code);
        },
      },
      async () => f.provider,
    );
    try {
      await assert.rejects(organizer.run(f.request), new RegExp(code));
      assert.equal(calls, 1);
    } finally {
      organizer.close();
      f.close();
    }
  }
});

test("coverage errors get bounded corrections with the full tree and invalid proposals never reach apply", async () => {
  for (const repaired of [true, false]) {
    const f = fixture();
    let calls = 0;
    const organizer = new OrganizationService(
      f.store,
      {
        ...f.settings,
        structured: async (runtime, task, signal) => {
          if (task.responseFormat === "text")
            return {
              text: "Group by released identity using the full inventory.",
              citations: [],
            };
          calls++;
          if (task.name === "tamki_organization_review")
            return unchangedRevision();
          const packet = JSON.parse(task.prompt.split("\n")[1]);
          assert.equal(packet.files.length, 5); // Never only send the omitted file.
          assert.equal(packet.directories.length, 3);
          const response = await f.settings.structured(runtime, task, signal);
          if (calls === 2) {
            assert(task.prompt.includes("VALIDATION ERRORS"));
            assert.equal(organizer.progress("job")?.phase, "validating");
          }
          if (calls === 1 || !repaired) {
            const broken = JSON.parse(response.text);
            broken.groups[0].fileIds.pop();
            response.text = JSON.stringify(broken);
          }
          return response;
        },
      },
      async () => f.provider,
    );
    try {
      if (repaired) {
        const plan = await organizer.run(f.request);
        assert.equal(plan.groups.flatMap((g) => g.fileIds).length, 5);
      } else
        await assert.rejects(organizer.run(f.request), /organizationInvalid/);
      assert.equal(calls, 2); // One initial request; one correction only after failure.
      assert.equal(f.store.snapshot().works.length, 0);
    } finally {
      organizer.close();
      f.close();
    }
  }
});

test("unchanged selected files do not split a work that also contains out-of-scope episodes", async () => {
  const f = fixture();
  let organizer: OrganizationService | undefined;
  try {
    f.store.applyScan(
      "storage",
      "/library",
      await scanScopes(f.provider, [{ root: "/library", depth: 2 }]),
    );
    const work = f.store.snapshot().works.find((w) => w.title === "Mixed")!;
    const additions = f.store.prepareEpisodes(work.id, "storage", [
      file("/outside/Extra.mkv"),
    ]);
    f.store.edit(
      {
        ...work,
        episodes: [...work.episodes, ...additions],
        removedEpisodeIds: [],
      },
      additions,
    );
    const before = f.store.snapshot();
    organizer = new OrganizationService(
      f.store,
      {
        ...f.settings,
        structured: async (_runtime, task) => {
          if (task.responseFormat === "text")
            return {
              text: "Group by released identity using the full inventory.",
              citations: [],
            };
          if (task.name === "tamki_organization_review")
            return unchangedRevision();
          const packet = JSON.parse(task.prompt.split("\n")[1]);
          assert.equal(
            packet.current.works.find((w: any) => w.title === "Mixed")
              .outsideFiles,
            1,
          );
          return {
            text: JSON.stringify({
              groups: packet.current.works
                .filter((w: any) => w.files.length)
                .map((w: any) => ({
                  identity: w.id,
                  title: w.title,
                  fileIds: [w.id],
                  review: false,
                  reason: "",
                })),
              collections: [],
              unassigned: [],
            }),
            citations: [],
          };
        },
      },
      async () => f.provider,
    );
    const plan = await organizer.run(f.request);
    organizer.apply({
      jobId: "job",
      groups: plan.groups.map(({ id, title }) => ({ id, title })),
      collectionIds: [],
    });
    assert.deepEqual(f.store.snapshot(), before);
  } finally {
    organizer?.close();
    f.close();
  }
});

test("approved collection membership removes excluded applied works while preserving unselected work membership", async () => {
  for (const selectMovie of [true, false]) {
    const f = fixture();
    try {
      const scan = await scanScopes(f.provider, [
        { root: "/library", depth: 2 },
      ]);
      f.store.applyScan("storage", "/library", scan);
      f.store.saveCollection({
        name: "Example series",
        workIds: f.store.snapshot().works.map((w) => w.id),
      });
      const plan = await f.organizer.run(f.request);
      const selected = plan.groups.filter(
        (g) => selectMovie || g.title !== "Movie",
      );
      f.organizer.apply({
        jobId: "job",
        groups: selected.map(({ id, title }) => ({ id, title })),
        collectionIds: plan.collections.map((c) => c.id),
      });
      const snapshot = f.store.snapshot();
      const collection = snapshot.collections.find(
        (c) => c.name === "Example series",
      )!;
      const titles = collection.workIds
        .map((id) => snapshot.works.find((w) => w.id === id)!.title)
        .sort();
      assert.deepEqual(
        titles,
        selectMovie
          ? ["Example · Season 1", "Example · Season 2"]
          : ["Example · Season 1", "Example · Season 2", "Other"],
      );
      assert.equal(snapshot.works.flatMap((w) => w.episodes).length, 5);
    } finally {
      f.close();
    }
  }
});

test("invalid columnar transport gets one canonical correction without bypassing the wire contract", async () => {
  for (const repaired of [true, false]) {
    const f = fixture();
    const requests: StructuredTask[] = [];
    const organizer = new ProductionOrganizationService(
      f.store,
      {
        ...f.settings,
        structured: async (runtime, task, signal) => {
          requests.push(task);
          if (requests.length === 1) {
            assert(Object.hasOwn(task.schema.properties!, "g"));
            assert.equal(task.reasoningEffort, "medium");
            const packet = JSON.parse(task.prompt.split("\n")[1]);
            assert(packet.compactInput);
            // A partial columnar envelope must not masquerade as a valid empty
            // proposal or bypass the strict decoder through canonical fields.
            return { text: JSON.stringify({ g: [] }), citations: [] };
          }
          assert.equal(requests.length, 2);
          assert(!Object.hasOwn(task.schema.properties!, "g"));
          assert(task.prompt.includes("invalidColumnarResponse"));
          const packet = JSON.parse(task.prompt.split("\n")[1]);
          assert.equal(packet.files.length, 5);
          assert.equal(organizer.progress("job")?.phase, "validating");
          return repaired
            ? f.settings.structured(runtime, task, signal)
            : { text: JSON.stringify({ g: [] }), citations: [] };
        },
      },
      async () => f.provider,
    );
    try {
      if (repaired) {
        const plan = await organizer.run(f.request);
        assert.equal(plan.groups.flatMap((g) => g.fileIds).length, 5);
      } else {
        await assert.rejects(organizer.run(f.request), /organizationInvalid/);
      }
      assert.equal(requests.length, 2);
      assert.equal(f.store.snapshot().works.length, 0);
    } finally {
      organizer.close();
      f.close();
    }
  }
});

test("feedback refinement retains full snapshot, prior plan and feedback without rescanning or applying", async () => {
  const f = fixture();
  try {
    const plan = await f.organizer.run(f.request);
    const before = f.store.organizationFingerprint();
    f.provider.list = async () => {
      throw new Error("must not rescan");
    };
    const first = await f.organizer.refine({
      jobId: "revision-1",
      previousJobId: plan.jobId,
      feedback: "Keep unrelated decisions. Verify disputed identities.",
      titles: [{ id: plan.groups[0].id, title: "User title" }],
    });
    const task = f.calls.at(-1)!;
    const context = JSON.parse(task.prompt.split("\nREVISION CONTEXT:\n")[1]);
    assert.equal(context.previousProposal.groups[0].title, "User title");
    assert.equal(context.previousProposal.groups[0].titleEdited, true);
    assert.equal(
      context.previousProposal.groups.flatMap((g: any) => g.fileIds).length,
      5,
    );
    assert(
      context.previousProposal.groups.every((g: any) =>
        g.fileIds.every((id: string) => /^f\d+$/.test(id)),
      ),
    );
    assert.equal(first.files.length, 5);
    assert.equal(f.store.organizationFingerprint(), before);
    assert.throws(
      () =>
        f.organizer.apply({
          jobId: plan.jobId,
          groups: [{ id: plan.groups[0].id, title: plan.groups[0].title }],
          collectionIds: [],
        }),
      /organizationExpired/,
    );
    const second = await f.organizer.refine({
      jobId: "revision-2",
      previousJobId: first.jobId,
      feedback: "Use my latest correction where it conflicts.",
      titles: [],
    });
    const next = JSON.parse(
      f.calls.at(-1)!.prompt.split("\nREVISION CONTEXT:\n")[1],
    );
    assert.equal(next.userFeedback.length, 2);
    assert.equal(second.jobId, "revision-2");
    assert.equal(f.calls.length, 3);
  } finally {
    f.close();
  }
});

test("cancelled feedback preserves the original proposal and rejects apply while running", async () => {
  const f = fixture();
  try {
    const plan = await f.organizer.run(f.request);
    let release!: () => void;
    f.state.delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.organizer.refine({
      jobId: "revision",
      previousJobId: plan.jobId,
      feedback: "Verify the proposed grouping.",
      titles: [],
    });
    assert.throws(
      () =>
        f.organizer.apply({
          jobId: plan.jobId,
          groups: [{ id: plan.groups[0].id, title: plan.groups[0].title }],
          collectionIds: [],
        }),
      /organizationBusy/,
    );
    f.organizer.cancel("revision");
    release();
    await assert.rejects(pending, /recognitionCancelled/);
    assert.equal(f.organizer.progress(plan.jobId)?.phase, "ready");
    await assert.rejects(
      f.organizer.refine({
        jobId: "bad",
        previousJobId: plan.jobId,
        feedback: "test",
        titles: [{ id: "foreign", title: "bad" }],
      }),
      /invalidInput/,
    );
  } finally {
    f.close();
  }
});
