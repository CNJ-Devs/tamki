import test from "node:test";
import assert from "node:assert/strict";
import {
  OrganizationInput,
  OrganizationOutputError,
} from "../src/library/organization-input";
import { analyzeOrganization } from "../src/library/organization-analysis";
import { normalizeOrganizationCollections } from "../src/library/organization-output";
import type { StructuredTask } from "../src/providers/ai-recognition";

const group = (identity: string, fileIds: string[]) => ({
  identity,
  title: identity,
  fileIds,
  review: false,
  reason: "",
});
const patch = (value: object = {}) => ({
  removeGroupIds: [],
  groups: [],
  replaceCollections: false,
  collections: [],
  replaceUnassigned: false,
  unassigned: [],
  ...value,
});
function fixture() {
  const files = [1, 2, 3, 4, 5].map((i) => ({
    id: `physical-${i}`,
    connectionId: "storage",
    root: "/library",
    path: `/library/Work/${i}.mp4`,
    relativePath: `Work/${i}.mp4`,
    name: `${i}.mp4`,
    size: 10,
    modified: 1,
    duration: null,
  }));
  const input = new OrganizationInput(
    files,
    [],
    { works: [], collections: [] },
    [{ connectionId: "storage", path: "/library", depth: 2 }],
  );
  return {
    input,
    files,
    task: input.task("", "en"),
    signal: new AbortController().signal,
  };
}

test("all mechanical errors are reported together and complete corrections precede content review", async () => {
  const f = fixture();
  const original = {
    groups: [group("first", ["f1", "f2"]), group("second", ["f3"])],
    collections: [{ name: "Series", groupIds: ["first", "first", "unknown"] }],
    unassigned: [],
  };
  const inspected = f.input.inspect(JSON.stringify(original));
  assert.deepEqual(inspected.feedback.missing, ["f4", "f5"]);
  assert.deepEqual(
    inspected.feedback.issues.map((i) => i.reason),
    ["coverage", "duplicateCollectionMember", "unknownCollectionGroup"],
  );
  const tasks: StructuredTask[] = [];
  const result = await analyzeOrganization({
    ...f,
    request: async (task) => {
      tasks.push(task);
      assert.equal(JSON.parse(task.prompt.split("\n")[1]).files.length, 5);
      if (tasks.length === 1) return { text: JSON.stringify(original) };
      if (tasks.length === 2) {
        // Identical collection members are canonicalized before feedback.
        assert(!task.prompt.includes('"duplicateCollectionMember"'));
        assert(task.prompt.includes('"unknownCollectionGroup"'));
        return {
          text: JSON.stringify({
            groups: [...original.groups, group("third", ["f4"])],
            collections: [
              { name: "Series", groupIds: ["first", "second", "third"] },
            ],
            unassigned: [],
          }),
        };
      }
      if (tasks.length === 3) {
        const retained = JSON.parse(
          JSON.parse(
            task.prompt
              .split("\nPREVIOUS PROPOSAL:\n")[1]
              .split("\nVALIDATION ERRORS:")[0],
          ),
        );
        assert(
          retained.groups.some(
            (g: { identity: string }) => g.identity === "third",
          ),
        );
        return {
          text: JSON.stringify({
            ...retained,
            groups: [...original.groups, group("third", ["f4", "f5"])],
          }),
        };
      }
      assert.equal(task.name, "tamki_organization_review");
      // The content reviewer removes an unsupported relationship, not its work.
      return {
        text: JSON.stringify(
          patch({
            replaceCollections: true,
            collections: [{ name: "Series", groupIds: ["first", "second"] }],
          }),
        ),
      };
    },
  });
  assert.equal(tasks.length, 4);
  assert.deepEqual(
    result.groups.map((g) => g.identity),
    ["first", "second", "third"],
  );
  assert.equal(result.groups.flatMap((g) => g.fileIds).length, 5);
  assert.equal(result.groups[0].title, "first");
  assert.deepEqual(result.collections[0].groupIds, ["first", "second"]);
});

test("invalid JSON uses full replacement before returning to revision review", async () => {
  const f = fixture();
  let count = 0;
  const result = await analyzeOrganization({
    ...f,
    request: async (task) => {
      count++;
      if (count === 1) return { text: "broken JSON" };
      if (count === 2) {
        assert.equal(task.name, "tamki_organization");
        assert(task.prompt.includes('"reason":"json"'));
        return {
          text: JSON.stringify({
            groups: [group("work", ["d1"])],
            collections: [],
            unassigned: [],
          }),
        };
      }
      return { text: JSON.stringify(patch()) };
    },
  });
  assert.equal(count, 3);
  assert.equal(result.groups[0].fileIds.length, 5);
});

test("an invalid review retains its prior draft for one correction and never silently passes", async () => {
  for (const succeeds of [true, false]) {
    const f = fixture();
    let count = 0;
    const run = analyzeOrganization({
      ...f,
      request: async (task) => {
        count++;
        if (count === 1)
          return {
            text: JSON.stringify({
              groups: [group("retained", ["d1"])],
              collections: [],
              unassigned: [],
            }),
          };
        if (count === 3) {
          assert(task.prompt.includes("REJECTED REVISION"));
          assert(task.prompt.includes('"reason":"revisionOperation"'));
          assert(task.prompt.includes("retained"));
          if (succeeds)
            return {
              text: JSON.stringify({
                groups: [
                  {
                    ...group("retained", ["d1"]),
                    review: true,
                    reason: "Identity requires confirmation",
                  },
                ],
                collections: [],
                unassigned: [],
              }),
            };
        }
        return {
          text: JSON.stringify(patch({ removeGroupIds: ["invented"] })),
        };
      },
    });
    if (succeeds) {
      const result = await run;
      assert.equal(result.groups[0].review, true);
      assert.equal(result.groups[0].fileIds.length, 5);
    } else await assert.rejects(run, /organizationInvalid/);
    assert.equal(count, 3);
  }
});

