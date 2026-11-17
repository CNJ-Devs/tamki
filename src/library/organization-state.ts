import { createHash } from "node:crypto";
import type { OrganizationContext } from "../shared/organization";

/** Semantic state only. Playback and artwork caches cannot invalidate a review. */
export interface OrganizationStateFile {
  id: string;
  connectionId: string;
  path: string;
  workId: string;
  size: number;
  modified: number;
  signature: string;
}
export interface OrganizationSnapshot {
  files: Record<string, OrganizationStateFile>;
  works: Record<string, string>;
  roots: Record<string, string>;
  relationships?: { id: string; workIds: string[] }[];
}
export interface OrganizationStateChanges {
  added: OrganizationStateFile[];
  removed: OrganizationStateFile[];
  modified: OrganizationStateFile[];
  changedWorkIds: string[];
  rootsChanged: boolean;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const semantic = (value: Record<string, unknown>, omitted: string[]) =>
  Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !omitted.includes(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
export function organizationSnapshot(
  works: Record<string, unknown>[],
  files: Record<string, unknown>[],
  structures: Record<string, unknown>[],
  roots: { connectionId: string; path: string; depth: number }[],
  locks: Record<string, Record<string, boolean>>,
  relationshipEdits: OrganizationContext["relationshipEdits"] = [],
): OrganizationSnapshot {
  const visible = works.filter((w) => !w.excluded);
  const workIds = new Set(visible.map((w) => String(w.id)));
  const members = (s: Record<string, unknown>) => [
    ...((s.workIds as string[]) || []),
    ...((s.seriesIds as string[]) || []).flatMap(
      (id) =>
        (structures.find((p) => p.kind === "series" && p.id === id)
          ?.workIds as string[]) || [],
    ),
  ];
  return {
    files: Object.fromEntries(
      files
        .filter((f) => !f.excluded && workIds.has(String(f.workId)))
        .map((f) => [
          String(f.id),
          {
            id: String(f.id),
            connectionId: String(f.connectionId),
            path: String(f.path),
            workId: String(f.workId),
            size: Number(f.size),
            modified: Number(f.modified),
            signature: hash(
              semantic(f, [
                "position",
                "duration",
                "cover",
                "artworkSource",
                "artworkError",
              ]),
            ),
          },
        ]),
    ),
    works: Object.fromEntries(
      visible.map((w) => [
        String(w.id),
        hash({
          work: semantic(w, [
            "recognition",
            "resumeId",
            "preferredVersionKey",
            "cover",
            "captureSource",
          ]),
          locks: Object.fromEntries(
            Object.entries(locks[String(w.id)] || {})
              .filter(([key]) => !key.endsWith(":cover"))
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
          memberships: structures
            .filter((s) => members(s).includes(String(w.id)))
            .map((s) => ({
              id: s.id,
              kind: s.kind,
              name: s.name,
              memberOrder: (s.workIds as string[]).indexOf(String(w.id)),
              seriesIds: s.seriesIds,
            }))
            .sort((a, b) => String(a.id).localeCompare(String(b.id))),
          ...(relationshipEdits.some((e) => e.workIds.includes(String(w.id)))
            ? {
                relationshipEdits: relationshipEdits
                  .filter((e) => e.workIds.includes(String(w.id)))
                  .sort((a, b) =>
                    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
                  ),
              }
            : {}),
        }),
      ]),
    ),
    relationships: structures.map((s) => ({
      id: String(s.kind) + ":" + String(s.id),
      workIds: [...new Set(members(s))],
    })),
    roots: Object.fromEntries(
      roots.map((r) => [JSON.stringify([r.connectionId, r.path]), hash(r)]),
    ),
  };
}
export function organizationStateChanges(
  before: OrganizationSnapshot,
  after: OrganizationSnapshot,
): OrganizationStateChanges {
  return {
    added: Object.values(after.files).filter((f) => !before.files[f.id]),
    removed: Object.values(before.files).filter((f) => !after.files[f.id]),
    modified: Object.values(before.files).filter(
      (f) => after.files[f.id] && f.signature !== after.files[f.id].signature,
    ),
    changedWorkIds: Object.keys(before.works).filter(
      (id) => before.works[id] !== after.works[id],
    ),
    rootsChanged: Object.keys(before.roots).some(
      (id) => before.roots[id] !== after.roots[id],
    ),
  };
}
