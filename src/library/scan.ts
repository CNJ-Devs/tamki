import type { Entry } from "../shared/model";
import { isVideo, type StorageProvider } from "../providers/provider";
export interface ScanGroup {
  path: string;
  name: string;
  files: Entry[];
}
export interface ScanResult {
  groups: ScanGroup[];
  completeDirectories: string[];
  failures: string[];
}
// A root and its direct child directories only. A failed directory never clears its cached records.
export async function scanRoot(
  provider: StorageProvider,
  root: string,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const entries = await provider.list(root, signal);
  const result: ScanResult = {
    groups: entries
      .filter(isVideo)
      .map((file) => ({
        path: file.path,
        name: file.name.replace(/\.[^.]+$/, ""),
        files: [file],
      })),
    completeDirectories: [root],
    failures: [],
  };
  const folders = entries.filter((e) => e.directory);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, folders.length) }, async () => {
      while (cursor < folders.length) {
        signal?.throwIfAborted();
        const folder = folders[cursor++];
        try {
          const files = (await provider.list(folder.path, signal)).filter(
            isVideo,
          );
          result.completeDirectories.push(folder.path);
          if (files.length)
            result.groups.push({ path: folder.path, name: folder.name, files });
        } catch (error) {
          signal?.throwIfAborted();
          result.failures.push(folder.path);
        }
      }
    }),
  );
  result.groups.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  return result;
}
