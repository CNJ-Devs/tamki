import { createHash } from "node:crypto";
import type {
  OrganizationFile,
  OrganizationDelta,
  OrganizationReviewedFile,
  OrganizationGroup,
} from "../shared/organization";
import type { OrganizationSnapshot } from "./organization-state";
export interface OrganizationCheckpoint {
  version: 1;
  reviewedAt: number;
  acceptedGroups?: OrganizationGroup[];
  pendingFileIds?: string[];
  files: Record<string, OrganizationReviewedFile & { signature: string }>;
}
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const organizationScopeKey = (
  scopes: { connectionId: string; path: string; depth: number }[],
) =>
  digest(
    [...scopes].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  );
export function reviewedOrganizationFiles(
  files: OrganizationFile[],
  state: OrganizationSnapshot,
) {
  const byPath = new Map(
    Object.values(state.files).map((f) => [
      JSON.stringify([f.connectionId, f.path]),
      f,
    ]),
  );
  return Object.fromEntries(
    files.map((f) => {
      const raw = byPath.get(JSON.stringify([f.connectionId, f.path]));
      return [
        f.id,
        {
          ...f,
          workId: raw?.workId || f.workId,
          episodeId: raw?.id || f.episodeId,
          signature: digest([
            f.size,
            f.modified,
            raw?.signature || null,
            raw ? state.works[raw.workId] : null,
          ]),
        },
      ];
    }),
  );
}
export function organizationDelta(
  inventory: OrganizationFile[],
  state: OrganizationSnapshot,
  checkpoint: OrganizationCheckpoint | undefined,
  incremental: boolean,
): { delta: OrganizationDelta; files: OrganizationFile[] } {
  const now = reviewedOrganizationFiles(inventory, state),
    previous = checkpoint?.files || {};
  const added = inventory.filter((f) => !previous[f.id]);
  const modified = inventory.filter(
    (f) => previous[f.id] && previous[f.id].signature !== now[f.id].signature,
  );
  const removed = Object.values(previous).filter((f) => !now[f.id]);
  const touched = new Set(
    [...added, ...modified]
      .map((f) => f.id)
      .concat(checkpoint?.pendingFileIds || []),
  );
  const owners = new Set(
    [
      ...added,
      ...modified,
      ...removed,
      ...inventory.filter((f) => touched.has(f.id)),
    ]
      .map((f) => f.workId)
      .filter(Boolean),
  );
  const files =
    incremental && checkpoint
      ? inventory.filter(
          (f) => touched.has(f.id) || (!!f.workId && owners.has(f.workId)),
        )
      : inventory;
  return {
    files,
    delta: {
      mode: incremental && checkpoint ? "incremental" : "full",
      ...(checkpoint ? { reviewedAt: checkpoint.reviewedAt } : {}),
      totalFiles: inventory.length,
      unchangedFiles: inventory.length - files.length,
      added,
      modified,
      removed,
      pendingFiles: files.length,
    },
  };
}
