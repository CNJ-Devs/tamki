import { app, dialog, protocol, shell as systemShell } from "electron";
import { realpath, readdir, stat } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { LibraryStore } from "./store";
import { scanRoot } from "./scan";
import { LocalProvider } from "../providers/local";
import { ZSpaceCLI, ZSpaceProvider } from "../providers/zspace";
import {
  containsRemote,
  containsPath,
  isVideo,
  ProviderError,
  type StorageProvider,
} from "../providers/provider";
import {
  collectionSchema,
  connectionSchema,
  editSchema,
  id,
  location,
  preferencesSchema,
  progressSchema,
} from "../shared/validation";
import type { Connection, Entry } from "../shared/model";
import { mediaType, parseRange } from "./range";

interface Draft {
  id: string;
  type: "local" | "zspace";
  roots: string[];
  authorized: boolean;
  url?: string;
}
export class LibraryService {
  readonly store: LibraryStore;
  private refreshing = false;
  private refreshTask?: Promise<void>;
  private controller = new AbortController();
  private drafts = new Map<string, Draft>();
  private cli?: ZSpaceCLI;
  private ticket = randomBytes(32).toString("hex");
  constructor(private emit: () => void) {
    this.store = new LibraryStore(
      path.join(app.getPath("userData"), "library.sqlite"),
      app.getLocale().startsWith("zh") ? "zh" : "en",
    );
  }
  snapshot() {
    return this.store.snapshot(this.refreshing);
  }
  private async selectedFiles(
    connectionId: string,
    paths: string[],
  ): Promise<Entry[]> {
    const connection = this.store.connection(connectionId);
    const provider = await this.provider(connection);
    const entries = new Map<string, Entry[]>();
    for (const target of paths) {
      const directory =
        connection.type === "local"
          ? path.dirname(target)
          : path.posix.dirname(target);
      if (!entries.has(directory))
        entries.set(
          directory,
          await provider.list(directory, this.controller.signal),
        );
    }
    return paths.map((target) => {
      const file = [...entries.values()]
        .flat()
        .find((e) => e.path === target && isVideo(e));
      if (!file) throw new ProviderError("mediaMissing");
      return file;
    });
  }
  private async runtime() {
    if (this.cli) return this.cli;
    let executable = this.store.config("zspaceExecutable");
    if (!executable) {
      const cache =
        process.platform === "darwin"
          ? path.join(os.homedir(), "Library/Caches/zspace-nas-agent-toolkit")
          : process.platform === "win32"
            ? path.join(
                process.env.LOCALAPPDATA ||
                  path.join(os.homedir(), "AppData/Local"),
                "ZSpace/AgentToolkit/cache",
              )
            : path.join(
                process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
                "zspace-nas-agent-toolkit",
              );
      try {
        const versions = (await readdir(cache))
          .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
          const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
          const candidate = path.join(
            cache,
            version,
            platform,
            `zspace-cli-v${version}-${platform}${process.platform === "win32" ? ".exe" : ""}`,
          );
          if ((await stat(candidate).catch(() => null))?.isFile()) {
            executable = candidate;
            break;
          }
        }
      } catch {}
    }
    if (!executable) throw new ProviderError("cliUnavailable");
    this.cli = new ZSpaceCLI(
      executable,
      path.join(app.getPath("userData"), "zspace"),
    );
    return this.cli;
  }
  private async provider(
    connection: Pick<Connection, "id" | "type" | "roots">,
  ): Promise<StorageProvider> {
    return connection.type === "local"
      ? new LocalProvider(connection.roots)
      : new ZSpaceProvider(
          (await this.runtime()).runner(connection.id),
          connection.roots,
        );
  }
  refresh() {
    if (this.refreshTask) return this.refreshTask;
    this.refreshing = true;
    this.emit();
    this.refreshTask = (async () => {
      for (const connection of this.store.connections()) {
        if (this.controller.signal.aborted) break;
        this.store.saveConnection({
          ...connection,
          status: "scanning",
          error: null,
        });
        this.emit();
        let failed = false;
        try {
          const provider = await this.provider(connection);
          for (const root of connection.roots) {
            try {
              const result = await scanRoot(
                provider,
                root,
                this.controller.signal,
              );
              this.store.applyScan(connection.id, root, result);
              failed ||= result.failures.length > 0;
            } catch {
              failed = true;
            }
          }
          this.store.saveConnection({
            ...connection,
            status: failed ? "offline" : "connected",
            error: failed ? "scanPartial" : null,
            scannedAt: failed ? connection.scannedAt : Date.now(),
          });
        } catch {
          this.store.saveConnection({
            ...connection,
            status: "offline",
            error: "connectionFailed",
          });
        }
        this.emit();
      }
    })().finally(() => {
      this.refreshing = false;
      this.refreshTask = undefined;
      this.emit();
    });
    return this.refreshTask;
  }
  async request(type: string, value: unknown): Promise<unknown> {
    switch (type) {
      case "state":
        return this.snapshot();
      case "preferences":
        this.store.setPreferences(preferencesSchema.parse(value));
        break;
      case "refresh":
        void this.refresh();
        break;
      case "choose-local": {
        const choice = await dialog.showOpenDialog({
          properties: ["openDirectory", "multiSelections"],
        });
        if (choice.canceled) return null;
        const roots = [
          ...new Set(
            await Promise.all(choice.filePaths.map((p) => realpath(p))),
          ),
        ];
        const draft: Draft = {
          id: randomUUID(),
          type: "local",
          roots,
          authorized: true,
        };
        this.drafts.set(draft.id, draft);
        return draft;
      }
      case "choose-cli": {
        const choice = await dialog.showOpenDialog({
          properties: ["openFile"],
        });
        if (choice.canceled) return false;
        const chosen = await realpath(choice.filePaths[0]);
        if (!/^zspace-cli(?:[-.\w]+)?(?:\.exe)?$/.test(path.basename(chosen)))
          throw new ProviderError("cliUnavailable");
        this.cli?.close();
        this.cli = undefined;
        this.store.setConfig("zspaceExecutable", chosen);
        return true;
      }
      case "zspace-begin": {
        const draft: Draft = {
          id: randomUUID(),
          type: "zspace",
          roots: [],
          authorized: false,
        };
        this.drafts.set(draft.id, draft);
        try {
          const auth = await (await this.runtime()).begin(draft.id);
          draft.url = auth.url;
          return { draftId: draft.id, ...auth };
        } catch (error) {
          this.drafts.delete(draft.id);
          throw error;
        }
      }
      case "zspace-open": {
        const draft = this.drafts.get(id.parse(value));
        if (!draft?.url) throw new ProviderError("authExpired");
        await systemShell.openExternal(draft.url);
        return true;
      }
      case "zspace-finish": {
        const input = z
          .object({ draftId: id, code: z.string().max(100) })
          .strict()
          .parse(value);
        const draft = this.drafts.get(input.draftId);
        if (!draft || draft.type !== "zspace")
          throw new ProviderError("authExpired");
        const cli = await this.runtime();
        await cli.finish(draft.id, input.code.trim());
        draft.roots = await ZSpaceProvider.spaces(cli.runner(draft.id));
        draft.authorized = true;
        return draft;
      }
      case "cancel-draft": {
        const key = id.parse(value);
        this.cli?.cancel(key);
        this.drafts.delete(key);
        return true;
      }
      case "list": {
        const input = z.object({ id, path: location }).strict().parse(value);
        const source =
          this.drafts.get(input.id) || this.store.connection(input.id);
        if ("authorized" in source && !source.authorized)
          throw new ProviderError("authExpired");
        return (await this.provider(source)).list(
          input.path,
          this.controller.signal,
        );
      }
      case "save-connection": {
        if (this.refreshing) throw new ProviderError("scanBusy");
        const input = connectionSchema.parse(value);
        const previous = input.id ? this.store.connection(input.id) : null;
        const draft = input.draftId ? this.drafts.get(input.draftId) : null;
        const source =
          draft &&
          previous &&
          draft.type === "local" &&
          previous.type === "local"
            ? {
                ...draft,
                roots: [...new Set([...previous.roots, ...draft.roots])],
              }
            : draft || previous;
        if (
          !source ||
          source.type !== input.type ||
          (draft && !draft.authorized)
        )
          throw new ProviderError("invalidInput");
        const roots = [...new Set(input.roots)];
        const provider = await this.provider(source);
        for (const root of roots) {
          if (
            !source.roots.some((r) =>
              source.type === "local"
                ? containsPath(r, root)
                : containsRemote(r, root),
            )
          )
            throw new ProviderError("outsideRoot");
          await provider.list(root, this.controller.signal);
        }
        const normalized = roots;
        this.store.saveConnection({
          id: previous?.id || source.id,
          name: input.name,
          type: source.type,
          roots: normalized,
          status: "connected",
          error: null,
          scannedAt: previous?.scannedAt || null,
        });
        if (draft) this.drafts.delete(draft.id);
        void this.refresh();
        break;
      }
      case "test-connection": {
        const connection = this.store.connection(id.parse(value));
        for (const root of connection.roots)
          await (
            await this.provider(connection)
          ).list(root, this.controller.signal);
        this.store.saveConnection({
          ...connection,
          status: "connected",
          error: null,
        });
        break;
      }
      case "remove-connection":
        if (this.refreshing) throw new ProviderError("scanBusy");
        this.store.removeConnection(id.parse(value));
        break;
      case "add-files": {
        const input = z
          .object({
            connectionId: id,
            paths: z.array(location).min(1).max(1000),
          })
          .strict()
          .parse(value);
        const connection = this.store.connection(input.connectionId),
          provider = await this.provider(connection);
        const entries = new Map<
          string,
          Awaited<ReturnType<StorageProvider["list"]>>
        >();
        for (const target of input.paths) {
          const directory =
            connection.type === "local"
              ? path.dirname(target)
              : path.posix.dirname(target);
          if (!entries.has(directory))
            entries.set(directory, await provider.list(directory));
        }
        const files = input.paths.map((target) =>
          [...entries.values()]
            .flat()
            .find((e) => e.path === target && isVideo(e)),
        );
        if (files.some((file) => !file))
          throw new ProviderError("mediaMissing");
        this.store.applyScan(
          connection.id,
          connection.roots[0],
          {
            groups: files.map((file) => ({
              path: file!.path,
              name: file!.name.replace(/\.[^.]+$/, ""),
              files: [file!],
            })),
            completeDirectories: [],
            failures: [],
          },
          true,
        );
        break;
      }
      case "prepare-episodes": {
        const input = z
          .object({
            workId: id,
            connectionId: id,
            paths: z.array(location).min(1).max(1000),
          })
          .strict()
          .parse(value);
        return this.store.prepareEpisodes(
          input.workId,
          input.connectionId,
          await this.selectedFiles(input.connectionId, input.paths),
        );
      }
      case "edit": {
        const input = editSchema.parse(value);
        const additions = [];
        for (const connectionId of new Set(
          input.attachments.map((a) => a.connectionId),
        )) {
          const files = await this.selectedFiles(
            connectionId,
            input.attachments
              .filter((a) => a.connectionId === connectionId)
              .map((a) => a.path),
          );
          additions.push(
            ...this.store.prepareEpisodes(input.id, connectionId, files),
          );
        }
        this.store.edit(input, additions);
        break;
      }
      case "remove-work":
        this.store.removeWork(id.parse(value));
        break;
      case "reorder":
        this.store.reorder(z.array(id).max(100000).parse(value));
        break;
      case "save-collection":
        this.store.saveCollection(collectionSchema.parse(value));
        break;
      case "remove-collection":
        this.store.removeCollection(id.parse(value));
        break;
      case "progress": {
        const input = progressSchema.parse(value);
        this.store.setProgress(
          input.id,
          input.position,
          input.duration,
          input.resume,
        );
        break;
      }
      case "media": {
        const episode = this.store.episode(id.parse(value));
        if (episode.missing) throw new ProviderError("mediaMissing");
        this.store.connection(episode.connectionId);
        return `tamki-media://video/${episode.id}?ticket=${this.ticket}`;
      }
      default:
        throw new ProviderError("invalidInput");
    }
    this.emit();
    return this.snapshot();
  }
  registerMedia() {
    protocol.handle("tamki-media", async (request) => {
      try {
        const url = new URL(request.url);
        if (
          url.hostname !== "video" ||
          url.searchParams.get("ticket") !== this.ticket ||
          !["GET", "HEAD"].includes(request.method)
        )
          return new Response(null, { status: 403 });
        const episode = this.store.episode(id.parse(url.pathname.slice(1)));
        if (episode.missing) return new Response(null, { status: 404 });
        const connection = this.store.connection(episode.connectionId);
        const provider = await this.provider(connection);
        let size = episode.size,
          local: string | undefined;
        if (provider instanceof LocalProvider) {
          local = await provider.resolve(episode.path);
          const info = await stat(local);
          if (!info.isFile()) return new Response(null, { status: 404 });
          size = info.size;
        }
        const range = parseRange(request.headers.get("range"), size);
        if (!range)
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        const headers: Record<string, string> = {
          "Content-Type": mediaType(episode.fileName),
          "Accept-Ranges": "bytes",
          "Content-Length": String(range.end - range.start + 1),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Access-Control-Allow-Origin": "null",
        };
        if (range.partial)
          headers["Content-Range"] =
            `bytes ${range.start}-${range.end}/${size}`;
        if (request.method === "HEAD")
          return new Response(null, {
            status: range.partial ? 206 : 200,
            headers,
          });
        let body: ReadableStream;
        if (local) {
          const stream = createReadStream(local, {
            start: range.start,
            end: range.end,
          });
          request.signal.addEventListener("abort", () => stream.destroy(), {
            once: true,
          });
          body = Readable.toWeb(stream) as ReadableStream;
        } else {
          const abort = new AbortController();
          request.signal.addEventListener("abort", () => abort.abort(), {
            once: true,
          });
          let offset = range.start;
          body = new ReadableStream(
            {
              async pull(controller) {
                try {
                  const bytes = await (provider as ZSpaceProvider).read(
                    episode.path,
                    offset,
                    Math.min(1024 * 1024, range.end - offset + 1),
                    size,
                    abort.signal,
                  );
                  offset += bytes.length;
                  controller.enqueue(bytes);
                  if (offset > range.end) controller.close();
                } catch (e) {
                  controller.error(e);
                }
              },
              cancel() {
                abort.abort();
              },
            },
            { highWaterMark: 1 },
          );
        }
        return new Response(body, {
          status: range.partial ? 206 : 200,
          headers,
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  }
  async close() {
    this.controller.abort();
    this.cli?.close();
    await this.refreshTask;
    this.store.close();
  }
}
