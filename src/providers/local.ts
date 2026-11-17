import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Entry } from "../shared/model";
import { containsPath, ProviderError, type StorageProvider } from "./provider";
export class LocalProvider implements StorageProvider {
  constructor(private roots: string[]) {}
  async resolve(target: string): Promise<string> {
    const canonical = await realpath(target);
    // Stored roots are the canonical paths granted through the native picker.
    if (!this.roots.some((root) => containsPath(root, canonical)))
      throw new ProviderError("outsideRoot");
    return canonical;
  }
  async list(directory: string, signal?: AbortSignal): Promise<Entry[]> {
    const canonical = await this.resolve(directory);
    const children = await readdir(canonical, { withFileTypes: true });
    const entries: Entry[] = [];
    for (const child of children) {
      signal?.throwIfAborted();
      if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory()))
        continue;
      const target = path.join(canonical, child.name);
      let info;
      try {
        info = await stat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      entries.push({
        path: target,
        name: child.name,
        directory: child.isDirectory(),
        size: info.size,
        modified: info.mtimeMs,
      });
    }
    return entries.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  }
}
