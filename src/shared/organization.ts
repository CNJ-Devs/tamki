import { z } from "zod";
import { id, location } from "./validation";

export const organizationFileLimit = 20000;

export const organizeRequestSchema = z
  .object({
    jobId: id,
    connectionId: id,
    model: z.string().min(1).max(200),
    roots: z
      .array(z.object({ connectionId: id, path: location }).strict())
      .min(1)
      .max(100),
    webSearch: z.boolean(),
    instructions: z.string().trim().max(2000),
    mode: z.enum(["incremental", "full"]).optional(),
  })
  .strict();
export type OrganizeRequest = z.infer<typeof organizeRequestSchema>;
export interface OrganizationFile {
  id: string;
  connectionId: string;
  root: string;
  path: string;
  name: string;
  relativePath: string;
  size: number;
  modified: number;
  episodeId?: string;
  workId?: string;
  currentTitle?: string;
  duration: number | null;
}
export interface OrganizationDirectory {
  connectionId: string;
  root: string;
  path: string;
  scanned: boolean;
}
export interface OrganizationContext {
  relationshipEdits?: {
    id: string;
    kind: "series" | "collection";
    action: "saved" | "removed";
    name: string;
    workIds: string[];
    updatedAt: number;
  }[];
  works: {
    id: string;
    title: string;
    description: string;
    tags: string[];
    hasCover: boolean;
    manualFields: string[];
    recognized: boolean;
    files: {
      id: string;
      number: string;
      title: string;
      description: string;
      manual: boolean;
      /** Assignment protection on rescan is distinct from a manual field edit. */
      assignmentOrigin?: "scan" | "manual" | "organization" | "unknown";
      manualFields: string[];
      episodeId?: string;
      versionId?: string;
      versionLabel?: string;
      releaseKey?: string;
    }[];
    outsideFiles: number;
  }[];
  collections: {
    id: string;
    name: string;
    workIds: string[];
    kind?: "series" | "collection";
  }[];
}
export const organizationIdentity = z.string().trim().min(1).max(200);
export const reservedOrganizationIdentity = (value: string) =>
  ["__proto__", "prototype", "constructor"].includes(value);
export const organizationEpisodeSchema = z
  .object({
    number: z.string().max(100),
    title: z.string().max(500),
    versions: z
      .array(
        z
          .object({
            label: z.string().trim().max(200),
            releaseKey: z.string().trim().max(200),
            fileIds: z.array(id).min(1).max(organizationFileLimit),
          })
          .strict(),
      )
      .min(1)
      .max(organizationFileLimit),
  })
  .strict();
export type OrganizationEpisode = z.infer<typeof organizationEpisodeSchema>;
export const organizationGroupsSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            identity: organizationIdentity,
            title: z.string().trim().min(1).max(500),
            fileIds: z.array(id).min(1).max(organizationFileLimit),
            episodes: z
              .array(organizationEpisodeSchema)
              .max(organizationFileLimit)
              .default([]),
            review: z.boolean(),
            reason: z.string().max(1000),
          })
          .strict(),
      )
      .max(2000),
    unassigned: z.array(id).max(organizationFileLimit),
  })
  .strict();
