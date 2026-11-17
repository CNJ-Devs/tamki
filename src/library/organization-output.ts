import { z } from "zod";
import { ProviderError } from "../providers/provider";
import {
  organizationAnalysisSchema,
  organizationRevisionSchema,
  reservedOrganizationIdentity,
  type OrganizationFile,
} from "../shared/organization";

type Reason =
  | "json"
  | "schema"
  | "unknownReference"
  | "emptyReference"
  | "emptyGroup"
  | "coverage"
  | "duplicateGroupIdentity"
  | "invalidGroupIdentity"
  | "duplicateCollectionName"
  | "duplicateCollectionMember"
  | "duplicateCollectionMembership"
  | "insufficientCollectionMembers"
  | "unknownCollectionGroup"
  | "revisionOperation"
  | "allocation"
  | "validation"
  | "episodeMembership";
export interface OrganizationIssue {
  reason: Reason;
  field: string;
  reference?: string;
  detail?: string;
}
export interface OrganizationFeedback {
  issues: OrganizationIssue[];
  missing: string[];
  duplicates: string[];
}
export class OrganizationOutputError extends ProviderError {
  constructor(
    readonly reason: Reason,
    readonly field = "root",
    readonly issues = 1,
    readonly feedback: OrganizationFeedback = {
      issues: [{ reason, field }],
      missing: [],
      duplicates: [],
    },
  ) {
    super("organizationInvalid");
  }
  diagnostics() {
    return { reason: this.reason, field: this.field, issues: this.issues };
  }
}
export class OrganizationCoverageError extends OrganizationOutputError {
  constructor(
    readonly missing: string[],
    readonly duplicates: string[],
    feedback?: OrganizationFeedback,
  ) {
    super(
      "coverage",
      "groups",
      missing.length + duplicates.length,
      feedback || {
        issues: [{ reason: "coverage", field: "groups" }],
        missing,
        duplicates,
      },
    );
  }
  override diagnostics() {
    return {
      ...super.diagnostics(),
      missingFiles: this.missing.length,
      duplicateFiles: this.duplicates.length,
    };
  }
}
const schemaKeys = new Set([
  "groups",
  "identity",
  "title",
  "fileIds",
  "review",
  "reason",
  "unassigned",
  "collections",
  "name",
  "groupIds",
  "removeGroupIds",
  "replaceCollections",
  "replaceUnassigned",
  "episodes",
  "number",
  "versions",
  "label",
  "releaseKey",
]);
const fieldPath = (parts: PropertyKey[]) =>
  parts
    .map((part) =>
      typeof part === "number"
        ? part
        : schemaKeys.has(String(part))
          ? part
          : "unknown",
    )
    .join(".") || "root";
const parseJSON = (text: string): unknown =>
  JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, ""),
  );
