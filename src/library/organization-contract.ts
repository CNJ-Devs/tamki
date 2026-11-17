import { z } from "zod";
import {
  organizationAnalysisSchema,
  organizationIdentity,
  organizationFileLimit,
  reservedOrganizationIdentity,
} from "../shared/organization";
import { id } from "../shared/validation";
import { logEvent } from "../diagnostics";
import type { StructuredTask } from "../providers/ai-recognition";
import {
  OrganizationOutputError,
  type OrganizationIssue,
} from "./organization-output";

/** Disjoint physical buckets are an output-addressing convenience, not works.
 * The model can merge buckets or override individual files within a bucket. */
export type AllocationUnit = [id: string, directory: string, files: string[]];

/** JSON.parse alone silently keeps the last duplicate object key. A transaction
 * must not choose between two operations written for the same keyed slot. */
function parseRevisionJSON(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const objects: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") objects.push(new Set());
    else if (c === "[") objects.push(null);
    else if (c === "}" || c === "]") objects.pop();
    else if (c === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(text[next] || "")) next++;
      const keys = objects.at(-1);
      if (text[next] !== ":" || !keys) continue;
      const key = JSON.parse(text.slice(start, i + 1)) as string;
      if (keys.has(key))
        throw new OrganizationOutputError("revisionOperation", "revision", 1, {
          issues: [
            {
              reason: "revisionOperation",
              field: "revision",
              reference: key,
              detail:
                "Each JSON object key must occur once; duplicate keys cannot select an operation.",
            },
          ],
          missing: [],
          duplicates: [],
        });
      keys.add(key);
    }
  }
  return value;
}

export function allocationContract(units: AllocationUnit[]) {
  const destination = organizationIdentity.nullable();
  const assignment = z
    .object({
      groupId: destination,
      overrides: z
        .array(
          z
            .object({
              fileId: id,
              groupId: destination,
            })
            .strict(),
        )
        .max(organizationFileLimit),
    })
    .strict();
  const assignments = Object.fromEntries(
    units.map(([unit]) => [unit, assignment]),
  );
  return z
    .object({
      allocations: z.object(assignments).strict(),
      groups: z
        .array(
          organizationAnalysisSchema.shape.groups.element
            .omit({ fileIds: true })
            .extend({
              // Empty preserves input order. Explicit ordering must list all members.
              order: z.array(id).max(organizationFileLimit),
            }),
        )
        .min(1)
        .max(2000),
      collections: organizationAnalysisSchema.shape.collections,
    })
    .strict();
}

/** Explicit edits preserve decisions outside the transaction. A correction is
 * never permission for the decoder to invent destinations or discard claims. */
