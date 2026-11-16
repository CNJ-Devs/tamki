import { z } from "zod";
import { targetSchema } from "./settings";
import type { Connection, Preferences } from "./model";

const positive = z.number().int().positive().safe();
export const captureMetadataSchema = z
  .object({
    id: z.string().min(1).max(150),
    url: z.string().url().max(2048),
    title: z.string().max(500),
    description: z.string().max(20000),
    cover: z.string().url().max(2048).optional(),
    tags: z.array(z.string().max(100)).max(50),
  })
  .strict();
export type CaptureMetadata = z.infer<typeof captureMetadataSchema>;
export const captureResourceSchema = z
  .object({
    provider: z.literal("bilibili"),
    quality: z.number().int().positive().max(1000).optional(),
    id: z.string().min(1).max(150),
    title: z.string().min(1).max(500),
    aid: positive,
    bvid: z.string().regex(/^BV[a-zA-Z0-9]{10}$/),
    cid: positive,
    episodeId: positive.optional(),
    duration: z.number().finite().nonnegative().nullable(),
    metadata: z
      .object({
        title: z.string().max(500),
        number: z.string().max(100),
        description: z.string().max(20000),
        cover: z.string().url().max(2048).optional(),
      })
      .strict()
      .optional(),
    workMetadata: captureMetadataSchema.optional(),
  })
  .strict();
export type CaptureResource = z.infer<typeof captureResourceSchema>;
export interface CaptureGroup {
  id: string;
  title: string;
  resources: CaptureResource[];
  /** Explicit platform sections; resources above are their ordered union. */
  sections?: CaptureGroup[];
  incomplete?: boolean;
  metadata?: CaptureMetadata;
}
export interface CaptureSeries {
  id: string;
  title: string;
  groupIds: string[];
}
export interface CaptureResult {
  id: string;
  pageURL: string;
  current?: CaptureResource;
  groups: CaptureGroup[];
  series?: CaptureSeries[];
  collectionError?: string;
  metadata?: CaptureMetadata;
}
export interface CaptureSnapshot {
  status: "loading" | "ready" | "empty" | "failed";
  result?: CaptureResult;
  error?: string;
}
export const downloadNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (v) =>
      !/[<>:"/\\|?*\x00-\x1f]/.test(v) &&
      new TextEncoder().encode(v).length <= 240 &&
      !/[. ]$/.test(v) &&
      !/^\.+$/.test(v) &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(v),
    "downloadNameInvalid",
  );
export const captureSelectionSchema = z
  .object({
    resultId: z.string().min(1).max(150),
    resourceId: z.string().min(1).max(150).optional(),
    groupId: z.string().min(1).max(150).optional(),
    seriesId: z.string().min(1).max(150).optional(),
  })
  .strict()
  .refine(
    (v) => [v.resourceId, v.groupId, v.seriesId].filter(Boolean).length === 1,
  );
export const downloadSubmitSchema = z
  .object({
    draftId: z.string().uuid(),
    qualities: z
      .array(z.number().int().min(0).max(1000))
      .min(1)
      .max(20)
      .optional(),
    name: downloadNameSchema,
    target: targetSchema,
  })
  .strict();
export type DownloadSubmit = z.infer<typeof downloadSubmitSchema>;
export interface CaptureQuality {
  id: number;
  label: string;
}
export interface DownloadDraft {
  qualities?: CaptureQuality[];
  qualityError?: string;
  id: string;
  name: string;
  count: number;
  series: boolean;
  hierarchy?: { title: string; count: number }[];
  target: z.infer<typeof targetSchema> | null;
}
export interface CaptureViewState {
  surface: "reel" | "panel";
  open: boolean;
  pinned: boolean;
  snapshot: CaptureSnapshot;
  preferences: Preferences;
  draft?: DownloadDraft;
  connections: Connection[];
}
export type VideoDownloadState =
  "queued" | "running" | "paused" | "failed" | "cancelled" | "completed";
export type VideoDownloadStage =
  | "resolving"
  | "transferring"
  | "waitingMerge"
  | "merging"
  | "waitingSave"
  | "saving";
export interface VideoDownloadItem {
  id: string;
  resource: CaptureResource;
  groupId?: string;
  name: string;
  state: VideoDownloadState;
  stage: VideoDownloadStage;
  received: number;
  total: number;
  quality?: number;
  qualityLabel?: string;
  uploaded?: number;
  uploadTotal?: number;
  progress?: number;
  error?: string;
  path?: string;
  episodeId?: string;
}
export interface VideoDownloadJob {
  id: string;
  name: string;
  target: z.infer<typeof targetSchema>;
  series: boolean;
  createdAt: number;
  items: VideoDownloadItem[];
  groups?: {
    id: string;
    title: string;
    target: z.infer<typeof targetSchema>;
    metadata?: CaptureMetadata;
  }[];
  librarySeriesCreated?: boolean;
  metadata?: CaptureMetadata;
}
export const downloadActionSchema = z
  .object({
    id: z.string().uuid(),
    itemId: z.string().uuid().optional(),
    action: z.enum(["pause", "resume", "retry", "cancel", "remove"]),
  })
  .strict();
export function safeDownloadName(value: string): string {
  let name = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 140)
    .trim();
  while (new TextEncoder().encode(name).length > 220)
    name = Array.from(name).slice(0, -1).join("");
  name = name.replace(/[. ]+$/, "");
  return downloadNameSchema.safeParse(name).success ? name : "Video";
}
declare global {
  interface Window {
    tamkiCapture: {
      action<T = unknown>(type: string, value?: unknown): Promise<T>;
      onState(callback: (state: CaptureViewState) => void): () => void;
    };
  }
}

export function videoQualityLabel(id: number): string {
  return (
    (
      {
        6: "240P",
        16: "360P",
        32: "480P",
        64: "720P",
        74: "720P 60FPS",
        80: "1080P",
        112: "1080P+",
        116: "1080P 60FPS",
        120: "4K",
        125: "HDR",
        126: "Dolby Vision",
        127: "8K",
      } as Record<number, string>
    )[id] || `Q${id}`
  );
}
