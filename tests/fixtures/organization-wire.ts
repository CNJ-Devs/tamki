import assert from "node:assert/strict";
import type { StructuredTask } from "../../src/providers/ai-recognition";

// Independent fixture adapters keep test inventories and behavior assertions
// readable while exercising the production wire encoder and decoder.
type Value = Record<string, any>;
export function restoreOrganizationPacket(input: Value): Value {
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

export function columnarFixtureResponse(value: any): any {
  return {
    g: value.groups.map((group: any) => {
      const r: { l: string; k: string }[] = [];
      const indices = new Map<string, number>();
      const columns: { r: number; f: (null | string | string[])[] }[] = [];
      const episodes = group.episodes || [];
      episodes.forEach((episode: any, ei: number) => {
        let cursor = 0;
        episode.versions.forEach((version: any) => {
          const key = JSON.stringify([version.label, version.releaseKey]);
          if (!indices.has(key)) {
            indices.set(key, r.length);
            r.push({ l: version.label, k: version.releaseKey });
          }
          const ri = indices.get(key)!;
          let column = -1;
          for (let i = cursor; i < columns.length; i++)
            if (columns[i].r === ri && columns[i].f[ei] === null) {
              column = i;
              break;
            }
          if (column === -1) {
            column = columns.length;
            columns.push({ r: ri, f: Array(episodes.length).fill(null) });
          }
          columns[column].f[ei] =
            version.fileIds.length === 1
              ? version.fileIds[0]
              : [...version.fileIds];
          cursor = column + 1;
        });
      });
      return {
        i: group.identity,
        t: group.title,
        f: group.fileIds,
        r,
        e: {
          n: episodes.map((e: any) => e.number),
          t: episodes.map((e: any) => e.title),
          v: columns,
        },
        q: group.review,
        m: group.reason,
      };
    }),
    u: value.unassigned,
    c: value.collections.map((c: any) => ({
      ...(c.kind ? { k: c.kind } : {}),
      n: c.name,
      g: c.groupIds,
    })),
  };
}
export const originalWireTasks = new WeakMap<StructuredTask, StructuredTask>();
export function canonicalFixtureTask(task: StructuredTask): StructuredTask {
  if (!Object.hasOwn(task.schema.properties || {}, "g")) return task;
  const input = JSON.parse(task.prompt.split("\n")[1]);
  const packet = restoreOrganizationPacket(input);
  const parts = task.prompt.split("\n");
  parts[1] = JSON.stringify(packet);
  const canonical = { ...task, prompt: parts.join("\n") };
  originalWireTasks.set(canonical, task);
  return canonical;
}