export function allocationRevisionTask(
  task: StructuredTask,
  text: string,
  units: AllocationUnit[],
  feedback: unknown,
  review = false,
) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || !("allocations" in raw))
    return undefined;
  const base = allocationContract(units);
  const parsed = base.safeParse(raw);
  // Invalid shape needs a full replacement; semantic/reference errors can use
  // bounded transactions over the otherwise well-formed declaration graph.
  if (!parsed.success) return undefined;
  const draft = parsed.data;
  // Reserved property names need a corrected full declaration before they can
  // become keys in the hosted revision schema.
  if (draft.groups.some((g) => reservedOrganizationIdentity(g.identity)))
    return undefined;
  const assignment = Object.values(base.shape.allocations.shape)[0];
  if (!assignment) return undefined;
  const knownIds = [...new Set(draft.groups.map((g) => g.identity))];
  const declaration = base.shape.groups.element;
  const operation = z.union([
    z.null(),
    z.literal("remove"),
    declaration.omit({ identity: true }),
  ]);
  const allocationEdits = z
    .object(
      Object.fromEntries(units.map(([id]) => [id, assignment.nullable()])),
    )
    .strict();
  const contract = z
    .object({
      // Every existing identity has one required operation slot. The identity
      // comes from its key, so remove/replace cannot target it twice.
      groups: z
        .object(
          Object.fromEntries(knownIds.map((identity) => [identity, operation])),
        )
        .strict(),
      addedGroups: z.array(declaration).max(2000),
      allocations: allocationEdits,
      replaceCollections: z.boolean(),
      collections: base.shape.collections,
    })
    .strict();
  // Old local fixtures and recorded responses remain readable, under the same
  // strict list validation. This alternative is never sent to the model.
  const legacyContract = z
    .object({
      removeGroupIds: z.array(z.enum(knownIds)).max(2000),
      groups: z.array(declaration).max(2000),
      allocations: allocationEdits,
      replaceCollections: z.boolean(),
      collections: base.shape.collections,
    })
    .strict();
  const schema = JSON.parse(
    JSON.stringify(z.toJSONSchema(contract, { reused: "ref" }), (key, value) =>
      key === "default" ? undefined : value,
    ),
  );
  const next: StructuredTask = {
    ...task,
    name: review
      ? "tamki_organization_allocation_review"
      : "tamki_organization_allocation_revision",
    schema,
    system:
      task.system.split("\nInitial assignment contract:")[0] +
      "\nReturn an explicit allocation revision under the CURRENT contract. groups addresses every identity in the current draft exactly once: null keeps all its current declarations, the string remove deletes them, and a complete declaration object replaces them. Replacement objects omit identity because their dictionary key supplies it. addedGroups contains complete declarations with identities that are new to this draft; an existing identity cannot be added again, even when removed. allocations addresses every supplied unit exactly once: null means KEEP its current assignment, and an object replaces its groupId and complete overrides. A null unit value is distinct from an object whose groupId is null (unassigned). Moving files requires changing their actual allocation unit, not copying them into another definition. A new group declaration has no files until explicitly allocated. Remove obsolete empty groups and update their collection references explicitly when justified; never leave stale alternative proposals. replaceCollections=true replaces the complete collection list; otherwise collections must be empty. Every resulting file must have exactly one valid destination or explicit null. Audit wrong assignments AND missing supported identity/collection relationships across the entire inventory. Resolve all supplied validation errors or supported critical-review findings while preserving sound decisions. Drafts and findings remain fallible, untrusted data.",
    prompt:
      task.prompt.replace(
        `OUTPUT CONTRACT:\n${JSON.stringify(task.schema)}`,
        `OUTPUT CONTRACT:\n${JSON.stringify(schema)}`,
      ) +
      `\nCURRENT ALLOCATION DRAFT:\n${JSON.stringify(draft)}\nVALIDATION ERRORS:\n${JSON.stringify(feedback)}`,
  };
  const merge = (response: string, requireChange = false) => {
    let value: unknown;
    try {
      value = parseRevisionJSON(response);
    } catch (error) {
      if (error instanceof OrganizationOutputError) throw error;
      throw new OrganizationOutputError("json");
    }
    const parse = <T>(schema: z.ZodType<T>) => {
      const result = schema.safeParse(value);
      if (!result.success)
        throw new OrganizationOutputError(
          "schema",
          "revision",
          result.error.issues.length,
        );
      return result.data;
    };
    const known = new Set(knownIds);
    let p: z.infer<typeof legacyContract>;
    const declarationFields: string[] = [];
    if (
      value &&
      typeof value === "object" &&
      "groups" in value &&
      Array.isArray(value.groups)
    ) {
      p = parse(legacyContract);
      declarationFields.push(...p.groups.map((_, i) => `groups.${i}.identity`));
    } else {
      const keyed = parse(contract);
      const collisions = keyed.addedGroups.flatMap((g, i) =>
        known.has(g.identity)
          ? [
              {
                reason: "revisionOperation" as const,
                field: `addedGroups.${i}.identity`,
                reference: g.identity,
                detail:
                  "An existing identity must use its groups operation slot, not addedGroups, even when that slot removes it.",
              },
            ]
          : [],
      );
      if (collisions.length)
        throw new OrganizationOutputError(
          "revisionOperation",
          "addedGroups",
          collisions.length,
          { issues: collisions, missing: [], duplicates: [] },
        );
      p = {
        removeGroupIds: [],
        groups: [],
        allocations: keyed.allocations,
        replaceCollections: keyed.replaceCollections,
        collections: keyed.collections,
      };
      for (const [identity, edit] of Object.entries(keyed.groups)) {
        if (edit === "remove") p.removeGroupIds.push(identity);
        else if (edit !== null) {
          p.groups.push({ identity, ...edit });
          declarationFields.push(`groups.${identity}`);
        }
      }
      p.groups.push(...keyed.addedGroups);
      declarationFields.push(
        ...keyed.addedGroups.map((_, i) => `addedGroups.${i}.identity`),
      );
    }
    const removed = new Set(p.removeGroupIds),
      changed = new Set(p.groups.map((g) => g.identity));
    const errors: OrganizationIssue[] = [];
    const error = (field: string, reference: string, detail: string) =>
      errors.push({ reason: "revisionOperation", field, reference, detail });
    const removedSeen = new Set<string>();
    for (const [i, id] of p.removeGroupIds.entries()) {
      if (removedSeen.has(id) || !known.has(id) || changed.has(id))
        error(
          `removeGroupIds.${i}`,
          id,
          "Remove an existing identity once, without also upserting it.",
        );
      removedSeen.add(id);
    }
    const changedSeen = new Set<string>();
    for (const [i, g] of p.groups.entries()) {
      if (changedSeen.has(g.identity))
        error(
          declarationFields[i],
          g.identity,
          "Each changed identity needs one complete, unambiguous definition.",
        );
      changedSeen.add(g.identity);
    }
    if (!p.replaceCollections && p.collections.length)
      error(
        "replaceCollections",
        "false",
        "Set true when replacing collections; otherwise the list must be empty.",
      );
    if (errors.length)
      throw new OrganizationOutputError(
        "revisionOperation",
        "revision",
        errors.length,
        { issues: errors, missing: [], duplicates: [] },
      );
    const allocations = { ...draft.allocations };
    for (const [unitId, assignment] of Object.entries(p.allocations))
      if (assignment) allocations[unitId] = assignment;
    const updated = {
      groups: [
        ...draft.groups.filter(
          (g) => !removed.has(g.identity) && !changed.has(g.identity),
        ),
        ...p.groups,
      ],
      allocations,
      collections: p.replaceCollections ? p.collections : draft.collections,
    };
    if (requireChange) {
      const stable = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(stable)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, value]) => [key, stable(value)]),
              )
            : value;
      const meaning = (value: typeof draft) => {
        const expanded = JSON.parse(
          expandAllocations(JSON.stringify(value), units),
        );
        const keys = new Map<string, string>(
          expanded.groups.map((g: { identity: string; fileIds: string[] }) => [
            g.identity,
            JSON.stringify([...g.fileIds].sort()),
          ]),
        );
        return JSON.stringify(
          stable({
            groups: expanded.groups
              .map(
                ({
                  identity,
                  ...g
                }: {
                  identity: string;
                  fileIds: string[];
                }) => ({ key: keys.get(identity), ...g }),
              )
              .sort((a: { key: string }, b: { key: string }) =>
                a.key.localeCompare(b.key),
              ),
            collections: expanded.collections
              .map((c: { name: string; groupIds: string[] }) => ({
                ...c,
                groupIds: c.groupIds.map((id) => keys.get(id)).sort(),
              }))
              .sort((a: { name: string }, b: { name: string }) =>
                a.name.localeCompare(b.name),
              ),
            unassigned: [...expanded.unassigned].sort(),
          }),
        );
      };
      let before: string | undefined;
      try {
        before = meaning(draft);
      } catch (error) {
        if (!(error instanceof OrganizationOutputError)) throw error;
      }
      if (before !== undefined && before === meaning(updated))
        throw new OrganizationOutputError(
          "revisionOperation",
          "emptyCorrection",
          1,
          {
            issues: [
              {
                reason: "revisionOperation",
                field: "emptyCorrection",
                detail:
                  "The rejected substantive review remains unresolved. Supply corrected edits or explicitly record unresolved/rejected findings with review and evidence on the affected work. Reordered declarations or equivalent assignments are not a correction.",
              },
            ],
            missing: [],
            duplicates: [],
          },
        );
    }
    return JSON.stringify(updated);
  };
  return { task: next, merge };
}