export const organizationCollectionsSchema = z
  .object({
    collections: z
      .array(
        z
          .object({
            kind: z.enum(["series", "collection"]).optional(),
            name: z.string().trim().min(1).max(100),
            groupIds: z.array(organizationIdentity).min(2).max(500),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
// fileIds may use a short file, directory, or existing-work reference. The main
// process expands and validates exact coverage before producing an apply plan.
export const organizationAnalysisSchema = organizationGroupsSchema.extend({
  collections: organizationCollectionsSchema.shape.collections,
});
// Revisions preserve the draft unless the model explicitly replaces a part.
// Every merged proposal must pass the same full validation as an initial result.
export const organizationRevisionSchema = z
  .object({
    removeGroupIds: z.array(organizationIdentity).max(2000),
    groups: organizationGroupsSchema.shape.groups,
    replaceCollections: z.boolean(),
    collections: organizationCollectionsSchema.shape.collections,
    replaceUnassigned: z.boolean(),
    unassigned: organizationGroupsSchema.shape.unassigned,
  })
  .strict();
export interface OrganizationGroup {
  id: string;
  title: string;
  fileIds: string[];
  /** Fully expanded logical episodes in application plans; sparse in AI output. */
  episodes?: OrganizationEpisode[];
  review: boolean;
  reason: string;
  /** Existing membership within the selected scope is unchanged. */
  existingWorkId?: string;
  referenceOnly?: boolean;
  changes?: {
    previousTitles: string[];
    title: boolean;
    membership: boolean;
    order: boolean;
    manual: boolean;
    versions?: boolean;
  };
}
export type OrganizationReviewedFile = OrganizationFile;
export interface OrganizationDelta {
  mode: "incremental" | "full";
  reviewedAt?: number;
  totalFiles: number;
  unchangedFiles: number;
  pendingFiles: number;
  added: OrganizationFile[];
  modified: OrganizationFile[];
  removed: OrganizationReviewedFile[];
}
export interface OrganizationLiveChanges {
  blocked: boolean;
  changedWorkIds: string[];
  added: { id: string; path: string; connectionId: string }[];
  removed: { id: string; path: string; connectionId: string }[];
  modified: { id: string; path: string; connectionId: string }[];
  conflictingGroupIds: string[];
  deferredRemovalIds: string[];
}
export interface OrganizationRelationshipRemoval {
  id: string;
  kind: "series" | "collection";
  name: string;
  workIds: string[];
  seriesIds?: string[];
}
export interface OrganizationPlan {
  relationshipRemovals?: OrganizationRelationshipRemoval[];
  /** Explicit reviewed index exclusions; source media is preserved. */
  fileExclusions?: string[];
  jobId: string;
  delta?: OrganizationDelta;
  liveChanges?: OrganizationLiveChanges;
  reviewSelection?: {
    groups: string[];
    collections: string[];
    names: Record<string, string>;
    acknowledgedRemovals?: string[];
    relationshipRemovals?: string[];
    fileExclusions?: string[];
  };
  scopes?: { connectionId: string; path: string; depth: number }[];
  files: OrganizationFile[];
  groups: OrganizationGroup[];
  collections: (z.infer<
    typeof organizationCollectionsSchema
  >["collections"][number] & {
    id: string;
    existingCollectionId?: string;
    previousName?: string;
    review?: boolean;
  })[];
  unassigned: string[];
  excludedCount: number;
}
export interface OrganizationProgress {
  phase:
    | "scanning"
    | "grouping"
    | "collections"
    | "validating"
    | "reviewing"
    | "ready";
  completed: number;
  total: number;
  files?: number;
  changes?: OrganizationLiveChanges;
}
export const organizationApplySchema = z
  .object({
    jobId: id,
    groups: z
      .array(
        z.object({ id, title: z.string().trim().min(1).max(500) }).strict(),
      )
      .max(organizationFileLimit),
    collectionIds: z.array(id).max(200),
    fileExclusionIds: z
      .array(id)
      .max(organizationFileLimit)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    relationshipRemovalIds: z
      .array(id)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    acknowledgedRemovals: z
      .array(id)
      .max(organizationFileLimit)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
export type OrganizationApply = z.infer<typeof organizationApplySchema>;

/** Fixed diagnostic categories and schema locations only; never payload values. */
export class OrganizationConstraintError extends Error {
  constructor(
    readonly reason:
      | "unknownFile"
      | "duplicateFile"
      | "missingFiles"
      | "duplicateCollectionName"
      | "duplicateCollectionMember"
      | "unknownCollectionGroup",
    readonly field: string,
  ) {
    super("organizationInvalid");
  }
}

export function validateOrganizationGroups(
  value: unknown,
  files: OrganizationFile[],
) {
  const result = organizationGroupsSchema.parse(value);
  const expected = new Set(files.map((f) => f.id)),
    seen = new Set<string>();
  for (const id of [
    ...result.groups.flatMap((g) => g.fileIds),
    ...result.unassigned,
  ]) {
    if (!expected.has(id))
      throw new OrganizationConstraintError("unknownFile", "groups");
    if (seen.has(id))
      throw new OrganizationConstraintError("duplicateFile", "groups");
    seen.add(id);
  }
  if (seen.size !== expected.size)
    throw new OrganizationConstraintError("missingFiles", "groups");
  return result;
}
export function validateOrganizationCollections(
  value: unknown,
  groups: OrganizationGroup[],
) {
  const result = organizationCollectionsSchema.parse(value);
  const allowed = new Set(groups.map((g) => g.id)),
    names = new Set<string>(),
    seriesMembers = new Set<string>();
  for (const [i, collection] of result.collections.entries()) {
    const key = `${collection.kind || "collection"}:${collection.name.toLocaleLowerCase()}`;
    if (names.has(key))
      throw new OrganizationConstraintError(
        "duplicateCollectionName",
        `collections.${i}.name`,
      );
    if (new Set(collection.groupIds).size !== collection.groupIds.length)
      throw new OrganizationConstraintError(
        "duplicateCollectionMember",
        `collections.${i}.groupIds`,
      );
    const unknown = collection.groupIds.findIndex((id) => !allowed.has(id));
    if (unknown >= 0)
      throw new OrganizationConstraintError(
        "unknownCollectionGroup",
        `collections.${i}.groupIds.${unknown}`,
      );
    if (collection.kind === "series")
      for (const id of collection.groupIds) {
        if (seriesMembers.has(id))
          throw new OrganizationConstraintError(
            "duplicateCollectionMember",
            `collections.${i}.groupIds`,
          );
        seriesMembers.add(id);
      }
    names.add(key);
  }
  return result;
}

export const organizationRefineSchema = z
  .object({
    jobId: id,
    previousJobId: id,
    feedback: z.string().trim().min(1).max(8000),
    titles: z
      .array(
        z.object({ id, title: z.string().trim().min(1).max(500) }).strict(),
      )
      .max(2000),
  })
  .strict();

/** Preview the same hierarchy that application materializes, without widening membership. */
export function organizationMembers(
  plan: OrganizationPlan,
  relationship: OrganizationPlan["collections"][number],
  approvedSeries: string[],
): { id: string; kind: "work" | "series"; groupIds: string[] }[] {
  if (relationship.kind === "series")
    return relationship.groupIds.map((id) => ({
      id,
      kind: "work",
      groupIds: [id],
    }));
  const remaining = new Set(relationship.groupIds);
  const series = plan.collections.filter(
    (s) =>
      s.kind === "series" &&
      approvedSeries.includes(s.id) &&
      s.groupIds.every((id) => remaining.has(id)),
  );
  const byWork = new Map(
    series.flatMap((s) => s.groupIds.map((id) => [id, s] as const)),
  );
  const emitted = new Set<string>();
  return relationship.groupIds.flatMap<{
    id: string;
    kind: "work" | "series";
    groupIds: string[];
  }>((id) => {
    const s = byWork.get(id);
    if (!s) return [{ id, kind: "work" as const, groupIds: [id] }];
    if (emitted.has(s.id)) return [];
    emitted.add(s.id);
    return [{ id: s.id, kind: "series" as const, groupIds: s.groupIds }];
  });
}

export const organizationReviewSelectionSchema = z
  .object({
    fileExclusions: z
      .array(id)
      .max(organizationFileLimit)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    relationshipRemovals: z
      .array(id)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    jobId: id,
    groups: z
      .array(id)
      .max(organizationFileLimit)
      .refine((ids) => new Set(ids).size === ids.length),
    collections: z
      .array(id)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length),
    names: z.record(id, z.string().trim().min(1).max(500)),
    acknowledgedRemovals: z
      .array(id)
      .max(organizationFileLimit)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
