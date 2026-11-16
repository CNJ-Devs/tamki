import test from "node:test";
import assert from "node:assert/strict";
import { OrganizationInput } from "../src/library/organization-input";
import { allocationContract } from "../src/library/organization-contract";
import { analyzeOrganization } from "../src/library/organization-analysis";
import { aiStructured } from "../src/providers/ai-recognition";
import { newSource } from "../src/shared/settings";

function fixture() {
  const files = [
    "direct.mp4",
    "Mixed/a.mp4",
    "Mixed/b.mp4",
    "Mixed/Nested/c.mp4",
  ].map((name, index) => ({
    id: `physical-${index}`,
    connectionId: "storage",
    root: "/videos",
    path: `/videos/${name}`,
    relativePath: name,
    name: name.split("/").at(-1)!,
    size: 100,
    modified: 1,
    duration: null,
  }));
  const input = new OrganizationInput(
    files,
    [],
    { works: [], collections: [] },
    [{ connectionId: "storage", path: "/videos", depth: 3 }],
  );
  const units = input.allocationUnits();
  const proposal = {
    groups: ["a", "b"].map((identity) => ({
      identity,
      title: identity,
      review: false,
      reason: "",
      order: [] as string[],
    })),
    allocations: Object.fromEntries(
      units.map(([id]) => [
        id,
        {
          groupId: "a" as string | null,
          overrides: [] as { fileId: string; groupId: string | null }[],
        },
      ]),
    ),
    collections: [{ name: "Related", groupIds: ["a", "b"] }],
  };
  proposal.allocations[units[1][0]].overrides.push({
    fileId: "f3",
    groupId: "b",
  });
  return { files, input, units, proposal };
}

function transactionFixture() {
  const f = fixture();
  const tx = f.input.allocationRevision(
    f.input.task("", "en"),
    JSON.stringify(f.proposal),
    { issues: [], missing: [], duplicates: [] },
  )!;
  const replacements = Object.fromEntries(
    f.proposal.groups.map(({ identity, ...declaration }) => [
      identity,
      { ...declaration, episodes: [] },
    ]),
  );
  const keep = {
    groups: Object.fromEntries(
      f.proposal.groups.map((g) => [g.identity, null]),
    ) as Record<string, unknown>,
    addedGroups: [] as unknown[],
    allocations: Object.fromEntries(
      f.units.map(([id]) => [id, null]),
    ) as Record<string, unknown>,
    replaceCollections: false,
    collections: [] as { name: string; groupIds: string[] }[],
  };
  const decode = (patch: typeof keep) =>
    f.input.decode(f.input.normalizeResponse(tx.merge(JSON.stringify(patch))));
  return { ...f, tx, replacements, keep, decode };
}

test("allocation units cover direct and nested files once without imposing work boundaries", () => {
  const { input, units, proposal } = fixture();
  assert.deepEqual(
    units.map((u) => u[2]),
    [["f1"], ["f2", "f3"], ["f4"]],
  );
  const result = input.decode(
    input.normalizeResponse(JSON.stringify(proposal)),
  );
  assert.deepEqual(
    result.groups.map((g) => g.fileIds),
    [["physical-0", "physical-1", "physical-3"], ["physical-2"]],
  );
});

test("the generated output contract requires every unit and cannot accept the empty 46-character response", () => {
  const { input, units, proposal } = fixture();
  const contract = allocationContract(units);
  assert(contract.safeParse(proposal).success);
  assert(
    !contract.safeParse({
      ...proposal,
      groups: [],
      allocations: Object.fromEntries(
        units.map(([id]) => [id, { groupId: null, overrides: [] }]),
      ),
    }).success,
  );
  assert(
    !contract.safeParse({ groups: [], unassigned: [], collections: [] })
      .success,
  );
  delete proposal.allocations[units[1][0]];
  assert(!contract.safeParse(proposal).success);
  assert.throws(
    () => input.normalizeResponse(JSON.stringify(proposal)),
    /organizationInvalid/,
  );
  const schema = input.task("", "en").schema as any;
  assert.deepEqual(
    schema.properties.allocations.required,
    units.map((u) => u[0]),
  );
});

