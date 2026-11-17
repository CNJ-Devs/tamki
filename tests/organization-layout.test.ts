import test from "node:test";
import assert from "node:assert/strict";
import {
  OrganizationInput,
  OrganizationOutputError,
} from "../src/library/organization-input";
import { OrganizationOwnershipError } from "../src/library/organization-layout";

function fixture() {
  const files = [1, 2, 3, 4].map((i) => ({
    id: `file-${i}`,
    connectionId: "disk",
    root: "/media",
    path: `/media/${i}.mkv`,
    relativePath: `${i}.mkv`,
    name: `${i}.mkv`,
    size: i * 100,
    modified: 0,
    duration: null,
  }));
  const input = new OrganizationInput(
    files,
    [],
    { works: [], collections: [] },
    [{ connectionId: "disk", path: "/media", depth: 1 }],
  );
  const draft = JSON.stringify({
    groups: [
      {
        identity: "alpha",
        title: "Alpha",
        fileIds: ["f1", "f2", "f3", "f4"],
        episodes: [],
        review: false,
        reason: "",
      },
    ],
    collections: [],
    unassigned: [],
  });
  const stage = input.relationshipTask(input.task("", "en"), draft);
  const result = {
    ownershipIssues: [],
    collections: [],
    works: {
      alpha: {
        layout: [
          [1, 1],
          [2, 1],
          [1, 2],
          [1, 2],
        ],
        episodeMetadata: [{ key: 1, number: "01", title: "Opening" }],
        versionMetadata: [
          { key: 1, label: "A", releaseKey: "release-a" },
          { key: 2, label: "B", releaseKey: "release-b" },
        ],
        collectionKeys: [] as string[],
        review: false,
        reason: "",
      },
    },
  };
  return { input, stage, result, files };
}

test("total compact layout expands episodes, representations and copies without conflating reusable labels", () => {
  const { input, stage, result, files } = fixture();
  const parsed = input.decode(stage.merge(JSON.stringify(result)));
  assert.equal(parsed.groups[0].episodes.length, 2);
  assert.deepEqual(parsed.groups[0].episodes[0], {
    number: "01",
    title: "Opening",
    versions: [
      { label: "A", releaseKey: "release-a", fileIds: ["file-1"] },
      { label: "B", releaseKey: "release-b", fileIds: ["file-3", "file-4"] },
    ],
  });
  assert.deepEqual(parsed.groups[0].episodes[1].versions[0].fileIds, [
    "file-2",
  ]);
  assert.equal(
    JSON.parse(stage.task.prompt.split("\n")[1]).files.length,
    files.length,
  );
  assert(stage.task.prompt.includes("ORDERED WORK ASSIGNMENTS"));
});

test("every physical file must have exactly one positive integer pair and every work a decision", () => {
  for (const change of [
    (r: any) => r.works.alpha.layout.pop(),
    (r: any) => r.works.alpha.layout.push([3, 1]),
    (r: any) => (r.works.alpha.layout[0] = [0, 1]),
    (r: any) => (r.works.alpha.layout[0] = [1]),
    (r: any) => delete r.works.alpha,
  ]) {
    const { stage, result } = fixture();
    change(result);
    assert.throws(
      () => stage.merge(JSON.stringify(result)),
      (e: any) =>
        e instanceof OrganizationOutputError &&
        e.reason === "schema" &&
        e.feedback.issues.some((i: any) => i.field.startsWith("works")),
    );
  }
});

test("metadata and collection references are validated without guessing", () => {
  for (const change of [
    (r: any) =>
      r.works.alpha.episodeMetadata.push({ key: 99, number: "", title: "" }),
    (r: any) =>
      r.works.alpha.versionMetadata.push(r.works.alpha.versionMetadata[0]),
    (r: any) => (r.works.alpha.collectionKeys = ["missing"]),
  ]) {
    const { stage, result } = fixture();
    change(result);
    assert.throws(
      () => stage.merge(JSON.stringify(result)),
      /organizationInvalid/,
    );
  }
  const { stage, result, input } = fixture();
  (result.collections as any[]).push({
    key: "one",
    name: "Invalid self-collection",
    relationship: "One work",
  });
  result.works.alpha.collectionKeys = ["one"];
  assert.throws(
    () => input.decode(stage.merge(JSON.stringify(result))),
    /organizationInvalid/,
  );
});

