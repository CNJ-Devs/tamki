import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { StructuredTask } from "../providers/ai-recognition";

type RecordValue = Record<string, unknown>;
type FileRow = [string, string, string, number, number, number | null];
type MetadataEntry = [string, RecordValue];
type LocalFile = [FileRow, MetadataEntry[]];
interface DirectoryBlock extends RecordValue {
  directoryId: string;
  rootDirectoryId: string;
  ancestorPath: string[];
  scanned: boolean;
  filenameAffixes?: [string, string];
  files: LocalFile[];
}

const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): RecordValue => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as RecordValue;
};
const array = (value: unknown): unknown[] => {
  assert(Array.isArray(value));
  return value;
};
const string = (value: unknown): string => {
  assert(typeof value === "string");
  return value;
};
const finite = (value: unknown): number => {
  assert(typeof value === "number" && Number.isFinite(value));
  return value;
};

/** Find the actual first INPUT JSON value, not markers inside escaped data or
 * subsequent user preferences. Keep every other prompt byte unchanged. */
function inputSection(prompt: string) {
  assert(prompt.startsWith("INPUT:\n"), "Missing organization input");
  let start = "INPUT:\n".length;
  while (start < prompt.length && /\s/.test(prompt[start])) start++;
  assert(prompt[start] === "{", "Organization input must be an object");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < prompt.length; i++) {
    const char = prompt[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0)
        return {
          start,
          end: i + 1,
          packet: object(JSON.parse(prompt.slice(start, i + 1))),
        };
    }
  }
  throw new Error("Unterminated organization input");
}

function localEvidence(original: RecordValue): RecordValue {
  assert(
    !Object.hasOwn(original, "directoryBlocks") &&
      !Object.hasOwn(original, "evidenceLocality") &&
      !Object.hasOwn(original, "compactInput"),
    "Reserved input encoding fields",
  );
  const packet = clone(original);
  const directories = array(packet.directories).map(array);
  const byId = new Map<string, unknown[]>();
  for (const row of directories) {
    const id = string(row[0]);
    assert(!byId.has(id), "Duplicate directory reference");
    byId.set(id, row);
  }
  const affixes =
    packet.fileNameAffixes === undefined ? {} : object(packet.fileNameAffixes);
  for (const id of Object.keys(affixes))
    assert(byId.has(id), "Unknown filename affix directory");
  const blocks = directories.map((row): DirectoryBlock => {
    const id = string(row[0]);
    const ancestry: string[] = [];
    const seen = new Set<string>();
    let parent: string | null = id;
    let root = id;
    while (parent !== null) {
      assert(!seen.has(parent), "Cyclic directory ancestry");
      seen.add(parent);
      const ancestor = byId.get(parent);
      assert(ancestor, "Unknown directory parent");
      ancestry.push(string(ancestor[2]));
      root = parent;
      assert(ancestor[1] === null || typeof ancestor[1] === "string");
      parent = ancestor[1];
    }
    assert(typeof row[3] === "boolean");
    const block: DirectoryBlock = {
      directoryId: id,
      rootDirectoryId: root,
      ancestorPath: ancestry.reverse(),
      scanned: row[3],
      files: [],
    };
    if (Object.hasOwn(affixes, id)) {
      const pair = array(affixes[id]);
      assert(pair.length === 2);
      block.filenameAffixes = [string(pair[0]), string(pair[1])];
    }
    return block;
  });
  const byDirectory = new Map(
    blocks.map((block) => [block.directoryId, block]),
  );
  const records = new Map<string, LocalFile>();
  const order = array(packet.files).map((value) => {
    const row = array(value);
    assert(row.length === 6, "Unknown file row layout");
    const id = string(row[0]);
    const directory = string(row[1]);
    assert(!records.has(id), "Duplicate file reference");
    assert(byDirectory.has(directory), "Unknown file directory");
    const file: FileRow = [
      id,
      directory,
      string(row[2]),
      finite(row[3]),
      finite(row[4]),
      row[5] === null ? null : finite(row[5]),
    ];
    records.set(id, [file, []]);
    return id;
  });
  const current = object(packet.current);
  const workIds = new Set<string>();
  for (const value of array(current.works)) {
    const work = object(value);
    const workId = string(work.id);
    assert(!workIds.has(workId), "Duplicate current work reference");
    workIds.add(workId);
    work.files = array(work.files).map((value) => {
      const metadata = clone(object(value));
      const id = string(metadata.id);
      const record = records.get(id);
      assert(record, "Current metadata references an absent file");
      delete metadata.id;
      record[1].push([workId, metadata]);
      return id;
    });
  }
  for (const id of order) {
    const local = records.get(id)!;
    byDirectory.get(local[0][1])!.files.push(local);
  }
  packet.evidenceLocality = {
    version: 1,
    stage: "directories",
    hadFileNameAffixes: Object.hasOwn(original, "fileNameAffixes"),
  };
  packet.files = order;
  delete packet.fileNameAffixes;
  packet.directoryBlocks = blocks;
  return packet;
}

