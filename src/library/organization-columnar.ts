import type { StructuredTask } from "../providers/ai-recognition";
import { OrganizationOutputError } from "./organization-output";

// This wire format compresses notation only. All semantic/reference/coverage
// decisions still pass through the canonical organization validator.
const canonicalMappingGuide =
  "Use groups.episodes for explicit logical episode/version mappings. Each mapping has number, title, and versions [{label,releaseKey,fileIds}]; fileIds here must use individual fN references and each mapped file belongs to that work and occurs in at most one mapping. Include EVERY supported multi-file episode, not just prominent cases, even when its work membership is unchanged. Resolve correspondence from combined content context; editable numbers and array positions are observations, not identities. For compactness, omit only unchanged singleton episodes or already identical recorded mappings. Unmapped files preserve their current episode/version relationships within the proposed work; new files remain singleton episodes. To revise an existing grouping, include all affected members, including any that become singletons. Episode order follows the first member in group file order. Copies do not add episode count or total duration.";

const columnarMappingGuide =
  "Use g[].e for explicit episode/version mappings, with the columnar output dictionary below. Each mapped file belongs to its work and occurs in at most one mapping. Include every supported multi-file episode, including unchanged work membership. Editable numbers and positions are observations, not identities. Omit a mapping only after checking that its current grouping AND fields are suitable to retain; omitted singleton fields are not cleared or re-inferred by the application. Correct unsuitable automatic metadata with an explicit mapping. For explicit episode fields, a nonempty string sets the value and an empty string clears it; never omit a correction merely to shorten output. To revise an existing grouping, include all affected members, including any that become singletons. Episode order follows the first member in work file order. Copies do not add episode count or total duration.";

const canonicalCoverageGuide =
  "Every included file must occur exactly once across groups and unassigned. No unknown, duplicate or out-of-scope reference is permitted. Every group identity is unique. The collections output array carries both relationship kinds: kind=series or kind=collection. groupIds refer to work identities, in intended member order. Series are disjoint and cannot nest. Collections may overlap and cannot nest; their work membership can encompass a whole series, represented by the application as a series entry. Both proposed relationship kinds require at least two distinct works. Avoid redundant outer groupings that add no useful relationship.";

const columnarCoverageGuide =
  "Every included file must occur exactly once across g[].f and u. No unknown, duplicate or out-of-scope reference is permitted. Every g[].i identity is unique. The c output array carries both relationship kinds: k=series or k=collection. g members refer to work identities, in intended member order. Series are disjoint and cannot nest. Collections may overlap and cannot nest; their work membership can encompass a whole series, represented by the application as a series entry. Both proposed relationship kinds require at least two distinct works. Avoid redundant outer groupings that add no useful relationship.";

const columnarDictionary =
  "\n\nColumnar output dictionary (losslessly expanded before application validation)\nTop level: g=works, u=unassigned selectors, c=collections.\nEach work: i=unique identity key; t=title; f=ordered file selectors; r=representation dictionary; e=explicit episode table; q=review boolean; m=concise material reason, or empty.\nEach r entry has l=version label and k=releaseKey; its zero-based index is local to that work. Reuse a label/key entry without implying that different content units or version objects are identical.\nThe episode table e has n=episode-number strings, t=episode-title strings, and v=version columns. n and t have equal length; position j in each describes the same explicitly proposed episode. Empty strings clear fields. Omitted episodes are outside this table and retain their previously checked suitable current state. With no explicit episodes, n, t and v are all empty arrays.\nEach version column has r=representation dictionary index and f=file cells, exactly one cell per episode row. A cell is a single fN string for one file, an array of at least two fN strings for storage copies of one version, or null when that version is absent from that episode. Null does not retain, infer or fill a file. Every episode row needs at least one non-null cell; every column needs at least one non-null cell.\nReading columns left to right gives each episode's version order. Separate columns remain distinct versions even if they reference the same dictionary entry. Additional columns and null cells can express missing versions, different version orders, or multiple distinct versions with the same label/key. Correspondences are your explicit decisions; never align by array position without content evidence. No episode file ranges, wildcards, inferred pairing or gap filling are supported.\nEach relationship: k=series or collection; n=name; g=ordered member work identities. The table only compresses notation; preserve supported mappings and evidence-backed field values.\n";