test("canonical validation rejects duplicate collection memberships under different names", () => {
  const { input } = fixture();
  assert.throws(
    () =>
      input.decode(
        JSON.stringify({
          groups: ["a", "b"].map((identity, i) => ({
            identity,
            title: identity,
            fileIds: i ? ["f3", "f4"] : ["f1", "f2"],
            episodes: [],
            review: false,
            reason: "",
          })),
          collections: [
            { name: "First", groupIds: ["a", "b"] },
            { name: "Second", groupIds: ["b", "a"] },
          ],
          unassigned: [],
        }),
      ),
    (e: any) =>
      e instanceof OrganizationOutputError &&
      e.reason === "duplicateCollectionMembership",
  );
});

test("relationship corrections retain untouched decisions and still validate the complete graph", () => {
  const { input } = fixture();
  const draft = JSON.stringify({
    groups: ["alpha", "beta"].map((identity, i) => ({
      identity,
      title: identity,
      fileIds: i ? ["f3", "f4"] : ["f1", "f2"],
      episodes: [],
      review: false,
      reason: "",
    })),
    collections: [],
    unassigned: [],
  });
  const stage = input.relationshipTask(input.task("", "en"), draft);
  const decision = {
    layout: [
      [1, 1],
      [1, 2],
    ],
    episodeMetadata: [{ key: 1, number: "01", title: "Opening" }],
    versionMetadata: [],
    collectionKeys: ["related"],
    review: true,
    reason: "Existing review remains.",
  };
  const raw = JSON.stringify({
    ownershipIssues: [],
    works: { alpha: decision, beta: decision },
    collections: [],
  });
  let failure: OrganizationOutputError | undefined;
  try {
    stage.merge(raw);
  } catch (error) {
    assert(error instanceof OrganizationOutputError);
    failure = error;
  }
  assert(failure);
  const correction = stage.correction(raw, failure)!;
  assert(correction.task.prompt.includes("REJECTED RELATIONSHIPS"));
  assert(correction.task.prompt.includes("INPUT:"));
  const patch = {
    ownershipIssues: [],
    works: { alpha: null, beta: null },
    collections: [{ key: "related", name: "Family", relationship: "Series" }],
  };
  const merged = input.decode(correction.merge(JSON.stringify(patch)));
  assert.equal(merged.collections.length, 1);
  assert(merged.groups.every((g) => g.review && g.reason === decision.reason));
  assert.deepEqual(
    merged.groups.map((g) => g.episodes[0].versions.map((v) => v.fileIds)),
    [
      [["file-1"], ["file-2"]],
      [["file-3"], ["file-4"]],
    ],
  );
  assert.throws(
    () => correction.merge(JSON.stringify({ ...patch, collections: null })),
    /organizationInvalid/,
    "retaining an unresolved invalid relationship must still fail",
  );
  assert.throws(
    () =>
      correction.merge(JSON.stringify({ ...patch, works: { alpha: null } })),
    /organizationInvalid/,
    "each work needs an explicit retain or replacement decision",
  );
});

test("relationship retry retains full evidence and rejects a still-incomplete layout", async () => {
  const { analyzeOrganization } =
    await import("../src/library/organization-analysis");
  for (const repaired of [true, false]) {
    const { input, result, files } = fixture();
    let calls = 0;
    const run = analyzeOrganization({
      input,
      files,
      task: input.task("", "en"),
      relationships: true,
      signal: new AbortController().signal,
      request: async (task) => {
        calls++;
        assert(!task.system.includes("Use groups.episodes"));
        if (calls === 1)
          return {
            text: JSON.stringify({
              groups: [
                {
                  identity: "alpha",
                  title: "Alpha",
                  fileIds: ["f1", "f2", "f3", "f4"],
                  episodes: [],
                  review: false,
                  reason: "",
                },
              ],
              collections: [],
              unassigned: [],
            }),
          };
        if (calls === 2)
          return {
            text: JSON.stringify({
              removeGroupIds: [],
              groups: [],
              replaceCollections: false,
              collections: [],
              replaceUnassigned: false,
              unassigned: [],
            }),
          };
        assert.equal(task.name, "tamki_organization_relationships");
        assert.equal(JSON.parse(task.prompt.split("\n")[1]).files.length, 4);
        if (calls === 4) {
          assert(task.prompt.includes("REJECTED RELATIONSHIPS"));
          assert(task.prompt.includes("VALIDATION ERRORS"));
          if (repaired) return { text: JSON.stringify(result) };
        }
        const bad = structuredClone(result);
        bad.works.alpha.layout.pop();
        return { text: JSON.stringify(bad) };
      },
    });
    if (repaired) assert.equal((await run).groups[0].episodes.length, 2);
    else await assert.rejects(run, /organizationInvalid/);
    assert.equal(calls, 4);
  }
});

