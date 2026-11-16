import { z } from "zod";
export const id = z.string().min(1).max(128);
export const location = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes("\0"));
export const preferencesSchema = z
  .object({
    language: z.enum(["en", "zh"]),
    palette: z.enum(["hazel", "forest", "mist", "iris", "rose", "lagoon"]),
    mode: z.enum(["light", "dark", "system"]),
    refreshOnOpen: z.boolean(),
  })
  .strict();
export const connectionSchema = z
  .object({
    id: id.optional(),
    type: z.enum(["local", "zspace"]),
    name: z.string().trim().min(1).max(100),
    roots: z.array(location).min(1).max(64),
    scanDepths: z.record(location, z.number().int().min(0).max(32)).optional(),
    allowLANHTTP: z.boolean().optional(),
    draftId: id.optional(),
  })
  .strict();
export const editSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(30000),
    tags: z.array(z.string().trim().min(1).max(100)).max(100),
    cover: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    metadataReviewed: z.boolean().optional(),
    removedEpisodeIds: z.array(id).max(10000),
    attachments: z
      .array(z.object({ connectionId: id, path: location }).strict())
      .max(1000)
      .default([]),
    episodes: z
      .array(
        z
          .object({
            id,
            number: z.string().max(100),
            title: z.string().max(500),
            description: z.string().max(30000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export const mediaSelectionSchema = z
  .object({
    id,
    versionId: id.optional(),
    fileId: id.optional(),
  })
  .strict();
export const progressSchema = mediaSelectionSchema
  .extend({
    position: z.number().finite().min(0).max(1e8),
    duration: z.number().finite().positive().max(1e8),
    resume: z.boolean().default(true),
  })
  .strict();
export const collectionSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(100),
    workIds: z.array(id).max(100000),
    seriesIds: z.array(id).max(10000).optional(),
  })
  .strict();

export const seriesSchema = collectionSchema
  .omit({ seriesIds: true })
  .extend({ workIds: z.array(id).min(1).max(10000) });
