import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Collection,
  Connection,
  Episode,
  Entry,
  LibraryState,
  Preferences,
  Transfer,
  Work,
} from "../shared/model";
import type { ScanResult } from "./scan";
import type { z } from "zod";
import type { editSchema } from "../shared/validation";

type StoredWork = Omit<Work, "episodes"> & { excluded: boolean };
type StoredEpisode = Episode & { excluded: boolean; manual: boolean };
export const stableId = (...values: string[]) =>
  createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 32);
export class LibraryStore {
  private db: DatabaseSync;
  constructor(file: string, language: "en" | "zh" = "en") {
    this.db = new DatabaseSync(file);
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new Error("databaseNewer");
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    if (version === 0)
      this.transaction(() => {
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id)); PRAGMA user_version=1;`,
        );
      });
    if (!this.get<Preferences>("preferences", "default"))
      this.put("preferences", "default", {
        language,
        palette: "hazel",
        mode: "system",
        refreshOnOpen: true,
      });
    // A process restart cannot establish that an interrupted download completed.
    for (const task of this.all<Transfer>("transfer"))
      if (["running", "paused"].includes(task.state))
        this.put("transfer", task.id, { ...task, state: "interrupted" });
    for (const conn of this.connections())
      if (conn.status === "scanning")
        this.put("connection", conn.id, {
          ...conn,
          status: "offline",
          error: "scanInterrupted",
        });
  }
  close() {
    this.db.close();
  }
  private all<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=?")
      .all(kind)
      .map((r) => JSON.parse(String(r.data)) as T);
  }
  private get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }
  private put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(value));
  }
  private transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  preferences(): Preferences {
    return this.get<Preferences>("preferences", "default")!;
  }
  setPreferences(value: Preferences) {
    this.put("preferences", "default", value);
  }
  config(key: string): string | undefined {
    return this.get<string>("config", key);
  }
  setConfig(key: string, value: string) {
    this.put("config", key, value);
  }
  connections(): Connection[] {
    return this.all("connection");
  }
  connection(id: string): Connection {
    const c = this.get<Connection>("connection", id);
    if (!c) throw new Error("connectionMissing");
    return c;
  }
  saveConnection(connection: Connection) {
    this.put("connection", connection.id, connection);
  }
  removeConnection(id: string) {
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM records WHERE kind='connection' AND id=?")
        .run(id);
      for (const episode of this.all<StoredEpisode>("episode"))
        if (episode.connectionId === id)
          this.put("episode", episode.id, { ...episode, missing: true });
    });
  }
  snapshot(refreshing = false): LibraryState {
    const episodes = this.all<StoredEpisode>("episode").filter(
      (e) => !e.excluded,
    );
    const byWork = new Map<string, StoredEpisode[]>();
    for (const episode of episodes) {
      const list = byWork.get(episode.workId) || [];
      list.push(episode);
      byWork.set(episode.workId, list);
    }
    const works = this.all<StoredWork>("work")
      .filter((w) => !w.excluded)
      .map((w) => {
        const { excluded: _, ...work } = w;
        return {
          ...work,
          episodes: (byWork.get(w.id) || [])
            .sort((a, b) => a.order - b.order)
            .map(({ excluded, manual, ...episode }) => episode),
        };
      })
      .filter((w) => w.episodes.length)
      .sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
    return {
      connections: this.connections(),
      works,
      collections: this.all("collection"),
      transfers: this.all<Transfer>("transfer").sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
      preferences: this.preferences(),
      refreshing,
    };
  }
  applyScan(
    connectionId: string,
    root: string,
    result: ScanResult,
    manual = false,
  ) {
    this.transaction(() => {
      const seen = new Set<string>();
      const existingEpisodes = this.all<StoredEpisode>("episode");
      const references = new Map<string, StoredEpisode[]>();
      for (const e of existingEpisodes)
        if (e.connectionId === connectionId) {
          const values = references.get(e.path) || [];
          values.push(e);
          references.set(e.path, values);
        }
      const nextOrders = new Map<string, number>();
      for (const e of existingEpisodes)
        nextOrders.set(
          e.workId,
          Math.max(nextOrders.get(e.workId) || 0, e.order + 1),
        );
      for (const group of result.groups) {
        const workId = stableId(connectionId, group.path);
        const old = this.get<StoredWork>("work", workId);
        const work: StoredWork = old || {
          id: workId,
          connectionId,
          root,
          path: group.path,
          title: group.name,
          description: "",
          tags: [],
          createdAt: Date.now(),
          order: -Date.now(),
          resumeId: null,
          excluded: false,
        };
        if (manual) work.excluded = false;
        this.put("work", work.id, work);
        let nextOrder = nextOrders.get(workId) || 0;
        for (const file of group.files) {
          const episodeId = stableId(connectionId, file.path);
          seen.add(episodeId);
          const previous = this.get<StoredEpisode>("episode", episodeId);
          const episode: StoredEpisode = previous || {
            id: episodeId,
            workId,
            connectionId,
            path: file.path,
            fileName: file.name,
            number: "",
            title: "",
            description: "",
            size: file.size,
            modified: file.modified,
            duration: null,
            position: 0,
            order: nextOrder++,
            missing: false,
            excluded: false,
            manual,
          };
          // Manually assigned work IDs/order and metadata survive every rescan.
          const changed =
            episode.size !== file.size || episode.modified !== file.modified;
          Object.assign(episode, {
            missing: false,
            size: file.size,
            modified: file.modified,
            fileName: file.name,
          });
          if (changed) episode.duration = null;
          if (manual) {
            episode.excluded = false;
            episode.manual = true;
            const owner = this.get<StoredWork>("work", episode.workId);
            if (owner?.excluded)
              this.put("work", owner.id, { ...owner, excluded: false });
          }
          this.put("episode", episode.id, episode);
          // Manually appended references can point at this physical file too.
          // Refresh their availability without replacing their edited metadata.
          for (const reference of references.get(file.path) || []) {
            if (reference.id === episode.id) continue;
            this.put("episode", reference.id, {
              ...reference,
              missing: false,
              size: file.size,
              modified: file.modified,
              fileName: file.name,
              duration:
                reference.size !== file.size ||
                reference.modified !== file.modified
                  ? null
                  : reference.duration,
            });
            seen.add(reference.id);
          }
        }
      }
      if (!manual) {
        for (const episode of this.all<StoredEpisode>("episode")) {
          if (episode.connectionId !== connectionId || seen.has(episode.id))
            continue;
          const parent = path.dirname(episode.path);
          if (result.completeDirectories.includes(parent))
            this.put("episode", episode.id, { ...episode, missing: true });
          // A missing direct folder is distinguishable from an unreadable one.
          const work = this.get<StoredWork>("work", episode.workId);
          if (
            work?.root === root &&
            work.path !== root &&
            path.dirname(work.path) === root &&
            !result.completeDirectories.includes(work.path) &&
            !result.failures.includes(work.path) &&
            !result.groups.some((g) => g.path === work.path) &&
            !episode.manual
          )
            this.put("episode", episode.id, { ...episode, missing: true });
        }
      }
    });
  }
  episode(id: string): Episode {
    const e = this.get<StoredEpisode>("episode", id);
    if (!e || e.excluded || this.get<StoredWork>("work", e.workId)?.excluded)
      throw new Error("mediaMissing");
    return e;
  }
  setProgress(id: string, position: number, duration: number, resume: boolean) {
    const e = this.episode(id);
    this.transaction(() => {
      this.put("episode", id, {
        ...e,
        duration,
        position: Math.min(resume ? position : e.position, duration),
      });
      if (resume) {
        const work = this.get<StoredWork>("work", e.workId)!;
        this.put("work", work.id, { ...work, resumeId: id });
      }
    });
  }
  prepareEpisodes(
    workId: string,
    connectionId: string,
    files: Entry[],
  ): Episode[] {
    const work = this.get<StoredWork>("work", workId);
    if (!work || work.excluded) throw new Error("mediaMissing");
    const existing = this.all<StoredEpisode>("episode");
    return files.map((file) => {
      const sameWork = existing.find(
        (e) =>
          e.workId === workId &&
          e.connectionId === connectionId &&
          e.path === file.path,
      );
      const source =
        sameWork ||
        existing.find(
          (e) =>
            e.connectionId === connectionId &&
            e.path === file.path &&
            !e.excluded,
        );
      return {
        id:
          sameWork?.id ||
          stableId("attachment", workId, connectionId, file.path),
        workId,
        connectionId,
        path: file.path,
        fileName: file.name,
        number: source?.number || "",
        title: source?.title || "",
        description: source?.description || "",
        size: file.size,
        modified: file.modified,
        duration: source?.duration || null,
        position: sameWork?.position || 0,
        order: 0,
        missing: false,
      };
    });
  }
  edit(input: z.input<typeof editSchema>, additions: Episode[] = []) {
    const work = this.get<StoredWork>("work", input.id);
    if (!work || work.excluded) throw new Error("mediaMissing");
    const episodes = this.all<StoredEpisode>("episode").filter(
      (e) => e.workId === work.id && !e.excluded,
    );
    for (const extra of additions) {
      if (extra.workId !== work.id) throw new Error("invalidInput");
      if (!episodes.some((e) => e.id === extra.id))
        episodes.push({ ...extra, excluded: false, manual: true });
    }
    const removed = new Set(input.removedEpisodeIds);
    if (
      new Set(input.episodes.map((e) => e.id)).size !== input.episodes.length ||
      input.episodes.some(
        (e) => !episodes.some((old) => old.id === e.id) || removed.has(e.id),
      ) ||
      [...removed].some((id) => !episodes.some((e) => e.id === id))
    )
      throw new Error("invalidInput");
    this.transaction(() => {
      this.put("work", work.id, {
        ...work,
        title: input.title,
        description: input.description,
        tags: [...new Set(input.tags)],
        excluded: episodes.every((e) => removed.has(e.id)),
        resumeId: work.resumeId
          ? removed.has(work.resumeId)
            ? input.episodes[0]?.id ||
              episodes.find((e) => !removed.has(e.id))?.id ||
              null
            : work.resumeId
          : null,
      });
      let nextOrder = input.episodes.length;
      for (const episode of episodes.sort((a, b) => a.order - b.order)) {
        const order = input.episodes.findIndex((e) => e.id === episode.id);
        this.put(
          "episode",
          episode.id,
          removed.has(episode.id)
            ? { ...episode, excluded: true }
            : order < 0
              ? { ...episode, order: nextOrder++ }
              : { ...episode, ...input.episodes[order], order },
        );
      }
    });
  }
  removeWork(id: string) {
    const work = this.get<StoredWork>("work", id);
    if (work) this.put("work", id, { ...work, excluded: true });
  }
  reorder(ids: string[]) {
    const works = this.snapshot().works;
    if (
      ids.length !== works.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !works.some((w) => w.id === id))
    )
      throw new Error("invalidInput");
    this.transaction(() => {
      for (const [order, id] of ids.entries())
        this.put("work", id, { ...this.get<StoredWork>("work", id)!, order });
    });
  }
  saveCollection(collection: Omit<Collection, "id"> & { id?: string }) {
    const ids = new Set(this.snapshot().works.map((w) => w.id));
    if (collection.workIds.some((id) => !ids.has(id)))
      throw new Error("invalidInput");
    const value = {
      ...collection,
      id: collection.id || randomUUID(),
      workIds: [...new Set(collection.workIds)],
    };
    this.put("collection", value.id, value);
    return value;
  }
  removeCollection(id: string) {
    this.db
      .prepare("DELETE FROM records WHERE kind='collection' AND id=?")
      .run(id);
  }
  saveTransfer(transfer: Transfer) {
    this.put("transfer", transfer.id, transfer);
  }
}