test("overrides cannot silently duplicate a file, address another unit or invent a destination", () => {
  for (const kind of ["duplicate", "outside", "unknown"] as const) {
    const { input, units, proposal } = fixture();
    const item = proposal.allocations[units[1][0]];
    if (kind === "duplicate")
      item.overrides.push({ fileId: "f3", groupId: "a" });
    if (kind === "outside") item.overrides.push({ fileId: "f1", groupId: "b" });
    if (kind === "unknown") item.groupId = "invented";
    assert.throws(
      () => input.normalizeResponse(JSON.stringify(proposal)),
      /organizationInvalid/,
    );
  }
});

test("unassigned decisions and explicit file ordering remain representable and fully validated", () => {
  const { input, units, proposal } = fixture();
  proposal.allocations[units[2][0]].groupId = null;
  proposal.groups[0].order = ["f2", "f1"];
  const result = input.decode(
    input.normalizeResponse(JSON.stringify(proposal)),
  );
  assert.deepEqual(result.groups[0].fileIds, ["physical-1", "physical-0"]);
  assert.deepEqual(result.unassigned, ["physical-3"]);
  proposal.groups[0].order = ["f2", "f2"];
  assert.throws(
    () => input.normalizeResponse(JSON.stringify(proposal)),
    /organizationInvalid/,
  );
});

test("partial analysis includes only selected files while preserving the global directory context", () => {
  const { input, files } = fixture();
  const selected = [files[1], files[3]];
  assert.deepEqual(
    input.allocationUnits(selected).flatMap((u) => u[2]),
    ["f2", "f4"],
  );
  assert.deepEqual(
    input.packet(selected).directories,
    input.packet().directories,
  );
});