function parse<T>(schema: z.ZodType<T>, text: string): T {
  try {
    return schema.parse(parseJSON(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new OrganizationOutputError("json");
    if (error instanceof z.ZodError) {
      const issues: OrganizationIssue[] = error.issues.map((i) => ({
        reason: "schema",
        field: fieldPath(i.path),
      }));
      throw new OrganizationOutputError(
        "schema",
        issues[0]?.field,
        issues.length,
        { issues, missing: [], duplicates: [] },
      );
    }
    throw error;
  }
}
export function inspectOrganization(
  text: string,
  files: OrganizationFile[],
  references: Map<string, string[]>,
  fileRefs: Map<string, string>,
  anchors: ReadonlySet<string> = new Set(),
) {
  let proposal: z.infer<typeof organizationAnalysisSchema>;
  try {
    proposal = parse(organizationAnalysisSchema, text);
  } catch (error) {
    if (!(error instanceof OrganizationOutputError)) throw error;
    return {
      feedback: error.feedback,
      proposal: undefined,
      expanded: undefined,
    };
  }
  const feedback: OrganizationFeedback = {
    issues: [],
    missing: [],
    duplicates: [],
  };
  const add = (reason: Reason, field: string, reference?: string) =>
    feedback.issues.push({
      reason,
      field,
      ...(reference === undefined ? {} : { reference }),
    });
  const allowed = new Set(files.map((f) => f.id));
  const counts = new Map<string, number>();
  const expand = (refs: string[], field: string) =>
    refs.flatMap((ref, i) => {
      if (!references.has(ref)) {
        add("unknownReference", `${field}.${i}`, ref);
        return [];
      }
      const members = references.get(ref)!.filter((id) => allowed.has(id));
      if (!members.length) add("emptyReference", `${field}.${i}`, ref);
      for (const id of members) counts.set(id, (counts.get(id) || 0) + 1);
      return members;
    });
  const groups = proposal.groups.map((g, i) => ({
    ...g,
    id: g.identity,
    fileIds: expand(g.fileIds, `groups.${i}.fileIds`),
  }));
  const physicalByRef = new Map([...fileRefs].map(([id, ref]) => [ref, id]));
  // Episode mappings refer to individual physical files only. They refine work
  // allocation and must not add coverage, overlap or cross work boundaries.
  for (const [i, group] of groups.entries()) {
    const seen = new Set<string>();
    group.episodes = group.episodes.map((episode, j) => ({
      ...episode,
      versions: episode.versions.map((version, k) => ({
        ...version,
        fileIds: version.fileIds.flatMap((ref, n) => {
          const field = `groups.${i}.episodes.${j}.versions.${k}.fileIds.${n}`;
          const physicalId = physicalByRef.get(ref);
          const ids =
            physicalId && allowed.has(physicalId) ? [physicalId] : undefined;
          if (
            !ids ||
            ids.length !== 1 ||
            !fileRefs.has(ids[0]) ||
            fileRefs.get(ids[0]) !== ref
          ) {
            add("episodeMembership", field, ref);
            return [];
          }
          const id = ids[0];
          if (!group.fileIds.includes(id) || seen.has(id))
            add("episodeMembership", field, ref);
          seen.add(id);
          return [id];
        }),
      })),
    }));
  }
  const unassigned = expand(proposal.unassigned, "unassigned");
  feedback.missing = files
    .filter((f) => !counts.has(f.id))
    .map((f) => fileRefs.get(f.id)!);
  feedback.duplicates = [...counts]
    .filter(([, n]) => n > 1)
    .map(([id]) => fileRefs.get(id)!);
  if (feedback.missing.length || feedback.duplicates.length)
    add("coverage", "groups");
  const identities = new Set<string>(anchors);
  for (const g of proposal.groups) {
    if (reservedOrganizationIdentity(g.identity))
      add("invalidGroupIdentity", "groups", g.identity);
    if (identities.has(g.identity))
      add("duplicateGroupIdentity", "groups", g.identity);
    identities.add(g.identity);
  }
  const names = new Set<string>();
  const memberSets = new Set<string>();
  const seriesMembers = new Set<string>();
  for (const [i, c] of proposal.collections.entries()) {
    const key = `${c.kind || "collection"}:${c.name.toLocaleLowerCase()}`;
    if (names.has(key)) add("duplicateCollectionName", `collections.${i}.name`);
    names.add(key);
    const seen = new Set<string>();
    for (const [j, id] of c.groupIds.entries()) {
      if (c.kind === "series") {
        if (seriesMembers.has(id))
          add("duplicateCollectionMember", `collections.${i}.groupIds`, id);
        seriesMembers.add(id);
      }
      if (seen.has(id))
        add("duplicateCollectionMember", `collections.${i}.groupIds`, id);
      if (!identities.has(id))
        add("unknownCollectionGroup", `collections.${i}.groupIds.${j}`, id);
      seen.add(id);
    }
    if (seen.size < 2)
      add("insufficientCollectionMembers", `collections.${i}.groupIds`);
    const membership = `${c.kind || "collection"}:${JSON.stringify([...seen].sort())}`;
    if (memberSets.has(membership))
      add("duplicateCollectionMembership", `collections.${i}.groupIds`);
    memberSets.add(membership);
  }
  return {
    proposal,
    feedback,
    expanded: { groups, collections: proposal.collections, unassigned },
  };
}
export function decodeOrganization(
  text: string,
  files: OrganizationFile[],
  references: Map<string, string[]>,
  fileRefs: Map<string, string>,
  anchors: ReadonlySet<string> = new Set(),
) {
  const inspected = inspectOrganization(
    text,
    files,
    references,
    fileRefs,
    anchors,
  );
  const { feedback } = inspected;
  const first = feedback.issues[0];
  if (first?.reason === "coverage")
    throw new OrganizationCoverageError(
      feedback.missing,
      feedback.duplicates,
      feedback,
    );
  if (first)
    throw new OrganizationOutputError(
      first.reason,
      first.field,
      feedback.issues.length,
      feedback,
    );
  return inspected.expanded!;
}
export function mergeOrganizationRevision(draft: string, text: string): string {
  const proposal = parse(organizationAnalysisSchema, draft);
  const revision = parse(organizationRevisionSchema, text);
  const fail = (field: string): never => {
    throw new OrganizationOutputError("revisionOperation", field);
  };
  const existing = new Set(proposal.groups.map((g) => g.identity));
  const removed = new Set(revision.removeGroupIds);
  if (
    removed.size !== revision.removeGroupIds.length ||
    [...removed].some((id) => !existing.has(id))
  )
    fail("removeGroupIds");
  if (!revision.replaceCollections && revision.collections.length)
    fail("collections");
  if (!revision.replaceUnassigned && revision.unassigned.length)
    fail("unassigned");
  const groups = proposal.groups.filter((g) => !removed.has(g.identity));
  const updates = new Map<string, typeof revision.groups>();
  for (const g of revision.groups)
    updates.set(g.identity, [...(updates.get(g.identity) || []), g]);
  for (const [identity, records] of updates) {
    const matches = groups.flatMap((old, j) =>
      old.identity === identity ? [j] : [],
    );
    // Preserve conflicting definitions in the INTERNAL draft for validation and
    // explicit correction. An upsert replaces the entire value for its identity,
    // including prior conflicting definitions. Its supplied records are kept
    // verbatim; coverage validation catches any accidentally omitted files.
    if (matches.length) {
      for (const index of matches.slice(1).reverse()) groups.splice(index, 1);
      groups.splice(matches[0], 1, ...records);
    } else groups.push(...records);
  }
  // No guessed membership, deduplication, title normalization or schema coercion.
  // The caller must validate exact coverage/relationships on this merged draft.
  return JSON.stringify({
    groups,
    collections: revision.replaceCollections
      ? revision.collections
      : proposal.collections,
    unassigned: revision.replaceUnassigned
      ? revision.unassigned
      : proposal.unassigned,
  });
}

/** A collection is a set of works. Repeating the identical member does not
 * express a second relationship. Canonicalize only that redundancy; never
 * guess missing membership or deduplicate files across works. The caller logs
 * this operation and still validates minimum collection size and every ref. */
export function normalizeOrganizationCollections(text: string) {
  let proposal: z.infer<typeof organizationAnalysisSchema>;
  try {
    proposal = parse(organizationAnalysisSchema, text);
  } catch (error) {
    if (!(error instanceof OrganizationOutputError)) throw error;
    return { text, removed: 0 };
  }
  let removed = 0;
  for (const collection of proposal.collections) {
    const members = [...new Set(collection.groupIds)];
    // Keep a degenerate collection available for explicit model correction.
    // Dropping it or inventing another member would change the proposal.
    if (members.length < 2) continue;
    removed += collection.groupIds.length - members.length;
    collection.groupIds = members;
  }
  return { text: removed ? JSON.stringify(proposal) : text, removed };
}
