import path from "node:path";
import {
  copyFile,
  link,
  unlink,
  mkdir,
  stat,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { downloadNameSchema } from "../shared/capture";
import type { SaveTarget } from "../shared/settings";
import type { Connection } from "../shared/model";
import {
  containsRemote,
  ProviderError,
  type StorageProvider,
} from "../providers/provider";
import { LocalProvider } from "../providers/local";
import { ZSpaceProvider } from "../providers/zspace";

export class CaptureStorage {
  constructor(
    private options: {
      connection(id: string): Connection;
      provider(connection: Connection): Promise<StorageProvider>;
      upload(
        connectionId: string,
        args: string[],
        signal: AbortSignal,
      ): Promise<unknown>;
    },
  ) {}
  private async directory(target: SaveTarget) {
    const connection = this.options.connection(target.connectionId);
    const provider = await this.options.provider(connection);
    const directory =
      connection.type === "local"
        ? await (provider as LocalProvider).resolve(target.path)
        : target.path;
    if (
      connection.type === "zspace" &&
      (path.posix.normalize(directory) !== directory ||
        !(connection.browseRoots || connection.roots).some((r) =>
          containsRemote(r, directory),
        ))
    )
      throw new ProviderError("outsideRoot");
    const entries = await provider.list(directory);
    return { connection, provider, directory, entries };
  }
  async mkdir(target: SaveTarget, name: string): Promise<SaveTarget> {
    downloadNameSchema.parse(name);
    const { connection, provider, directory, entries } =
      await this.directory(target);
    const existing = entries.find((e) => e.name === name);
    if (existing) {
      if (!existing.directory) throw new ProviderError("downloadExists");
      return { connectionId: connection.id, path: existing.path };
    }
    if (connection.type === "local") {
      const created = path.join(directory, name);
      await mkdir(created, { mode: 0o700 });
      return {
        connectionId: connection.id,
        path: await (provider as LocalProvider).resolve(created),
      };
    }
    await this.options.upload(
      connection.id,
      [
        "file",
        "mkdir",
        "--params",
        JSON.stringify({ parent: directory, name, rename: 0 }),
        "--yes",
      ],
      new AbortController().signal,
    );
    const created = (await provider.list(directory)).find(
      (e) => e.directory && e.name === name,
    );
    if (!created) throw new ProviderError("downloadSaveFailed");
    return { connectionId: connection.id, path: created.path };
  }
  async target(
    target: SaveTarget,
    name: string,
    series: boolean,
  ): Promise<SaveTarget> {
    const { connection, directory } = await this.directory(target);
    if (
      series &&
      (connection.type === "local"
        ? path.basename(directory)
        : path.posix.basename(directory)) !== name
    )
      return this.mkdir(target, name);
    return { connectionId: connection.id, path: directory };
  }
  async publish(
    file: string,
    target: SaveTarget,
    name: string,
    id: string,
    signal: AbortSignal,
    progress?: (bytes: number, total: number) => void,
  ): Promise<string> {
    downloadNameSchema.parse(name);
    const { connection, provider, directory, entries } =
      await this.directory(target);
    signal.throwIfAborted();
    const existing = entries.find((e) => e.name === name);
    const size = (await stat(file)).size;
    if (!size) throw new ProviderError("downloadInvalid");
    if (existing) {
      if (existing.directory || existing.size !== size)
        throw new ProviderError("downloadExists");
      // A retry may follow a successful upload whose final acknowledgement was lost.
      // Never overwrite: compare stored bytes with this task's retained output first.
      const local = await open(file, "r");
      const remoteLocal =
        connection.type === "local"
          ? await open(
              await (provider as LocalProvider).resolve(existing.path),
              "r",
            )
          : null;
      try {
        for (const offset of new Set([
          0,
          Math.floor(Math.max(0, size - 4096) / 2),
          Math.max(0, size - 4096),
        ])) {
          const length = Math.min(4096, size - offset),
            expected = Buffer.alloc(length);
          await local.read(expected, 0, length, offset);
          let actual: Uint8Array;
          if (remoteLocal) {
            const buffer = Buffer.alloc(length);
            await remoteLocal.read(buffer, 0, length, offset);
            actual = buffer;
          } else
            actual = await (provider as ZSpaceProvider).read(
              existing.path,
              offset,
              length,
              size,
              signal,
            );
          if (!Buffer.from(actual).equals(expected))
            throw new ProviderError("downloadExists");
        }
        return existing.path;
      } finally {
        await local.close();
        await remoteLocal?.close();
      }
    }
    if (connection.type === "local") {
      const destination = path.join(directory, name),
        temporary = path.join(directory, `.tamki-${id}.partial`);
      try {
        await copyFile(file, temporary, constants.COPYFILE_EXCL);
        signal.throwIfAborted();
        if ((await stat(temporary)).size !== size)
          throw new ProviderError("downloadSaveFailed");
        // A hard link publishes the complete file atomically and cannot replace an existing file.
        try {
          await link(temporary, destination);
        } catch (error) {
          // Some mounted filesystems do not support hard links. Exclusive copy
          // still refuses existing files and returns only after publication.
          if (
            !["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS"].includes(
              (error as NodeJS.ErrnoException).code || "",
            )
          )
            throw error;
          await copyFile(temporary, destination, constants.COPYFILE_EXCL);
        }
        await unlink(temporary);
        return destination;
      } catch (error) {
        await rm(temporary, { force: true });
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new ProviderError("downloadExists");
        throw error;
      }
    }
    const destination = path.posix.join(directory, name);
    // The CLI emits only a final JSON response. Sample bytes visible on the NAS,
    // not local file reads or elapsed-time estimates. Never overlap polling calls.
    const monitor = new AbortController();
    const monitorSignal = AbortSignal.any([signal, monitor.signal]);
    const poll = async () => {
      while (!monitorSignal.aborted) {
        try {
          const candidates = (
            await provider.list(directory, monitorSignal)
          ).filter(
            (e) =>
              !e.directory &&
              (e.path === destination ||
                (e.name.startsWith(`.${name}.`) &&
                  /^z[a-f0-9]{32}$/.test(e.name.slice(name.length + 2)))),
          );
          // The CLI's partial file has a generated suffix. If multiple candidates
          // exist, omit speed rather than attribute another upload's bytes to us.
          const entry =
            candidates.find((e) => e.path === destination) ||
            (candidates.length === 1 ? candidates[0] : undefined);
          if (entry && entry.size <= size) progress?.(entry.size, size);
        } catch {
          /* Upload errors are reported by the upload itself. */
        }
        if (monitorSignal.aborted) break;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            monitorSignal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 2000);
          monitorSignal.addEventListener("abort", done, { once: true });
        });
      }
    };
    const polling = progress ? poll() : Promise.resolve();
    let result: { path?: string };
    try {
      result = (await this.options.upload(
        connection.id,
        [
          "--local-root",
          await realpath(path.dirname(file)),
          "file",
          "upload",
          "--params",
          JSON.stringify({
            local_path: path.basename(file),
            dest_path: destination,
            rename: 0,
            resume: true,
          }),
          "--yes",
        ],
        signal,
      )) as { path?: string };
    } finally {
      monitor.abort();
      await polling;
    }
    progress?.(size, size);
    if (result?.path && result.path !== destination)
      throw new ProviderError("downloadSaveFailed");
    const remote = (await provider.list(directory, signal)).find(
      (e) => e.path === destination && !e.directory,
    );
    if (!remote || remote.size !== size)
      throw new ProviderError("downloadSaveFailed");
    const handle = await open(file, "r");
    try {
      for (const offset of new Set([0, Math.max(0, size - 4096)])) {
        const length = Math.min(4096, size - offset),
          buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        const actual = await (provider as ZSpaceProvider).read(
          destination,
          offset,
          length,
          size,
          signal,
        );
        if (!Buffer.from(actual).equals(buffer))
          throw new ProviderError("downloadSaveFailed");
      }
    } finally {
      await handle.close();
    }
    return destination;
  }
}