test("relationship stage expands selector membership into the exact file order visible to the model", () => {
  const { input } = fixture();
  const draft = JSON.stringify({
    groups: [
      {
        identity: "alpha",
        title: "Alpha",
        fileIds: ["d1"],
        episodes: [],
        review: true,
        reason: "Work identity still needs confirmation.",
      },
    ],
    collections: [],
    unassigned: [],
  });
  const stage = input.relationshipTask(input.task("", "en"), draft);
  const evidence = JSON.parse(
    stage.task.prompt
      .split("ORDERED WORK ASSIGNMENTS:\n")[1]
      .split("\nOUTPUT CONTRACT:")[0],
  );
  assert.deepEqual(evidence.groups[0].fileIds, ["f1", "f2", "f3", "f4"]);
  const result = input.decode(
    stage.merge(
      JSON.stringify({
        ownershipIssues: [],
        collections: [],
        works: {
          alpha: {
            layout: [
              [1, 1],
              [2, 1],
              [3, 1],
              [4, 1],
            ],
            episodeMetadata: [],
            versionMetadata: [],
            collectionKeys: [],
            review: false,
            reason: "",
          },
        },
      }),
    ),
  );
  assert.equal(result.groups[0].episodes.length, 4);
  assert.equal(result.groups[0].review, true);
  assert.equal(
    result.groups[0].reason,
    "Work identity still needs confirmation.",
  );
});

test("omitted metadata respects manual values, preserves split labels, and refuses ambiguous inheritance", async () => {
  const { organizationLayoutTask } =
    await import("../src/library/organization-layout");
  const { input } = fixture();
  const prior = (id: string, title: string) => ({
    number: "1",
    title,
    versions: [
      { label: "Original label", releaseKey: "release", fileIds: [id] },
    ],
  });
  const group = {
    identity: "work",
    title: "Work",
    fileIds: ["f1", "f2"],
    episodes: [prior("f1", "Auto"), prior("f2", "Authored")],
    review: false,
    reason: "",
  };
  const response = {
    ownershipIssues: [],
    collections: [],
    works: {
      work: {
        layout: [
          [1, 1],
          [1, 1],
        ],
        episodeMetadata: [],
        versionMetadata: [],
        collectionKeys: [],
        review: false,
        reason: "",
      },
    },
  };
  for (const reverse of [false, true]) {
    const g = structuredClone(group);
    if (reverse) g.fileIds.reverse();
    const stage = organizationLayoutTask(
      input.task("", "en"),
      JSON.stringify({ groups: [g], collections: [], unassigned: [] }),
      undefined,
      new Map([["f2", ["title"]]]),
    );
    const result = JSON.parse(stage.merge(JSON.stringify(response)));
    assert.equal(result.groups[0].episodes[0].title, "Authored");
    assert.equal(
      result.groups[0].episodes[0].versions[0].label,
      "Original label",
    );
  }
  const ambiguous = organizationLayoutTask(
    input.task("", "en"),
    JSON.stringify({ groups: [group], collections: [], unassigned: [] }),
  );
  assert.throws(
    () => ambiguous.merge(JSON.stringify(response)),
    (e: any) =>
      e.feedback.issues.some((i: any) =>
        i.field.endsWith("episodeMetadata.title"),
      ),
  );
  const splitGroup = {
    ...group,
    episodes: [
      {
        number: "1",
        title: "Authored",
        versions: [
          {
            label: "Original label",
            releaseKey: "release",
            fileIds: ["f1", "f2"],
          },
        ],
      },
    ],
  };
  const split = organizationLayoutTask(
    input.task("", "en"),
    JSON.stringify({ groups: [splitGroup], collections: [], unassigned: [] }),
  );
  response.works.work.layout = [
    [1, 1],
    [1, 2],
  ];
  const result = JSON.parse(split.merge(JSON.stringify(response)));
  assert.deepEqual(
    result.groups[0].episodes[0].versions.map((v: any) => [
      v.label,
      v.releaseKey,
    ]),
    [
      ["Original label", "release"],
      ["Original label", "release"],
    ],
  );
});