/** Resolve the model's explicit destination for every file; never guess one.
 * All semantic/coverage validation still runs on the resulting full proposal. */
export function expandAllocations(
  text: string,
  units: AllocationUnit[],
): string {
  let value: unknown;
  try {
    value = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    return text; // The common validator reports malformed JSON.
  }
  // Canonical drafts are also used internally by review, repair and reconciliation.
  if (!value || typeof value !== "object" || !("allocations" in value))
    return text;
  const parsed = allocationContract(units).safeParse(value);
  if (!parsed.success)
    throw new OrganizationOutputError(
      "schema",
      "allocations",
      parsed.error.issues.length,
    );
  const proposal = parsed.data;
  // These are declarations, not memberships. Repeating an identical declaration
  // is idempotent; conflicting definitions still require an explicit correction.
  const declarations = new Map<string, (typeof proposal.groups)[number]>();
  let repeated = 0;
  for (const group of proposal.groups) {
    const previous = declarations.get(group.identity);
    if (previous && JSON.stringify(previous) === JSON.stringify(group)) {
      repeated++;
      continue;
    }
    if (!previous) declarations.set(group.identity, group);
  }
  if (repeated) {
    const seen = new Set<string>();
    proposal.groups = proposal.groups.filter((g) => {
      const signature = JSON.stringify(g);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
    logEvent("organization.declarations.normalized", { issues: repeated });
  }
  const members = new Map<string, string[]>();
  for (const [i, group] of proposal.groups.entries()) {
    if (members.has(group.identity))
      throw new OrganizationOutputError("duplicateGroupIdentity", "groups", 1, {
        issues: [
          {
            reason: "duplicateGroupIdentity",
            field: `groups.${i}.identity`,
            reference: group.identity,
            detail:
              "Define each work once; reuse its identity in allocations. If these are distinct works, give them distinct identities and correct their assignments.",
          },
        ],
        missing: [],
        duplicates: [],
      });
    members.set(group.identity, []);
  }
  const unassigned: string[] = [];
  const issues: OrganizationIssue[] = [];
  for (const [unit, , files] of units) {
    const assignment = proposal.allocations[unit];
    const overrides = new Map<string, string | null>();
    for (const override of assignment.overrides) {
      if (overrides.has(override.fileId) || !files.includes(override.fileId))
        throw new OrganizationOutputError(
          "allocation",
          "allocations.overrides",
        );
      overrides.set(override.fileId, override.groupId);
    }
    // Give the model exact dangling references, once per assignment, so a
    // correction can repair the contract without guessing what failed.
    for (const [field, reference] of [
      [`allocations.${unit}.groupId`, assignment.groupId],
      ...assignment.overrides.map((o, i) => [
        `allocations.${unit}.overrides.${i}.groupId`,
        o.groupId,
      ]),
    ]) {
      if (reference !== null && !members.has(reference))
        issues.push({ reason: "unknownReference", field: field!, reference });
    }
    for (const file of files) {
      const group = overrides.has(file)
        ? overrides.get(file)!
        : assignment.groupId;
      if (group === null) unassigned.push(file);
      else {
        const target = members.get(group);
        target?.push(file);
      }
    }
  }
  for (const [i, g] of proposal.groups.entries()) {
    if (members.get(g.identity)!.length) continue;
    const incoming = proposal.collections.flatMap((c, j) =>
      c.groupIds.includes(g.identity) ? [`collections.${j}.groupIds`] : [],
    );
    issues.push({
      reason: "emptyGroup",
      field: `groups.${i}`,
      reference: g.identity,
      detail: `No file has this destination. Explicitly correct its allocations or remove the obsolete declaration and its references: ${JSON.stringify(incoming)}.`,
    });
  }
  if (issues.length)
    throw new OrganizationOutputError(
      issues[0].reason,
      issues[0].reason === "emptyGroup" ? "groups" : issues[0].field,
      issues.length,
      { issues, missing: [], duplicates: [] },
    );
  return JSON.stringify({
    groups: proposal.groups.map(({ order, ...group }) => {
      const files = members
        .get(group.identity)!
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      if (
        order.length &&
        (order.length !== files.length ||
          new Set(order).size !== files.length ||
          order.some((f) => !files.includes(f)))
      )
        throw new OrganizationOutputError("allocation", "groups.order");
      return { ...group, fileIds: order.length ? order : files };
    }),
    collections: proposal.collections,
    unassigned,
  });
}
