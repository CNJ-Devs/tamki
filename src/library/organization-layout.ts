import { z } from "zod";
import type { StructuredTask } from "../providers/ai-recognition";
import {
  organizationAnalysisSchema,
  reservedOrganizationIdentity,
} from "../shared/organization";
import {
  OrganizationOutputError,
  type OrganizationIssue,
} from "./organization-output";

const index = z.number().int().positive();

const ownershipIssue = z
  .object({
    workId: z.string().min(1).max(200),
    fileIds: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1).max(1000),
  })
  .strict();

/** A known wrong work membership is a blocking finding, not uncertainty that
 * can be delivered as a review flag on an otherwise final relationship graph. */
export class OrganizationOwnershipError extends OrganizationOutputError {
  constructor(readonly findings: z.infer<typeof ownershipIssue>[]) {
    super("allocation", "ownershipIssues", findings.length, {
      issues: findings.map((finding) => ({
        reason: "allocation",
        field: `groups.${finding.workId}.fileIds`,
        reference: finding.workId,
        detail: JSON.stringify(finding),
      })),
      missing: [],
      duplicates: [],
    });
  }
}

/** A total relation decision, encoded compactly without repeating file metadata.
 * Positions refer to the explicit canonical work file order, never directory order. */
export function organizationLayoutTask(
  task: StructuredTask,
  text: string,
  evidence = text,
  manualFields = new Map<string, string[]>(),
) {
  const draft = organizationAnalysisSchema.parse(JSON.parse(text));
  if (draft.groups.some((g) => reservedOrganizationIdentity(g.identity)))
    throw new OrganizationOutputError("invalidGroupIdentity", "groups");
  const episodeMetadata = z.array(
    z
      .object({
        key: index,
        number: z.string().max(100),
        title: z.string().max(500),
      })
      .strict(),
  );
  const versionMetadata = z.array(
    z
      .object({
        key: index,
        label: z.string().max(200),
        releaseKey: z.string().max(200),
      })
      .strict(),
  );
  const pair = z.array(index).length(2);
  const workShape = (length: number) =>
    z
      .object({
        layout: z.array(pair).length(length),
        episodeMetadata,
        versionMetadata,
        collectionKeys: z.array(z.string().min(1).max(100)),
        review: z.boolean(),
        reason: z.string().max(1000),
      })
      .strict();
  const shapes = new Map<number, ReturnType<typeof workShape>>();
  const shapeFor = (length: number) => {
    if (!shapes.has(length)) shapes.set(length, workShape(length));
    return shapes.get(length)!;
  };
  const contract = z
    .object({
      ownershipIssues: z.array(ownershipIssue).max(2000),
      works: z
        .object(
          Object.fromEntries(
            draft.groups.map((g) => [g.identity, shapeFor(g.fileIds.length)]),
          ),
        )
        .strict()
        .nullable(),
      collections: z
        .array(
          z
            .object({
              kind: z.enum(["series", "collection"]).optional(),
              key: z.string().min(1).max(100),
              name: z.string().min(1).max(100),
              relationship: z.string().min(1).max(500),
            })
            .strict(),
        )
        .max(200)
        .nullable(),
    })
    .strict();
  const schema = z.toJSONSchema(contract, { reused: "ref" });
  const prompt =
    task.prompt.split("\nOUTPUT CONTRACT:")[0] +
    `\nORDERED WORK ASSIGNMENTS:\n${evidence}\nOUTPUT CONTRACT:\n${JSON.stringify(schema)}`;
  const next: StructuredTask = {
    ...task,
    name: "tamki_organization_relationships",
    schema,
    prompt,
    system:
      task.system.split("\nInitial assignment contract:")[0] +
      "\nThis is the exhaustive relationship stage. Resolve logical episode identity, representation identity and relationships BETWEEN works using the complete evidence. Return the CURRENT compact contract, not groups.episodes or a revision. Every work has exactly one layout pair per file, in its supplied fileIds order: [episodeKey, versionKey]. Keys are positive integers local to that work. The first key identifies logical content; equal pairs are copies of one representation, while equal episode keys with different version keys are versions of that episode. Reusing a version key across different episodes only reuses its label definition, never equates their content. Establish independent work identities before matching episodes. Versions are interchangeable playback representations within the same work and content unit, retaining its identity and boundaries; correspondence does not erase an independent publication identity. Use evidence at the level of identity it supports: a broader work relationship does not establish detailed unit correspondence. Missing evidence is not contradictory evidence; observed structural inconsistencies must be reconciled or retained as local uncertainty at the affected level. Copies require stronger evidence of the same representation; lacking that evidence, retain distinct versions of the supported same episode. Resolve all supported correspondences; do not substitute singleton pairs for inferred equivalences. Metadata arrays define supported labels for used keys. Omission preserves consistent prior values and authored intent; conflicting prior values require an explicit metadata decision. Earlier unresolved work-identity concerns remain flagged and are not implicitly cleared by this relationship stage. Do not restate all singleton titles. collectionKeys explicitly decides relationships for EVERY work, including works outside old collections. Every referenced collection key must have an explicit definition in THIS response; prior draft definitions are not inherited. Metadata keys must be used by this work's layout; an episode key identifies content and is independent of its editable number. Relationship definitions carry kind=series or kind=collection. Series group tightly related independent works in a coherent navigation order; series cannot overlap or nest. Collections can span series and independent works and cannot nest. Infer relationship scope from evidence, not vocabulary. Collections need a specific content relationship, at least two different works, and distinct member sets. Do not create a collection for versions within one work. Check both missing relationships and unsupported memberships. Preserve supported manual intent and mark material uncertainty locally. Previous drafts and narratives are fallible evidence, not authority. All decisions must be encoded, not just described in reason.",
  };
  next.system +=
    " Before assigning relationships, verify actual work ownership. If evidence establishes wrong membership or an unsupported work boundary, return ownershipIssues with exact current workId, affected member fileIds and evidence-grounded reason, and set works and collections to null. This requests a return to work allocation; do not encode relationships over a known wrong work, or hide the error in review/reason. Ownership issues are for incorrect membership, not a title change or genuinely uncertain correspondence. With no ownership errors, ownershipIssues must be empty and works/collections must be complete non-null decisions.";
  const merge = (response: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(response);
    } catch {
      throw new OrganizationOutputError("json");
    }
    const parsed = contract.safeParse(raw);
    if (!parsed.success)
      throw new OrganizationOutputError(
        "schema",
        "works",
        parsed.error.issues.length,
        {
          issues: parsed.error.issues.map((i) => ({
            reason: "schema",
            field: i.path.join("."),
            detail: i.message,
          })),
          missing: [],
          duplicates: [],
        },
      );
    const result = parsed.data;
    if (result.ownershipIssues.length) {
      for (const [i, issue] of result.ownershipIssues.entries()) {
        const work = draft.groups.find((g) => g.identity === issue.workId);
        if (
          !work ||
          new Set(issue.fileIds).size !== issue.fileIds.length ||
          issue.fileIds.some((id) => !work.fileIds.includes(id))
        )
          throw new OrganizationOutputError(
            "unknownReference",
            `ownershipIssues.${i}`,
          );
      }
      if (result.works !== null || result.collections !== null)
        throw new OrganizationOutputError("schema", "ownershipIssues");
      throw new OrganizationOwnershipError(result.ownershipIssues);
    }
    if (!result.works || !result.collections)
      throw new OrganizationOutputError("schema", "works");
    const decisions = result.works;
    const issues: OrganizationIssue[] = [];
    const fail = (field: string, reference?: string, detail?: string) => {
      issues.push({ reason: "episodeMembership", field, reference, detail });
    };
    const collections = new Map<
      string,
      { name: string; groupIds: string[]; kind?: "series" | "collection" }
    >();
    for (const c of result.collections) {
      if (collections.has(c.key))
        fail(
          "collections.key",
          c.key,
          "Each collection key must be defined once.",
        );
      collections.set(c.key, { name: c.name, groupIds: [], kind: c.kind });
    }
    const groups = draft.groups.map((g) => {
      const decision = decisions[g.identity];
      const episodes = new Map<number, (typeof g.episodes)[number]>();
      const versions = new Map<
        string,
        (typeof g.episodes)[number]["versions"][number]
      >();
      const usedEpisodes = new Set(decision.layout.map((p) => p[0]));
      const usedVersions = new Set(decision.layout.map((p) => p[1]));
      const episodeMetadata = new Map(
        decision.episodeMetadata.map((m) => [m.key, m]),
      );
      const versionMetadata = new Map(
        decision.versionMetadata.map((m) => [m.key, m]),
      );
      for (const [field, definitions, used] of [
        ["episodeMetadata", decision.episodeMetadata, usedEpisodes],
        ["versionMetadata", decision.versionMetadata, usedVersions],
      ] as const) {
        const seen = new Set<number>();
        for (const [i, m] of definitions.entries()) {
          if (seen.has(m.key) || !used.has(m.key))
            fail(
              `works.${g.identity}.${field}.${i}.key`,
              String(m.key),
              "Each metadata key must be defined once and used by that work's layout; correct the mapping and definition together.",
            );
          seen.add(m.key);
        }
      }
      for (const [i, [e, v]] of decision.layout.entries()) {
        let episode = episodes.get(e);
        if (!episode) {
          const m = episodeMetadata.get(e);
          episode = {
            number: m?.number ?? "",
            title: m?.title ?? "",
            versions: [],
          };
          episodes.set(e, episode);
        }
        const pair = `${e}:${v}`;
        let version = versions.get(pair);
        if (!version) {
          const m = versionMetadata.get(v);
          version = {
            label: m?.label ?? "",
            releaseKey: m?.releaseKey ?? "",
            fileIds: [],
          };
          versions.set(pair, version);
          episode.versions.push(version);
        }
        version.fileIds.push(g.fileIds[i]);
      }
      if (
        new Set(decision.collectionKeys).size !== decision.collectionKeys.length
      )
        fail(`works.${g.identity}.collectionKeys`);
      for (const key of decision.collectionKeys) {
        const collection = collections.get(key);
        if (!collection)
          fail(
            `works.${g.identity}.collectionKeys`,
            key,
            "Referenced collection key has no definition in this response. Define every referenced collection explicitly.",
          );
        else collection.groupIds.push(g.identity);
      }
      const inherit = (
        field: string,
        values: { value: string; manual: boolean }[],
        key: string,
      ) => {
        const authored = values.filter((v) => v.manual);
        const candidates = [
          ...new Set(
            (authored.length ? authored : values)
              .filter((v) => authored.length || v.value !== "")
              .map((v) => v.value),
          ),
        ];
        if (candidates.length > 1)
          fail(
            `works.${g.identity}.${field}`,
            key,
            "Conflicting prior values require an explicit metadata decision; omission cannot select a value by file order.",
          );
        return candidates[0] || "";
      };
      for (const [key, episode] of episodes) {
        if (episodeMetadata.has(key)) continue;
        const files = new Set(episode.versions.flatMap((v) => v.fileIds));
        const prior = g.episodes.filter((e) =>
          e.versions.some((v) => v.fileIds.some((f) => files.has(f))),
        );
        for (const field of ["number", "title"] as const)
          episode[field] = inherit(
            `episodeMetadata.${field}`,
            prior.map((e) => ({
              value: e[field],
              manual: e.versions.some((v) =>
                v.fileIds.some(
                  (f) => files.has(f) && manualFields.get(f)?.includes(field),
                ),
              ),
            })),
            String(key),
          );
      }
      for (const [pair, version] of versions) {
        if (versionMetadata.has(Number(pair.split(":")[1]))) continue;
        const prior = g.episodes
          .flatMap((e) => e.versions)
          .filter((v) => v.fileIds.some((f) => version.fileIds.includes(f)));
        for (const field of ["label", "releaseKey"] as const)
          version[field] = inherit(
            `versionMetadata.${field}`,
            prior.map((v) => ({ value: v[field], manual: false })),
            pair.split(":")[1],
          );
      }
      return {
        ...g,
        episodes: [...episodes.values()],
        review: g.review || decision.review,
        reason: decision.reason || g.reason,
      };
    });
    if (issues.length)
      throw new OrganizationOutputError(
        "episodeMembership",
        "works",
        issues.length,
        { issues, missing: [], duplicates: [] },
      );
    // The common canonical validator checks complete coverage and collection refs.
    return JSON.stringify({
      ...draft,
      groups,
      collections: [...collections.values()],
    });
  };
  // Keep each model-produced note under its own schema limit. Combining the
  // already-validated notes is an internal presentation operation, not new AI
  // output that should be reparsed against a single-note limit.
  const reviewReason = (identity: string, current: string) =>
    [
      ...new Set(
        [
          draft.groups.find((g) => g.identity === identity)?.reason,
          current,
        ].filter(Boolean),
      ),
    ].join("\n");
  const correction = (response: string, error: OrganizationOutputError) => {
    let value: unknown;
    try {
      value = JSON.parse(response);
    } catch {
      return undefined;
    }
    const previous = contract.safeParse(value);
    if (
      !previous.success ||
      previous.data.ownershipIssues.length ||
      !previous.data.works ||
      !previous.data.collections
    )
      return undefined;
    const prior = previous.data;
    const priorWorks = previous.data.works;
    const revision = z
      .object({
        ownershipIssues: contract.shape.ownershipIssues,
        works: z
          .object(
            Object.fromEntries(
              Object.entries(contract.shape.works.unwrap().shape).map(
                ([id, shape]) => [id, shape.nullable()],
              ),
            ),
          )
          .strict()
          .nullable(),
        collections: contract.shape.collections.nullable(),
      })
      .strict();
    const revisionSchema = z.toJSONSchema(revision, { reused: "ref" });
    return {
      task: {
        ...next,
        schema: revisionSchema,
        system: next.system.replace(
          "Return the CURRENT compact contract, not groups.episodes or a revision.",
          "Return the CURRENT correction contract. Each works value is null to retain that work's complete previous decision, or a complete replacement decision. collections is null to retain the previous definitions, or the complete replacement definitions. All layout, metadata, and coverage rules below apply to the merged result. Resolve the reported validation errors while preserving unaffected decisions.",
        ),
        prompt:
          next.prompt.replace(
            `\nOUTPUT CONTRACT:\n${JSON.stringify(schema)}`,
            `\nOUTPUT CONTRACT:\n${JSON.stringify(revisionSchema)}`,
          ) +
          `\nREJECTED RELATIONSHIPS:\n${response}\nVALIDATION ERRORS:\n${JSON.stringify(error.feedback)}`,
      },
      merge: (response: string) => {
        let value: unknown;
        try {
          value = JSON.parse(response);
        } catch {
          throw new OrganizationOutputError("json");
        }
        const parsed = revision.safeParse(value);
        if (!parsed.success)
          throw new OrganizationOutputError(
            "schema",
            "works",
            parsed.error.issues.length,
          );
        if (parsed.data.ownershipIssues.length)
          return merge(JSON.stringify(parsed.data));
        if (!parsed.data.works)
          throw new OrganizationOutputError("schema", "works");
        const edits = parsed.data.works;
        return merge(
          JSON.stringify({
            ownershipIssues: [],
            works: Object.fromEntries(
              Object.entries(priorWorks).map(([id, decision]) => [
                id,
                edits[id] ?? decision,
              ]),
            ),
            collections: parsed.data.collections ?? prior.collections,
          }),
        );
      },
    };
  };
  return { task: next, merge, reviewReason, correction };
}
