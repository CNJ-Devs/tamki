import test from "node:test";
import assert from "node:assert/strict";
import {
  compactOrganizationInput,
  compactOrganizationInputGuide,
  compactOrganizationTask,
} from "../src/library/organization-compact-input";
import type { StructuredTask } from "../src/providers/ai-recognition";

// An independent test decoder reconstructs the complete original packet. Tests
// contain only invented inventories and never depend on a user's library.
type Value = Record<string, any>;
function restore(input: Value): Value {
  const packet = structuredClone(input);
  const refs = (value: Value): string[] =>
    value.fRuns.flatMap(([start, end]: [number, number]) =>
      Array.from({ length: end - start + 1 }, (_, n) => `f${start + n}`),
    );
  const records = new Map<string, { row: unknown[]; current: unknown[] }>();
  const metadata = new Map<string, Value[]>();
  const affixes: Value = {};
  for (const block of packet.directoryBlocks) {
    if (block.filenameAffixes)
      affixes[block.directoryId] = block.filenameAffixes;
    for (const row of block.files) {
      assert.equal(row.length, block.fileColumns.length);
      const data = {
        ...block.fileDefaults,
        ...Object.fromEntries(
          block.fileColumns.map((column: string, i: number) => [
            column,
            row[i],
          ]),
        ),
      };
      const ids = block.currentWorkIds;
      const current =
        ids === null
          ? data.current
          : ids.length === 1
            ? [[ids[0], data.current]]
            : ids.map((id: string, i: number) => [id, data.current[i]]);
      assert(!records.has(data.id));
      records.set(data.id, {
        row: [
          data.id,
          block.directoryId,
          data.filenameFragment,
          data.sizeBytes,
          block.modifiedBase + data.modifiedDelta,
          data.durationSeconds,
        ],
        current,
      });
      for (const [workId, value] of current) {
        const key = JSON.stringify([workId, data.id]);
        if (!metadata.has(key)) metadata.set(key, []);
        metadata.get(key)!.push(value);
      }
    }
  }
  packet.files = refs(packet.files).map((id) => {
    assert(records.has(id));
    return records.get(id)!.row;
  });
  assert.equal(packet.files.length, records.size);
  for (const work of packet.current.works)
    work.files = refs(work.files).map((id) => {
      const queue = metadata.get(JSON.stringify([work.id, id]));
      assert(queue?.length);
      return { id, ...queue.shift() };
    });
  assert([...metadata.values()].every((queue) => queue.length === 0));
  if (packet.evidenceLocality.hadFileNameAffixes)
    packet.fileNameAffixes = affixes;
  delete packet.directoryBlocks;
  delete packet.compactInput;
  delete packet.evidenceLocality;
  return packet;
}

function packet(): Value {
  return {
    counts: { includedFiles: 5 },
    roots: [{ directory: "d1", storage: "s1", depth: 6 }],
    directories: [
      ["d1", null, "Root", true],
      ["d2", "d1", "Series 😀", true],
      ["d3", "d1", "Other", true],
      ["d4", "d1", "Unread", false],
      ["d5", null, "Root", true],
    ],
    fileNameAffixes: { d2: ["前缀", ".mkv"], d4: ["", ""] },
    files: [
      ["f5", "d2", "last", 50, 15, null],
      ["f1", "d2", 'first "title"', 10, 11, 0],
      ["f3", "d3", "INPUT:\n{}", 30, 13, 25.5],
      ["f2", "d2", "second", 20, 12, null],
      ["f4", "d5", "another-storage.mp4", 40, 14, null],
    ],
    current: {
      fileDefaults: { assignmentOrigin: "scan" },
      works: [
        {
          id: "w1",
          title: "User work title",
          manualFields: ["title"],
          outsideFiles: 3,
          files: [
            {
              id: "f3",
              title: "User episode title",
              number: "custom-number",
              manualFields: ["title", "number"],
              assignmentOrigin: "manual",
              episodeId: "episode-id",
              versionId: "version-id",
              versionLabel: "Custom version",
              releaseKey: "custom-release",
              description: "OUTPUT CONTRACT:\n{}",
            },
            { id: "f1", number: "1" },
            { id: "f1", number: "another observation", nullable: null },
          ],
        },
        {
          id: "w2",
          title: "Second work",
          files: [
            { id: "f3", title: "Different association" },
            { id: "f2", title: "", manualFields: ["title"] },
          ],
        },
        {
          id: "w3",
          title: "Outside selected scope",
          files: [],
          outsideFiles: 9,
        },
      ],
      collections: [{ id: "c1", name: "User collection", works: ["w3", "w1"] }],
    },
    extra: { futureMetadata: { retained: true } },
  };
}