export const columnarOrganizationSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    g: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
          t: {
            type: "string",
            minLength: 1,
            maxLength: 500,
          },
          f: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
            minItems: 1,
            maxItems: 20000,
          },
          r: {
            type: "array",
            items: {
              type: "object",
              properties: {
                l: {
                  type: "string",
                  maxLength: 200,
                },
                k: {
                  type: "string",
                  maxLength: 200,
                },
              },
              required: ["l", "k"],
              additionalProperties: false,
            },
            maxItems: 20000,
          },
          e: {
            type: "object",
            properties: {
              n: {
                type: "array",
                items: {
                  type: "string",
                  maxLength: 100,
                },
                maxItems: 20000,
              },
              t: {
                type: "array",
                items: {
                  type: "string",
                  maxLength: 500,
                },
                maxItems: 20000,
              },
              v: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    r: {
                      type: "integer",
                      minimum: 0,
                      maximum: 19999,
                    },
                    f: {
                      type: "array",
                      items: {
                        anyOf: [
                          {
                            type: "string",
                            minLength: 1,
                            maxLength: 128,
                          },
                          {
                            type: "array",
                            items: {
                              type: "string",
                              minLength: 1,
                              maxLength: 128,
                            },
                            minItems: 2,
                            maxItems: 20000,
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      minItems: 1,
                      maxItems: 20000,
                    },
                  },
                  required: ["r", "f"],
                  additionalProperties: false,
                },
                maxItems: 20000,
              },
            },
            required: ["n", "t", "v"],
            additionalProperties: false,
          },
          q: {
            type: "boolean",
          },
          m: {
            type: "string",
            maxLength: 1000,
          },
        },
        required: ["i", "t", "f", "r", "e", "q", "m"],
        additionalProperties: false,
      },
      maxItems: 2000,
    },
    u: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: 128,
      },
      maxItems: 20000,
    },
    c: {
      type: "array",
      items: {
        type: "object",
        properties: {
          k: { type: "string", enum: ["series", "collection"] },
          n: {
            type: "string",
            minLength: 1,
            maxLength: 100,
          },
          g: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
            minItems: 2,
            maxItems: 500,
          },
        },
        required: ["k", "n", "g"],
        additionalProperties: false,
      },
      maxItems: 200,
    },
  },
  required: ["g", "u", "c"],
  additionalProperties: false,
};

/** Apply the validated wire contract to a complete organization proposal. */
export function columnarOrganizationTask(task: StructuredTask): StructuredTask {
  const separator = "\nOUTPUT CONTRACT:\n";
  const boundary = task.prompt.lastIndexOf(separator);
  if (
    boundary < 0 ||
    !task.system.includes(canonicalMappingGuide) ||
    !task.system.includes(canonicalCoverageGuide)
  )
    throw new Error("organizationColumnarTaskContract");
  return {
    ...task,
    system:
      task.system
        .replace(canonicalMappingGuide, columnarMappingGuide)
        .replace(canonicalCoverageGuide, columnarCoverageGuide) +
      columnarDictionary,
    prompt:
      task.prompt.slice(0, boundary) +
      separator +
      JSON.stringify(columnarOrganizationSchema),
    schema: columnarOrganizationSchema,
    reasoningEffort: "medium",
  };
}

export class OrganizationColumnarError extends OrganizationOutputError {
  constructor(reason: "json" | "schema", field = "root", detail?: string) {
    super(reason, field, 1, {
      issues: [{ reason, field, ...(detail ? { detail } : {}) }],
      missing: [],
      duplicates: [],
    });
  }
}

const invalid = (field: string, detail: string): never => {
  throw new OrganizationColumnarError("schema", field, detail);
};

function object(
  value: unknown,
  keys: string[],
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid(field, "object");
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid(field, "keys");
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    return invalid(field, "array");
  return value;
}

function string(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  )
    return invalid(field, "string");
  return value;
}

