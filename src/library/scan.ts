import path from "node:path";
import type { Entry } from "../shared/model";
import { isVideo, type StorageProvider } from "../providers/provider";
export interface ScanGroup {
  path: string;
  name: string;
  root?: string;
  files: Entry[];
}
export interface ScanScope {
  root: string;
  depth: number;
}
export interface ScanResult {
  groups: ScanGroup[];
  completeDirectories: string[];
  failures: string[];
  /** Only successful listings are evidence of absence. */
  children?: Record<string, string[]>;
  scopes?: ScanScope[];
}
const technical =
  /^(?:(?:2160|1080|720|480)[pi]?|[248]k|uhd|fhd|hd|sd|bluray|blu-ray|bdrip|webrip|web-dl|h[ .]?26[45]|hevc|avc|x26[45]|10bit|8bit|hdr10?|sdr|dv)(?:[ ._+-]+(?:(?:2160|1080|720|480)[pi]?|[248]k|uhd|fhd|hd|sd|bluray|blu-ray|bdrip|webrip|web-dl|h[ .]?26[45]|hevc|avc|x26[45]|10bit|8bit|hdr10?|sdr|dv))*$/i;
const season =
  /^(?:s\d{1,3}|season[ ._-]*\d{1,3}|第[一二三四五六七八九十百\d]+[季部])$/i;
const pathsFor = (value: string) =>
  value.includes("\\") ? path.win32 : path.posix;
export function relativeDepth(root: string, directory: string): number | null {
  const paths = pathsFor(root),
    rel = paths.relative(root, directory);
  if (!rel) return 0;
  if (rel === ".." || rel.startsWith(`..${paths.sep}`) || paths.isAbsolute(rel))
    return null;
  return rel.split(paths.sep).length;
}
function classify(
  directory: string,
  root: string,
): { path: string; name: string } {
  const paths = pathsFor(root);
  let owner = directory;
  while (owner !== root && technical.test(paths.basename(owner)))
    owner = paths.dirname(owner);
  // Do not create a work named only after a quality directory at the selected root.
  if (owner === root) owner = directory;
  let name = paths.basename(owner);
  if (season.test(name) && paths.dirname(owner) !== root)
    name = `${paths.basename(paths.dirname(owner))} · ${name}`;
  return { path: owner, name };
}
/** Bounded breadth-first traversal. Roots overlap without losing the child's additional scope. */
export async function scanScopes(
  provider: StorageProvider,
  scopes: ScanScope[],
  signal?: AbortSignal,
  limits?: { files: number; directories: number },
): Promise<ScanResult> {
  for (const scope of scopes)
    if (!Number.isInteger(scope.depth) || scope.depth < 0 || scope.depth > 32)
      throw new Error("invalidInput");
  const result: ScanResult = {
    groups: [],
    completeDirectories: [],
    failures: [],
    children: {},
    scopes,
  };
  const listings = new Map<string, Entry[]>(),
    visited = new Set<string>();
  let frontier = [...new Set(scopes.map((s) => s.root))];
  let fileCount = 0;
  while (frontier.length) {
    signal?.throwIfAborted();
    const batch = frontier.filter((dir) => !visited.has(dir));
    frontier = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, batch.length) }, async () => {
        while (cursor < batch.length) {
          signal?.throwIfAborted();
          const directory = batch[cursor++];
          if (limits && visited.size >= limits.directories)
            throw new Error("organizationTooLarge");
          if (visited.size >= 10000) {
            result.failures.push(directory);
            continue;
          }
          visited.add(directory);
          try {
            const entries = await provider.list(directory, signal);
            signal?.throwIfAborted();
            const paths = pathsFor(directory);
            // Providers must return direct children; reject cycles and out-of-scope paths.
            if (
              entries.some(
                (e) =>
                  e.path === directory || paths.dirname(e.path) !== directory,
              )
            )
              throw new Error("invalidListing");
            const children = entries;
            fileCount += children.filter(isVideo).length;
            if (limits && fileCount > limits.files)
              throw new Error("organizationTooLarge");
            listings.set(directory, children);
            result.completeDirectories.push(directory);
            result.children![directory] = children
              .filter((e) => e.directory)
              .map((e) => e.path);
            for (const entry of children) {
              if (!entry.directory || visited.has(entry.path)) continue;
              if (
                scopes.some((s) => {
                  const d = relativeDepth(s.root, entry.path);
                  return d !== null && d <= s.depth;
                })
              )
                frontier.push(entry.path);
            }
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "organizationTooLarge"
            )
              throw error;
            signal?.throwIfAborted();
            result.failures.push(directory);
          }
        }
      }),
    );
    frontier = [...new Set(frontier)];
  }
  const groups = new Map<string, ScanGroup>(),
    filesSeen = new Set<string>();
  // The broadest containing root gives stable grouping when additional roots extend coverage.
  for (const [directory, entries] of [...listings].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const scope = scopes
      .filter((s) => relativeDepth(s.root, directory) !== null)
      .sort((a, b) => a.root.length - b.root.length)[0]!;
    for (const file of entries
      .filter(isVideo)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      )) {
      if (filesSeen.has(file.path)) continue;
      filesSeen.add(file.path);
      const owner =
        directory === scope.root
          ? { path: file.path, name: file.name.replace(/\.[^.]+$/, "") }
          : classify(directory, scope.root);
      const group = groups.get(owner.path) || {
        ...owner,
        root: scope.root,
        files: [],
      };
      group.files.push(file);
      groups.set(owner.path, group);
    }
  }
  result.groups = [...groups.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  return result;
}
export async function scanRoot(
  provider: StorageProvider,
  root: string,
  signal?: AbortSignal,
  depth = 1,
): Promise<ScanResult> {
  return scanScopes(provider, [{ root, depth }], signal);
}
