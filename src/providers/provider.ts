import path from "node:path";
import type { Entry } from "../shared/model";
export interface StorageProvider {
  list(directory: string, signal?: AbortSignal): Promise<Entry[]>;
}
export const videoExtensions = new Set([
  ".mp4",
  ".m4v",
  ".webm",
  ".mkv",
  ".mov",
  ".avi",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
  ".rmvb",
  ".rm",
  ".wmv",
  ".flv",
]);
export function isVideo(entry: Entry): boolean {
  return (
    !entry.directory &&
    entry.size > 0 &&
    videoExtensions.has(path.extname(entry.name).toLowerCase())
  );
}
export function containsPath(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export function containsRemote(root: string, target: string): boolean {
  return target === root || target.startsWith(root.replace(/\/$/, "") + "/");
}
export class ProviderError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