test("disabling content review does not disable requested relationship classification", async () => {
  const { analyzeOrganization } =
    await import("../src/library/organization-analysis");
  const { input, files, result } = fixture();
  let count = 0;
  const output = await analyzeOrganization({
    input,
    files,
    task: input.task("", "en"),
    relationships: true,
    review: false,
    signal: new AbortController().signal,
    request: async (task) => {
      count++;
      if (count === 1)
        return {
          text: JSON.stringify({
            groups: [
              {
                identity: "alpha",
                title: "Alpha",
                fileIds: ["d1"],
                episodes: [],
                review: false,
                reason: "",
              },
            ],
            collections: [],
            unassigned: [],
          }),
        };
      assert.equal(task.name, "tamki_organization_relationships");
      return { text: JSON.stringify(result) };
    },
  });
  assert.equal(count, 2);
  assert.equal(output.groups[0].episodes.length, 2);
});

test("reserved dynamic identities fail validation rather than disappearing from a decision map", () => {
  const { input } = fixture();
  for (const identity of ["__proto__", "constructor", "prototype"])
    assert.throws(
      () =>
        input.decode(
          JSON.stringify({
            groups: [
              {
                identity,
                title: "Valid display title",
                fileIds: ["d1"],
                episodes: [],
                review: false,
                reason: "",
              },
            ],
            collections: [],
            unassigned: [],
          }),
        ),
      /organizationInvalid/,
    );
});

test("independently valid prior and new review notes survive without exceeding the model-note parser limit", async () => {
  const { analyzeOrganization } =
    await import("../src/library/organization-analysis");
  const { input, files, result } = fixture();
  const prior = "x".repeat(1000);
  let count = 0;
  result.works.alpha.reason = "New finding";
  result.works.alpha.review = true;
  const output = await analyzeOrganization({
    input,
    files,
    task: input.task("", "en"),
    relationships: true,
    review: false,
    signal: new AbortController().signal,
    request: async () => {
      if (++count === 1)
        return {
          text: JSON.stringify({
            groups: [
              {
                identity: "alpha",
                title: "Alpha",
                fileIds: ["d1"],
                episodes: [],
                review: true,
                reason: prior,
              },
            ],
            collections: [],
            unassigned: [],
          }),
        };
      return { text: JSON.stringify(result) };
    },
  });
  assert.equal(output.groups[0].reason, prior + "\nNew finding");
  assert(output.groups[0].review);
});

test("wrong ownership is a validated blocking finding, never a deliverable review flag", () => {
  const { stage } = fixture();
  const findings = [
    {
      workId: "alpha",
      fileIds: ["f3", "f4"],
      reason: "These files identify another independent work.",
    },
  ];
  const response = {
    ownershipIssues: findings,
    works: null,
    collections: null,
  };
  assert.throws(
    () => stage.merge(JSON.stringify(response)),
    (e: unknown) =>
      e instanceof OrganizationOwnershipError &&
      e.findings[0].workId === "alpha",
  );
  for (const issue of [
    { ...findings[0], workId: "unknown" },
    { ...findings[0], fileIds: ["unknown"] },
    { ...findings[0], fileIds: ["f3", "f3"] },
  ]) {
    assert.throws(
      () =>
        stage.merge(JSON.stringify({ ...response, ownershipIssues: [issue] })),
      (e: unknown) =>
        e instanceof OrganizationOutputError &&
        !(e instanceof OrganizationOwnershipError),
    );
  }
  assert.throws(
    () => stage.merge(JSON.stringify({ ...response, ownershipIssues: [] })),
    /organizationInvalid/,
  );
});