test("cancel during content review stops without correction requests", async () => {
  const f = fixture(),
    controller = new AbortController();
  let count = 0;
  await assert.rejects(
    analyzeOrganization({
      ...f,
      signal: controller.signal,
      request: async (task) => {
        count++;
        if (task.name === "tamki_organization_review") {
          controller.abort();
          return { text: JSON.stringify(patch()) };
        }
        return {
          text: JSON.stringify({
            groups: [group("work", ["d1"])],
            collections: [],
            unassigned: [],
          }),
        };
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(count, 2);
});

test("revision operations are explicit and resulting missing coverage cannot be accepted", () => {
  const f = fixture();
  const draft = JSON.stringify({
    groups: [group("first", ["f1"]), group("second", ["f2", "f3", "f4", "f5"])],
    collections: [],
    unassigned: [],
  });
  assert.throws(
    () =>
      f.input.mergeRevision(
        draft,
        JSON.stringify(
          patch({
            collections: [{ name: "ignored", groupIds: ["first", "second"] }],
          }),
        ),
      ),
    /organizationInvalid/,
  );
  const conflicting = f.input.mergeRevision(
    draft,
    JSON.stringify(
      patch({ groups: [group("first", ["f1"]), group("first", ["f2"])] }),
    ),
  );
  assert.equal(JSON.parse(conflicting).groups.length, 3);
  assert.equal(JSON.parse(conflicting).groups[2].identity, "second");
  assert.throws(() => f.input.decode(conflicting), /organizationInvalid/);
  const resolved = f.input.mergeRevision(
    conflicting,
    JSON.stringify(patch({ groups: [group("first", ["f1"])] })),
  );
  assert.equal(
    f.input.decode(resolved).groups.flatMap((g) => g.fileIds).length,
    5,
  );
  const merged = f.input.mergeRevision(
    draft,
    JSON.stringify(patch({ removeGroupIds: ["first"] })),
  );
  assert.throws(
    () => f.input.decode(merged),
    (error: unknown) =>
      error instanceof OrganizationOutputError &&
      error.feedback.missing[0] === "f1",
  );
});

test("collection references accept the same identity length as their work definitions", () => {
  const f = fixture();
  const identity = "a".repeat(180);
  const result = f.input.decode(
    JSON.stringify({
      groups: [
        group(identity, ["f1"]),
        group("other", ["f2", "f3", "f4", "f5"]),
      ],
      collections: [{ name: "Related", groupIds: [identity, "other"] }],
      unassigned: [],
    }),
  );
  assert.equal(result.collections[0].groupIds[0], identity);
});

test("collection set normalization never fixes file conflicts or invents a second member", () => {
  const f = fixture();
  const proposal = {
    groups: [group("first", ["f1"]), group("second", ["f2", "f3", "f4", "f5"])],
    collections: [{ name: "Series", groupIds: ["first", "second", "first"] }],
    unassigned: [],
  };
  const normalized = normalizeOrganizationCollections(JSON.stringify(proposal));
  assert.equal(normalized.removed, 1);
  assert.deepEqual(f.input.decode(normalized.text).collections[0].groupIds, [
    "first",
    "second",
  ]);
  proposal.groups[1].fileIds.push("f1");
  assert.throws(
    () =>
      f.input.decode(
        normalizeOrganizationCollections(JSON.stringify(proposal)).text,
      ),
    (error: unknown) =>
      error instanceof OrganizationOutputError &&
      error.feedback.duplicates[0] === "f1",
  );
  proposal.groups[1].fileIds.pop();
  proposal.collections[0].groupIds = ["first", "first"];
  assert.throws(
    () =>
      f.input.decode(
        normalizeOrganizationCollections(JSON.stringify(proposal)).text,
      ),
    (error: unknown) =>
      error instanceof OrganizationOutputError &&
      error.reason === "duplicateCollectionMember",
  );
});

test("a degenerate collection requires explicit correction before content review", async () => {
  const f = fixture();
  let count = 0;
  const complete = {
    groups: [group("work", ["d1"])],
    collections: [],
    unassigned: [],
  };
  const result = await analyzeOrganization({
    ...f,
    request: async (task) => {
      count++;
      if (count === 1)
        return {
          text: JSON.stringify({
            ...complete,
            collections: [
              { name: "Not a relationship", groupIds: ["work", "work"] },
            ],
          }),
        };
      if (count === 2) {
        assert.equal(task.name, "tamki_organization");
        assert(task.prompt.includes('"insufficientCollectionMembers"'));
        return { text: JSON.stringify(complete) };
      }
      assert.equal(task.name, "tamki_organization_review");
      return { text: JSON.stringify(patch()) };
    },
  });
  assert.equal(count, 3);
  assert.equal(result.groups[0].fileIds.length, 5);
  assert.deepEqual(result.collections, []);
});