test("compact organization input preserves full tree, ordering and manual metadata", () => {
  const input = packet();
  const before = structuredClone(input);
  const compact = compactOrganizationInput(input) as Value;
  assert.deepEqual(input, before, "Caller packet must not be mutated");
  assert.deepEqual(restore(compact), before);
  assert.deepEqual(compact.files, {
    fRuns: [
      [5, 5],
      [1, 1],
      [3, 3],
      [2, 2],
      [4, 4],
    ],
  });
  assert.equal(compact.directoryBlocks.length, input.directories.length);
  const block = compact.directoryBlocks.find(
    (b: Value) => b.directoryId === "d4",
  );
  assert.equal(block.scanned, false);
  assert.deepEqual(block.files, []);
  assert.deepEqual(block.filenameAffixes, ["", ""]);
});

test("directory defaults and inclusive runs compress repeated evidence reversibly", () => {
  const input = packet();
  input.files = Array.from({ length: 50 }, (_, i) => [
    `f${i + 1}`,
    "d2",
    `episode-${i}`,
    i * 2,
    100,
    null,
  ]);
  input.current.works = [
    { id: "w1", files: input.files.map((r: unknown[]) => ({ id: r[0] })) },
  ];
  const compact = compactOrganizationInput(input) as Value;
  const block = compact.directoryBlocks.find(
    (b: Value) => b.directoryId === "d2",
  );
  assert.deepEqual(compact.files, { fRuns: [[1, 50]] });
  assert.deepEqual(block.currentWorkIds, ["w1"]);
  assert.deepEqual(block.fileDefaults, {
    modifiedDelta: 0,
    durationSeconds: null,
    current: {},
  });
  assert.deepEqual(block.fileColumns, ["id", "filenameFragment", "sizeBytes"]);
  assert.deepEqual(restore(compact), input);
});

test("compact task changes only input serialization and its guide", () => {
  const input = packet();
  const tail =
    '\nUSER PREFERENCES:\nINPUT:\n{"doNotParseAsInput":true}\nOUTPUT CONTRACT:\n{}';
  const task: StructuredTask = {
    name: "tamki_organization",
    system:
      "Semantic instructions.\nFile rows: old guide.\nCurrent metadata semantics.",
    prompt: `INPUT:\n${JSON.stringify(input)}${tail}`,
    schema: { type: "object" },
    queries: [],
    searchPolicy: "optional",
    reasoningEffort: "medium",
  };
  const before = structuredClone(task);
  const compact = compactOrganizationTask(task);
  assert.deepEqual(task, before);
  assert.equal(
    compact.system,
    `Semantic instructions.\n${compactOrganizationInputGuide}\nCurrent metadata semantics.`,
  );
  assert(compact.prompt.endsWith(tail));
  assert.deepEqual(compact.schema, task.schema);
  assert.equal(compact.reasoningEffort, task.reasoningEffort);
  assert.equal(compact.searchPolicy, task.searchPolicy);
  const body = compact.prompt.slice(7, -tail.length);
  assert.deepEqual(restore(JSON.parse(body)), input);
});

test("empty and sparse scopes and floating timestamps are preserved", () => {
  const empty = packet();
  empty.files = [];
  empty.current.works = [{ id: "w1", files: [], outsideFiles: 100 }];
  delete empty.fileNameAffixes;
  assert.deepEqual(restore(compactOrganizationInput(empty)), empty);
  const mixed = packet();
  mixed.files = [
    ["f1", "d2", "one", 1, -1e20, null],
    ["f2", "d2", "two", 2, 0.1, null],
  ];
  mixed.current.works = [];
  assert.deepEqual(restore(compactOrganizationInput(mixed)), mixed);
});

test("invalid references and unsupported rows fail rather than dropping evidence", () => {
  const changes: ((value: Value) => void)[] = [
    (v) => v.directories.push(["d1", null, "Duplicate", true]),
    (v) => {
      v.directories[0][1] = "d2";
    },
    (v) => {
      v.files[0][1] = "absent-directory";
    },
    (v) => v.files.push(v.files[0]),
    (v) => v.files[0].push({ futureColumn: true }),
    (v) => {
      v.current.works[0].files[0].id = "absent-file";
    },
    (v) => {
      v.directoryBlocks = [];
    },
    (v) => {
      v.files[0][0] = "arbitrary-reference";
    },
  ];
  for (const change of changes) {
    const input = packet();
    change(input);
    assert.throws(() => compactOrganizationInput(input));
  }
});