function fileRuns(value: unknown) {
  const runs: [number, number][] = [];
  for (const valueRef of array(value)) {
    const ref = string(valueRef);
    assert(/^f[1-9][0-9]*$/.test(ref), "Invalid file reference");
    const n = Number(ref.slice(1));
    assert(Number.isSafeInteger(n), "Invalid file reference number");
    const previous = runs.at(-1);
    if (previous && n === previous[1] + 1) previous[1] = n;
    else runs.push([n, n]);
  }
  return { fRuns: runs };
}

/** This is a reversible representation change, not filename parsing or content
 * classification. Unknown values, user-authored metadata and list order survive. */
export function compactOrganizationInput(original: unknown): RecordValue {
  const packet = localEvidence(object(original));
  packet.files = fileRuns(packet.files);
  for (const value of array(object(packet.current).works)) {
    const work = object(value);
    work.files = fileRuns(work.files);
  }
  packet.directoryBlocks = (packet.directoryBlocks as DirectoryBlock[]).map(
    ({ files, ...context }) => {
      let modifiedBase = files[0]?.[0][4] ?? 0;
      for (const [row] of files) modifiedBase = Math.min(modifiedBase, row[4]);
      // Very different floating timestamps can lose precision when restored.
      // Zero is an exact fallback; ordinary timestamps retain the tested layout.
      if (
        files.some(([row]) => modifiedBase + (row[4] - modifiedBase) !== row[4])
      )
        modifiedBase = 0;
      const associations = files.map(([, current]) =>
        current.map(([workId]) => workId),
      );
      const currentWorkIds =
        associations.length &&
        associations.every((ids) => isDeepStrictEqual(ids, associations[0]))
          ? associations[0]
          : null;
      const rows = files.map(([row, current]): RecordValue => ({
        id: row[0],
        filenameFragment: row[2],
        sizeBytes: row[3],
        modifiedDelta: row[4] - modifiedBase,
        durationSeconds: row[5],
        current:
          currentWorkIds === null
            ? current
            : currentWorkIds.length === 1
              ? current[0][1]
              : current.map(([, metadata]) => metadata),
      }));
      const columns = [
        "id",
        "filenameFragment",
        "sizeBytes",
        "modifiedDelta",
        "durationSeconds",
        "current",
      ];
      const defaults: RecordValue = {};
      for (const field of ["modifiedDelta", "durationSeconds", "current"])
        if (
          rows.length &&
          rows.every((row) => isDeepStrictEqual(row[field], rows[0][field]))
        ) {
          defaults[field] = clone(rows[0][field]);
          columns.splice(columns.indexOf(field), 1);
        }
      return {
        ...context,
        modifiedBase,
        currentWorkIds,
        fileDefaults: defaults,
        fileColumns: columns,
        files: rows.map((row) => columns.map((column) => row[column])),
      };
    },
  );
  packet.compactInput = { version: 1, extends: "evidence-locality-v1" };
  return packet;
}

// The exact guide used by the retained candidate. Keep it in step with the codec.
export const compactOrganizationInputGuide =
  "Local evidence serialization (compact-input-v1, losslessly extending evidence-locality-v1): INPUT.files and current.works[].files use {fRuns:[[start,end],...]} to express their exact ordered file references; each inclusive run expands to f(start), f(start+1), ..., f(end). Runs are input notation only; output references still follow the output contract. Every directoryBlock retains directoryId, rootDirectoryId, complete ancestorPath, scanned, and optional filenameAffixes=[prefix,suffix]. Each block's fileColumns names the columns of its files rows; fileDefaults supplies columns omitted from every row. The original filename is prefix + filenameFragment + suffix (absent affixes are empty). A file's directoryId is the containing block's directoryId; modified = block.modifiedBase + modifiedDelta. durationSeconds=null means unknown. For current metadata: currentWorkIds=null means row.current is the original list of [workId,metadata] pairs; one currentWorkIds entry means row.current is that work's metadata object; zero or multiple entries means row.current is an aligned array of metadata objects. Add the file's id to a current metadata object to reconstruct its current-file record. INPUT.current.fileDefaults still supplies omitted metadata fields. Current metadata remains beside its file; the complete directory table and all directory blocks, including empty/unread boundaries, remain present.";

export function compactOrganizationTask(task: StructuredTask): StructuredTask {
  const section = inputSection(task.prompt);
  const packet = compactOrganizationInput(section.packet);
  const system = /^File rows:[^\n]*$/m.test(task.system)
    ? task.system.replace(/^File rows:[^\n]*$/m, compactOrganizationInputGuide)
    : `${task.system}\n\n${compactOrganizationInputGuide}`;
  return {
    ...task,
    system,
    prompt:
      task.prompt.slice(0, section.start) +
      JSON.stringify(packet) +
      task.prompt.slice(section.end),
  };
}