test("relationship findings return to either allocation protocol and regenerate layouts against the corrected graph", async () => {
  const { analyzeOrganization } =
    await import("../src/library/organization-analysis");
  for (const allocations of [false, true]) {
    const { input, files } = fixture();
    const declaration = (identity: string) => ({
      identity,
      title: identity,
      episodes: [],
      review: false,
      reason: "",
    });
    const issue = {
      ownershipIssues: [
        {
          workId: "alpha",
          fileIds: ["f3", "f4"],
          reason: "Different work identity.",
        },
      ],
      works: null,
      collections: null,
    };
    let calls = 0;
    const result = await analyzeOrganization({
      input,
      files,
      task: input.task("", "en"),
      review: false,
      relationships: true,
      signal: new AbortController().signal,
      request: async (task) => {
        calls++;
        assert.equal(JSON.parse(task.prompt.split("\n")[1]).files.length, 4);
        if (calls === 1)
          return {
            text: JSON.stringify(
              allocations
                ? {
                    groups: [{ ...declaration("alpha"), order: [] }],
                    allocations: { u1: { groupId: "alpha", overrides: [] } },
                    collections: [],
                  }
                : {
                    groups: [{ ...declaration("alpha"), fileIds: ["d1"] }],
                    collections: [],
                    unassigned: [],
                  },
            ),
          };
        if (calls === 2) return { text: JSON.stringify(issue) };
        if (calls === 3) {
          assert.match(task.name, /revision$/);
          assert(task.prompt.includes("Different work identity."));
          return {
            text: JSON.stringify(
              allocations
                ? {
                    groups: { alpha: null },
                    addedGroups: [{ ...declaration("beta"), order: [] }],
                    allocations: {
                      u1: {
                        groupId: "alpha",
                        overrides: [
                          { fileId: "f3", groupId: "beta" },
                          { fileId: "f4", groupId: "beta" },
                        ],
                      },
                    },
                    replaceCollections: false,
                    collections: [],
                  }
                : {
                    removeGroupIds: [],
                    groups: [
                      { ...declaration("alpha"), fileIds: ["f1", "f2"] },
                      { ...declaration("beta"), fileIds: ["f3", "f4"] },
                    ],
                    replaceCollections: false,
                    collections: [],
                    replaceUnassigned: false,
                    unassigned: [],
                  },
            ),
          };
        }
        assert.equal(task.name, "tamki_organization_relationships");
        const current = JSON.parse(
          task.prompt
            .split("ORDERED WORK ASSIGNMENTS:\n")[1]
            .split("\nOUTPUT CONTRACT:")[0],
        );
        assert.deepEqual(
          current.groups.map((g: any) => g.fileIds),
          [
            ["f1", "f2"],
            ["f3", "f4"],
          ],
        );
        return {
          text: JSON.stringify({
            ownershipIssues: [],
            collections: [],
            works: Object.fromEntries(
              ["alpha", "beta"].map((id) => [
                id,
                {
                  layout: [
                    [1, 1],
                    [1, 2],
                  ],
                  episodeMetadata: [],
                  versionMetadata: [],
                  collectionKeys: [],
                  review: false,
                  reason: "",
                },
              ]),
            ),
          }),
        };
      },
    });
    assert.equal(calls, 4);
    assert.deepEqual(
      result.groups.map((g) => g.fileIds),
      [
        ["file-1", "file-2"],
        ["file-3", "file-4"],
      ],
    );
    assert(
      result.groups.every(
        (g) => g.episodes.length === 1 && g.episodes[0].versions.length === 2,
      ),
    );
  }
});

test("ownership repair cannot succeed by renaming or adding a review flag, and recurring conflicts are bounded", async () => {
  const { analyzeOrganization } =
    await import("../src/library/organization-analysis");
  for (const action of ["review", "rename", "recurring", "cancel"]) {
    const { input, files } = fixture();
    const controller = new AbortController();
    const group = {
      identity: "alpha",
      title: "Alpha",
      fileIds: ["d1"],
      episodes: [],
      review: false,
      reason: "",
    };
    let calls = 0;
    await assert.rejects(
      analyzeOrganization({
        input,
        files,
        task: input.task("", "en"),
        review: false,
        relationships: true,
        signal: controller.signal,
        request: async (task) => {
          calls++;
          if (calls === 1)
            return {
              text: JSON.stringify({
                groups: [group],
                collections: [],
                unassigned: [],
              }),
            };
          if (calls === 2 || calls === 4)
            return {
              text: JSON.stringify({
                ownershipIssues: [
                  {
                    workId: "alpha",
                    fileIds: ["f1"],
                    reason: "Ownership is inconsistent with evidence.",
                  },
                ],
                works: null,
                collections: null,
              }),
            };
          assert.equal(calls, 3);
          if (action === "cancel") controller.abort();
          return {
            text: JSON.stringify({
              removeGroupIds: action === "rename" ? ["alpha"] : [],
              groups:
                action === "recurring"
                  ? [
                      { ...group, fileIds: ["f1", "f2"] },
                      { ...group, identity: "beta", fileIds: ["f3", "f4"] },
                    ]
                  : [
                      {
                        ...group,
                        identity: action === "rename" ? "replacement" : "alpha",
                        review: true,
                        reason: "Needs confirmation",
                      },
                    ],
              replaceCollections: false,
              collections: [],
              replaceUnassigned: false,
              unassigned: [],
            }),
          };
        },
      }),
      action === "cancel" ? { name: "AbortError" } : OrganizationOwnershipError,
    );
    assert.equal(calls, action === "recurring" ? 4 : 3);
  }
});