test("the production analyzer expands allocations before review and corrects a missing required unit", async () => {
  const { input, files, units, proposal } = fixture();
  let calls = 0;
  const result = await analyzeOrganization({
    input,
    files,
    task: input.task("", "en"),
    signal: new AbortController().signal,
    request: async (task) => {
      calls++;
      if (calls === 1) {
        const bad = structuredClone(proposal);
        delete bad.allocations[units[0][0]];
        return { text: JSON.stringify(bad) };
      }
      if (calls === 2) {
        assert(task.prompt.includes('"field":"allocations"'));
        return { text: JSON.stringify(proposal) };
      }
      assert.equal(task.name, "tamki_organization_allocation_review");
      assert(!task.system.includes("Initial assignment contract:"));
      assert(task.prompt.includes('"overrides":'));
      assert(task.prompt.includes("CURRENT ALLOCATION DRAFT"));
      return {
        text: JSON.stringify({
          removeGroupIds: [],
          groups: [],
          replaceCollections: false,
          collections: [],
          allocations: Object.fromEntries(units.map(([id]) => [id, null])),
        }),
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.groups.flatMap((g) => g.fileIds).length, files.length);
});

test("semantic planning keeps the whole inventory and cannot itself become an applicable plan", async () => {
  const { input, files, units, proposal } = fixture();
  let calls = 0;
  const result = await analyzeOrganization({
    input,
    files,
    plan: true,
    task: input.task("", "en"),
    signal: new AbortController().signal,
    request: async (task) => {
      calls++;
      assert.equal(
        JSON.parse(task.prompt.split("\n")[1]).files.length,
        files.length,
      );
      if (calls === 1) {
        assert.equal(task.responseFormat, "text");
        assert(!task.prompt.includes("OUTPUT CONTRACT"));
        return {
          text: "Candidate: combine the direct file and nested file; keep the other identity distinct.",
        };
      }
      assert(task.prompt.includes("CANDIDATE SEMANTIC ANALYSIS"));
      if (calls === 3) {
        assert.equal(task.responseFormat, "text");
        assert(task.prompt.includes("DRAFT FOR CRITICAL REVIEW"));
        return {
          text: "The proposed relationship is supported by the fixture evidence.",
        };
      }
      assert.equal(task.responseFormat, undefined);
      if (calls === 2) return { text: JSON.stringify(proposal) };
      assert.equal(task.name, "tamki_organization_allocation_review");
      return {
        text: JSON.stringify({
          removeGroupIds: [],
          groups: [],
          replaceCollections: false,
          collections: [],
          allocations: Object.fromEntries(units.map(([id]) => [id, null])),
        }),
      };
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.groups.length, 2);
});

test("plain-text planning omits JSON constraints on each supported protocol", async () => {
  const { input } = fixture();
  const task = input.planningTask(input.task("", "en"));
  for (const provider of [
    "openai",
    "openai-oauth",
    "anthropic",
    "gemini",
    "deepseek",
  ] as const) {
    const result = await aiStructured(
      { ...newSource(provider), model: "fixture", searchMode: "none" },
      "fixture",
      "",
      task,
      new AbortController().signal,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.text, undefined);
        assert.equal(body.response_format, undefined);
        assert.equal(body.generationConfig?.responseJsonSchema, undefined);
        assert.equal(body.generationConfig?.responseMimeType, undefined);
        const response = {
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "A semantic plan." }],
            },
          ],
        };
        if (provider === "openai-oauth")
          return new Response(
            `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
        if (provider === "openai") return Response.json(response);
        if (provider === "anthropic")
          return Response.json({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "A semantic plan." }],
          });
        if (provider === "gemini")
          return Response.json({
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ text: "A semantic plan." }] },
              },
            ],
          });
        return Response.json({
          choices: [
            { finish_reason: "stop", message: { content: "A semantic plan." } },
          ],
        });
      },
    );
    assert.equal(result.text, "A semantic plan.");
  }
});

test("allocation repair reports dangling destinations and empty declarations together", () => {
  const { input, units, proposal } = fixture();
  proposal.allocations[units[0][0]].groupId = "missing-a";
  proposal.allocations[units[1][0]].overrides[0].groupId = "missing-b";
  assert.throws(
    () => input.normalizeResponse(JSON.stringify(proposal)),
    (e: any) => {
      assert.equal(e.reason, "unknownReference");
      assert.deepEqual(
        e.feedback.issues.map((i: any) => i.reference),
        ["missing-a", "missing-b", "b"],
      );
      assert(
        e.feedback.issues
          .filter((i: any) => i.reason === "unknownReference")
          .every((i: any) => i.field.startsWith("allocations.u")),
      );
      assert.equal(e.feedback.issues.at(-1).reason, "emptyGroup");
      assert(
        e.feedback.issues.at(-1).detail.includes("collections.0.groupIds"),
      );
      return true;
    },
  );
});

test("filename affixes are lossless and do not remove hierarchy, attributes or manual provenance", () => {
  const { files } = fixture();
  const expanded = Array.from({ length: 8 }, (_, i) => ({
    ...files[0],
    id: `long-${i}`,
    name: `[Publisher 🦊] Example Series - ${i + 1} [Edition].mkv`,
    path: `/videos/[Publisher 🦊] Example Series - ${i + 1} [Edition].mkv`,
    relativePath: `[Publisher 🦊] Example Series - ${i + 1} [Edition].mkv`,
  }));
  const input = new OrganizationInput(
    expanded,
    [],
    {
      works: [
        {
          id: "work",
          title: "A title",
          description: "",
          tags: [],
          hasCover: false,
          manualFields: [],
          recognized: false,
          outsideFiles: 0,
          files: expanded.map((f, i) => ({
            id: f.id,
            number: String(i + 1),
            title: "",
            description: "",
            manual: i === 0,
            manualFields: i === 0 ? ["number"] : [],
            assignmentOrigin: i === 0 ? "manual" : "scan",
          })),
        },
      ],
      collections: [],
    },
    [{ connectionId: "storage", path: "/videos", depth: 1 }],
  );
  const packet = input.packet();
  assert(Object.keys(packet.fileNameAffixes).length > 0);
  assert.deepEqual(
    packet.files.map((r) => {
      const [prefix, suffix] = packet.fileNameAffixes[r[1]] || ["", ""];
      return prefix + r[2] + suffix;
    }),
    expanded.map((f) => f.name),
  );
  assert.deepEqual(
    packet.files.map((r) => r.slice(3)),
    expanded.map((f) => [f.size, f.modified, f.duration]),
  );
  assert.equal(packet.current.fileDefaults.assignmentOrigin, "scan");
  assert.equal(packet.current.works[0].files[0].assignmentOrigin, "manual");
  assert.deepEqual(packet.current.works[0].files[0].manualFields, ["number"]);
  assert.equal(packet.current.works[0].files[1].assignmentOrigin, undefined);
});

test("identical allocation declarations are idempotent while conflicting identities remain errors", () => {
  const { input, proposal } = fixture();
  const expected = input.normalizeResponse(JSON.stringify(proposal));
  proposal.groups.push(structuredClone(proposal.groups[0]));
  assert.equal(input.normalizeResponse(JSON.stringify(proposal)), expected);
  proposal.groups.at(-1)!.title = "A conflicting content identity";
  assert.throws(
    () => input.normalizeResponse(JSON.stringify(proposal)),
    (e: any) =>
      e.reason === "duplicateGroupIdentity" &&
      e.feedback.issues[0].reference === "a",
  );
});

test("allocation correction reports all empty declarations and explicitly repairs affected units only", async () => {
  const { input, units, proposal, files } = fixture();
  proposal.allocations[units[1][0]].overrides = [];
  const seen: string[] = [];
  const result = await analyzeOrganization({
    input,
    files,
    task: input.task("", "en"),
    signal: new AbortController().signal,
    request: async (task) => {
      seen.push(task.name);
      if (seen.length === 1) return { text: JSON.stringify(proposal) };
      if (seen.length === 2) {
        assert.equal(task.name, "tamki_organization_allocation_revision");
        assert(task.prompt.includes('"reason":"emptyGroup"'));
        assert(task.prompt.includes('"reference":"b"'));
        return {
          text: JSON.stringify({
            removeGroupIds: [],
            groups: [],
            allocations: {
              ...Object.fromEntries(units.map(([id]) => [id, null])),
              [units[1][0]]: {
                groupId: "a",
                overrides: [{ fileId: "f3", groupId: "b" }],
              },
            },
            replaceCollections: false,
            collections: [],
          }),
        };
      }
      assert.equal(task.name, "tamki_organization_allocation_review");
      return {
        text: JSON.stringify({
          removeGroupIds: [],
          groups: [],
          allocations: Object.fromEntries(units.map(([id]) => [id, null])),
          replaceCollections: false,
          collections: [],
        }),
      };
    },
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(
    result.groups.map((g) => g.fileIds),
    [["physical-0", "physical-1", "physical-3"], ["physical-2"]],
  );
});

test("allocation transactions cannot discard unknown identities or silently ignore collection edits", () => {
  const { input, units, proposal } = fixture();
  const tx = input.allocationRevision(
    input.task("", "en"),
    JSON.stringify(proposal),
    { issues: [], missing: [], duplicates: [] },
  )!;
  const patch = {
    removeGroupIds: [],
    groups: [],
    allocations: Object.fromEntries(units.map(([id]) => [id, null])),
    replaceCollections: false,
    collections: [],
  };
  const schema = tx.task.schema as any;
  const slots = schema.properties.groups;
  assert.deepEqual(
    slots.required,
    [...new Set(proposal.groups.map((g) => g.identity))],
    "hosted output addresses only current draft identities, once each",
  );
  assert.equal(slots.type, "object");
  assert.equal(slots.additionalProperties, false);
  assert.equal(schema.properties.removeGroupIds, undefined);
  assert.equal(schema.properties.addedGroups.type, "array");
  // Legacy fixtures are still parsed strictly, but that shape is not advertised.
  for (const changes of [
    { removeGroupIds: ["foreign"] },
    { collections: [{ name: "Ignored", groupIds: ["a", "b"] }] },
    { allocations: [{ unitId: "foreign", groupId: "a", overrides: [] }] },
  ])
    assert.throws(
      () => tx.merge(JSON.stringify({ ...patch, ...changes })),
      /organizationInvalid/,
    );
});

test("keyed work revisions explicitly keep, replace, remove and add declarations without moving unrelated files", () => {
  const { input, units, proposal, tx, replacements, keep, decode } =
    transactionFixture();
  const before = structuredClone(proposal);
  assert.deepEqual(
    decode(keep),
    input.decode(input.normalizeResponse(JSON.stringify(proposal))),
  );
  const patch = {
    ...keep,
    groups: {
      a: {
        ...replacements.a,
        title: "Revised title",
        review: true,
        reason: "A stated review decision.",
      },
      b: "remove",
    },
    addedGroups: [{ identity: "new-work", ...replacements.b }],
    allocations: {
      ...keep.allocations,
      [units[1][0]]: {
        groupId: "a",
        overrides: [{ fileId: "f3", groupId: "new-work" }],
      },
    },
    replaceCollections: true,
    collections: [{ name: "Related", groupIds: ["a", "new-work"] }],
  };
  const merged = JSON.parse(tx.merge(JSON.stringify(patch)));
  assert.deepEqual(
    merged.allocations[units[0][0]],
    proposal.allocations[units[0][0]],
  );
  assert.deepEqual(
    merged.allocations[units[2][0]],
    proposal.allocations[units[2][0]],
  );
  const result = decode(patch);
  assert.deepEqual(
    result.groups.map((g) => [g.identity, g.fileIds]),
    [
      ["a", ["physical-0", "physical-1", "physical-3"]],
      ["new-work", ["physical-2"]],
    ],
  );
  assert.equal(result.groups[0].title, "Revised title");
  assert.equal(result.groups[0].review, true);
  assert.deepEqual(result.collections, patch.collections);
  assert.deepEqual(
    proposal,
    before,
    "Merging must not mutate the original draft",
  );
});

test("each existing work requires exactly one operation and unknown or mixed operation shapes are rejected", () => {
  const { tx, replacements, keep } = transactionFixture();
  const schema = tx.task.schema as any;
  const resolve = (node: any): any =>
    node.$ref ? resolve(schema.$defs[node.$ref.split("/").at(-1)]) : node;
  const variants = resolve(schema.properties.groups.properties.a).anyOf.map(
    resolve,
  );
  assert.deepEqual(
    variants.map((v: any) => v.type),
    ["null", "string", "object"],
  );
  assert.equal(variants[1].const, "remove");
  assert.equal(variants[2].properties.identity, undefined);
  assert.equal(variants[2].additionalProperties, false);
  for (const changes of [
    { groups: { a: null } },
    { groups: { ...keep.groups, foreign: null } },
    { groups: { ...keep.groups, a: ["remove", replacements.a] } },
    { groups: { ...keep.groups, a: { ...replacements.a, identity: "a" } } },
    { groups: { ...keep.groups, a: { ...replacements.a, remove: true } } },
    { removeGroupIds: ["a"] },
    { groups: [], removeGroupIds: [] },
    { allocations: { ...keep.allocations, foreign: null } },
  ])
    assert.throws(
      () => tx.merge(JSON.stringify({ ...keep, ...changes })),
      /organizationInvalid/,
    );
  // Escaped spelling is the same JSON key, not permission for a second action.
  const duplicateKey = JSON.stringify(keep).replace(
    '"a":null',
    '"a":null,"\\u0061":"remove"',
  );
  assert.throws(
    () => tx.merge(duplicateKey),
    (e: any) =>
      e.reason === "revisionOperation" &&
      e.feedback.issues[0].reference === "a",
  );
});

test("added declarations cannot collide with existing identities or each other, including removed identities", () => {
  const { tx, replacements, keep } = transactionFixture();
  for (const existingOperation of [null, "remove", replacements.a])
    assert.throws(
      () =>
        tx.merge(
          JSON.stringify({
            ...keep,
            groups: { ...keep.groups, a: existingOperation },
            addedGroups: [{ identity: "a", ...replacements.a }],
          }),
        ),
      (e: any) =>
        e.reason === "revisionOperation" &&
        e.feedback.issues[0].field === "addedGroups.0.identity",
    );
  for (const reason of ["", "Conflicting explanation"])
    assert.throws(
      () =>
        tx.merge(
          JSON.stringify({
            ...keep,
            addedGroups: [
              { identity: "new-work", ...replacements.a },
              { identity: "new-work", ...replacements.a, reason },
            ],
          }),
        ),
      (e: any) =>
        e.reason === "revisionOperation" &&
        e.feedback.issues[0].field === "addedGroups.1.identity",
    );
});

test("keyed work transactions do not repair dangling file ownership, unused declarations or stale collection edges", () => {
  const { units, replacements, keep, decode } = transactionFixture();
  assert.throws(
    () => decode({ ...keep, groups: { ...keep.groups, b: "remove" } }),
    (e: any) => e.reason === "unknownReference",
  );
  assert.throws(
    () =>
      decode({
        ...keep,
        addedGroups: [{ identity: "unused", ...replacements.a }],
      }),
    (e: any) => e.reason === "emptyGroup",
  );
  const moveRemovedMember = {
    ...keep,
    groups: { ...keep.groups, b: "remove" },
    allocations: {
      ...keep.allocations,
      [units[1][0]]: { groupId: "a", overrides: [] },
    },
  };
  assert.throws(
    () => decode(moveRemovedMember),
    (e: any) => e.reason === "unknownCollectionGroup",
  );
  for (const overrides of [
    [{ fileId: "f1", groupId: "b" }],
    [
      { fileId: "f3", groupId: "b" },
      { fileId: "f3", groupId: "a" },
    ],
  ])
    assert.throws(
      () =>
        decode({
          ...keep,
          allocations: {
            ...keep.allocations,
            [units[1][0]]: { groupId: "a", overrides },
          },
        }),
      (e: any) => e.reason === "allocation",
    );
});

test("keyed corrections reject semantic no-ops while permitting explicit unresolved-review decisions", () => {
  const { units, proposal, tx, replacements, keep } = transactionFixture();
  for (const changes of [
    {},
    { groups: { ...keep.groups, a: replacements.a } },
    {
      groups: {
        ...keep.groups,
        a: { ...replacements.a, order: ["f1", "f2", "f4"] },
      },
    },
    {
      allocations: {
        ...keep.allocations,
        [units[0][0]]: proposal.allocations[units[0][0]],
      },
    },
    {
      replaceCollections: true,
      collections: proposal.collections.map((c) => ({
        ...c,
        groupIds: [...c.groupIds].reverse(),
      })),
    },
  ])
    assert.throws(
      () => tx.merge(JSON.stringify({ ...keep, ...changes }), true),
      (e: any) =>
        e.reason === "revisionOperation" && e.field === "emptyCorrection",
    );
  const rename = {
    ...keep,
    groups: { ...keep.groups, a: "remove" },
    addedGroups: [{ identity: "renamed", ...replacements.a }],
    allocations: Object.fromEntries(
      Object.entries(proposal.allocations).map(([unit, a]) => [
        unit,
        {
          groupId: a.groupId === "a" ? "renamed" : a.groupId,
          overrides: a.overrides.map((o) => ({
            ...o,
            groupId: o.groupId === "a" ? "renamed" : o.groupId,
          })),
        },
      ]),
    ),
    replaceCollections: true,
    collections: [{ name: "Related", groupIds: ["renamed", "b"] }],
  };
  assert.throws(
    () => tx.merge(JSON.stringify(rename), true),
    (e: any) => e.field === "emptyCorrection",
  );
  assert.doesNotThrow(() =>
    tx.merge(
      JSON.stringify({
        ...keep,
        groups: {
          ...keep.groups,
          a: {
            ...replacements.a,
            review: true,
            reason:
              "The rejected finding remains unresolved from the evidence.",
          },
        },
      }),
      true,
    ),
  );
});

test("legacy list revisions retain strict collision checks and are not mixed with keyed revisions", () => {
  const { proposal, tx, keep } = transactionFixture();
  const legacy = {
    removeGroupIds: [],
    groups: [],
    allocations: keep.allocations,
    replaceCollections: false,
    collections: [],
  };
  assert.doesNotThrow(() => tx.merge(JSON.stringify(legacy)));
  for (const changes of [
    { removeGroupIds: ["a"], groups: [proposal.groups[0]] },
    { removeGroupIds: ["a", "a"] },
    {
      groups: [
        proposal.groups[0],
        { ...proposal.groups[0], reason: "A conflicting definition" },
      ],
    },
    { addedGroups: [] },
  ])
    assert.throws(
      () => tx.merge(JSON.stringify({ ...legacy, ...changes })),
      /organizationInvalid/,
    );
});

test("an empty correction cannot silently discard an invalid substantive allocation review", async () => {
  const { input, units, proposal, files } = fixture();
  let calls = 0;
  await assert.rejects(
    analyzeOrganization({
      input,
      files,
      task: input.task("", "en"),
      signal: new AbortController().signal,
      request: async () => {
        calls++;
        if (calls === 1) return { text: JSON.stringify(proposal) };
        return {
          text: JSON.stringify({
            removeGroupIds: calls === 2 ? ["foreign"] : [],
            groups: [],
            allocations: Object.fromEntries(units.map(([id]) => [id, null])),
            replaceCollections: false,
            collections: [],
          }),
        };
      },
    }),
    (e: any) =>
      e.reason === "revisionOperation" && e.field === "emptyCorrection",
  );
  assert.equal(calls, 3);
});

test("equivalent nonempty operations cannot discard a rejected review", () => {
  const { input, units, proposal } = fixture();
  const tx = input.allocationRevision(
    input.task("", "en"),
    JSON.stringify(proposal),
    { issues: [], missing: [], duplicates: [] },
  )!;
  const keep = {
    removeGroupIds: [],
    groups: [],
    allocations: Object.fromEntries(units.map(([id]) => [id, null])),
    replaceCollections: false,
    collections: [],
  };
  for (const change of [
    { groups: [proposal.groups[0]] },
    {
      allocations: {
        ...keep.allocations,
        [units[0][0]]: proposal.allocations[units[0][0]],
      },
    },
    {
      replaceCollections: true,
      collections: proposal.collections.map((c) => ({
        ...c,
        groupIds: [...c.groupIds].reverse(),
      })),
    },
    { groups: [{ ...proposal.groups[0], order: ["f1", "f2", "f4"] }] },
  ])
    assert.throws(
      () => tx.merge(JSON.stringify({ ...keep, ...change }), true),
      (e: any) => e.field === "emptyCorrection",
    );
  const renamed = {
    ...keep,
    removeGroupIds: ["a"],
    groups: [{ ...proposal.groups[0], identity: "replacement" }],
    allocations: Object.fromEntries(
      Object.entries(proposal.allocations).map(([id, a]) => [
        id,
        {
          groupId: a.groupId === "a" ? "replacement" : a.groupId,
          overrides: a.overrides.map((o) => ({
            ...o,
            groupId: o.groupId === "a" ? "replacement" : o.groupId,
          })),
        },
      ]),
    ),
    replaceCollections: true,
    collections: proposal.collections.map((c) => ({
      ...c,
      groupIds: c.groupIds.map((id) => (id === "a" ? "replacement" : id)),
    })),
  };
  assert.throws(
    () => tx.merge(JSON.stringify(renamed), true),
    (e: any) => e.field === "emptyCorrection",
  );
  assert.doesNotThrow(() =>
    tx.merge(
      JSON.stringify({
        ...keep,
        groups: [
          {
            ...proposal.groups[0],
            review: true,
            reason:
              "Earlier findings could not be resolved from the available evidence.",
          },
        ],
      }),
      true,
    ),
  );
});