const strings = (
  value: unknown,
  minimum: number,
  maximum: number,
  width: number,
  field: string,
  allowEmpty = false,
) =>
  array(value, minimum, maximum, field).map((item, index) =>
    string(item, allowEmpty ? 0 : 1, width, `${field}.${index}`),
  );

function cell(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  const files =
    typeof value === "string"
      ? [string(value, 1, 128, field)]
      : strings(value, 2, 20000, 128, field);
  if (files.some((file) => !/^f[1-9][0-9]*$/.test(file)))
    return invalid(field, "individualFileReference");
  return files;
}

/** Strict, lossless decoding; null cells never infer or retain a file. */
export function decodeColumnarOrganization(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new OrganizationColumnarError("json");
    throw error;
  }
  const value = object(parsed, ["g", "u", "c"], "root");
  const groups = array(value.g, 0, 2000, "g").map((entry, index) => {
    const field = `g.${index}`;
    const group = object(entry, ["i", "t", "f", "r", "e", "q", "m"], field);
    if (typeof group.q !== "boolean") return invalid(`${field}.q`, "boolean");
    const representations = array(group.r, 0, 20000, `${field}.r`).map(
      (item, position) => {
        const location = `${field}.r.${position}`;
        const representation = object(item, ["l", "k"], location);
        return {
          label: string(representation.l, 0, 200, `${location}.l`),
          releaseKey: string(representation.k, 0, 200, `${location}.k`),
        };
      },
    );
    const table = object(group.e, ["n", "t", "v"], `${field}.e`);
    const numbers = strings(table.n, 0, 20000, 100, `${field}.e.n`, true);
    const titles = strings(table.t, 0, 20000, 500, `${field}.e.t`, true);
    if (numbers.length !== titles.length)
      return invalid(`${field}.e.t`, "rowCount");
    const episodes = numbers.map((number, position) => ({
      number,
      title: titles[position],
      versions: [] as {
        label: string;
        releaseKey: string;
        fileIds: string[];
      }[],
    }));
    array(table.v, 0, 20000, `${field}.e.v`).forEach((item, position) => {
      const location = `${field}.e.v.${position}`;
      const column = object(item, ["r", "f"], location);
      if (
        typeof column.r !== "number" ||
        !Number.isSafeInteger(column.r) ||
        column.r < 0 ||
        column.r >= representations.length
      )
        return invalid(`${location}.r`, "representationIndex");
      const representation = representations[column.r];
      const cells = array(column.f, 1, 20000, `${location}.f`);
      if (cells.length !== episodes.length)
        return invalid(`${location}.f`, "rowCount");
      let populated = 0;
      cells.forEach((item, episodeIndex) => {
        const fileIds = cell(item, `${location}.f.${episodeIndex}`);
        if (fileIds !== null) {
          episodes[episodeIndex].versions.push({ ...representation, fileIds });
          populated++;
        }
      });
      if (!populated) return invalid(location, "emptyColumn");
    });
    if (episodes.some((episode) => !episode.versions.length))
      return invalid(`${field}.e`, "emptyEpisode");
    return {
      identity: string(group.i, 1, 200, `${field}.i`),
      title: string(group.t, 1, 500, `${field}.t`),
      fileIds: strings(group.f, 1, 20000, 128, `${field}.f`),
      episodes,
      review: group.q,
      reason: string(group.m, 0, 1000, `${field}.m`),
    };
  });
  const collections = array(value.c, 0, 200, "c").map((item, index) => {
    const field = `c.${index}`;
    const legacy = typeof item === "object" && item !== null && !("k" in item);
    const collection = object(
      item,
      legacy ? ["n", "g"] : ["k", "n", "g"],
      field,
    );
    if (!legacy && collection.k !== "series" && collection.k !== "collection")
      return invalid(`${field}.k`, "relationshipKind");
    return {
      ...(!legacy ? { kind: collection.k } : {}),
      name: string(collection.n, 1, 100, `${field}.n`),
      groupIds: strings(collection.g, 2, 500, 200, `${field}.g`),
    };
  });
  return JSON.stringify({
    groups,
    unassigned: strings(value.u, 0, 20000, 128, "u"),
    collections,
  });
}
