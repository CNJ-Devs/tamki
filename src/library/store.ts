import { parseFilename } from "./filename";
import {
  organizationSnapshot,
  organizationStateChanges,
  type OrganizationSnapshot,
} from "./organization-state";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Collection,
  Series,
  Connection,
  Episode,
  Entry,
  LibraryState,
  Preferences,
  Transfer,
  Work,
  EpisodeVersion,
  VideoFile,
} from "../shared/model";
import { relativeDepth, type ScanResult } from "./scan";
import { defaultSettings, type SettingsState } from "../shared/settings";
import type { z } from "zod";
import type { editSchema } from "../shared/validation";
import type { RecognitionResult } from "../shared/recognition";
import type { CaptureMetadata, CaptureResource } from "../shared/capture";
import type {
  OrganizationFile,
  OrganizationPlan,
  OrganizationApply,
  OrganizationContext,
} from "../shared/organization";

type StoredWork = Omit<Work, "episodes"> & { excluded: boolean };
// Physical media records retain their original IDs so scans/exclusions remain stable.
// logicalId and versionId are persistent identities, independent of file layout.
type StoredEpisode = Omit<
  Episode,
  "versions" | "activeVersionId" | "activeFileId"
> & {
  logicalId?: string;
  versionId?: string;
  versionLabel?: string;
  releaseKey?: string;
  excluded: boolean;
  /** Protect the assignment on rescan, not the provenance of metadata. */
  manual: boolean;
  assignmentOrigin?: "manual" | "organization";
};
export const recognitionSignature = (work: Work) =>
  stableId(
    ...work.episodes
      .flatMap((e) =>
        e.versions
          ? e.versions.flatMap((v) =>
              v.files.map((f) => `${e.id}:${v.id}:${f.id}:${f.modified}`),
            )
          : [`${e.id}:${e.modified}`],
      )
      .sort(),
  );
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
    if (version > 2) {
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
    if (version < 2)
      this.transaction(() => {
        for (const file of this.all<StoredEpisode>("episode"))
          this.put("episode", file.id, file);
        this.db.exec("PRAGMA user_version=2");
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
    if (kind === "episode") {
      const { versions, activeVersionId, activeFileId, ...file } =
        value as Episode & StoredEpisode;
      value = {
        ...file,
        logicalId: file.logicalId || file.id,
        versionId: file.versionId || stableId("version", file.id),
        versionLabel: file.versionLabel || "",
        releaseKey: file.releaseKey || "",
      };
    }
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
  setConfigs(values: Record<string, string>) {
    this.transaction(() => {
      for (const [key, value] of Object.entries(values))
        this.put("config", key, value);
    });
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
          episodes: this.logicalEpisodes(
            byWork.get(w.id) || [],
            w.preferredVersionKey,
          ),
        };
      })
      .filter((w) => w.episodes.length)
      .sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
    const settings = this.config("settings")
      ? JSON.parse(this.config("settings")!)
      : defaultSettings(this.preferences().language);
    if (settings.recognition.parser === "guessit")
      settings.recognition.parser = "release";
    if (settings.recognition.parser === "anitopy")
      settings.recognition.parser = "anitomy";
    return {
      settings: settings as SettingsState,
      connections: this.connections(),
      works,
      collections: this.all("collection"),
      series: this.all<Series>("series").map((s) => ({
        ...s,
        workIds: s.workIds.filter((id) => works.some((w) => w.id === id)),
      })),
      transfers: this.all<Transfer>("transfer").sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
      preferences: this.preferences(),
      refreshing,
    };
  }
  private logicalEpisodes(
    rows: StoredEpisode[],
    preferredKey?: string,
  ): Episode[] {
    const groups = new Map<string, StoredEpisode[]>();
    for (const row of rows) {
      const id = row.logicalId || row.id;
      groups.set(id, [...(groups.get(id) || []), row]);
    }
    return [...groups]
      .map(([id, files]) => {
        files.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const primary = files.find((f) => f.id === id) || files[0];
        const versions: EpisodeVersion[] = [];
        for (const f of files) {
          const versionId = f.versionId || stableId("version", f.id);
          let v = versions.find((v) => v.id === versionId);
          if (!v) {
            v = {
              id: versionId,
              label: f.versionLabel || "",
              releaseKey: f.releaseKey || "",
              files: [],
            };
            versions.push(v);
          }
          v.files.push({
            id: f.id,
            connectionId: f.connectionId,
            path: f.path,
            fileName: f.fileName,
            size: f.size,
            modified: f.modified,
            duration: f.duration,
            position: f.position,
            missing: f.missing,
          });
        }
        const choice = this.get<{ versionId: string; fileId: string }>(
          "playback-choice",
          id,
        );
        const available = (v: EpisodeVersion) =>
          v.files.some((f) => !f.missing);
        const selected =
          versions.find((v) => v.id === choice?.versionId && available(v)) ||
          versions.find(
            (v) =>
              !!preferredKey && v.releaseKey === preferredKey && available(v),
          ) ||
          versions.find(available) ||
          versions[0];
        const file =
          selected.files.find((f) => f.id === choice?.fileId && !f.missing) ||
          selected.files.find((f) => !f.missing) ||
          selected.files[0];
        return {
          id,
          workId: primary.workId,
          number: primary.number,
          title: primary.title,
          description: primary.description,
          cover: primary.cover,
          artworkSource: primary.artworkSource,
          artworkError: primary.artworkError,
          order: files[0].order,
          ...Object.fromEntries(
            Object.entries(file).filter(([key]) => key !== "id"),
          ),
          versions,
          activeVersionId: selected.id,
          activeFileId: file.id,
        } as Episode;
      })
      .sort((a, b) => a.order - b.order);
  }
  setRecognition(id: string, recognition: NonNullable<Work["recognition"]>) {
    const work = this.get<StoredWork>("work", id);
    if (work && !work.excluded) this.put("work", id, { ...work, recognition });
  }
  /** Import verified source metadata, while retaining authored and recognized fields. */
  applyCapturedMetadata(
    connectionId: string,
    filePath: string,
    metadata: CaptureMetadata | undefined,
    episode: CaptureResource["metadata"],
    initialTitle?: string,
  ) {
    const file = this.all<StoredEpisode>("episode").find(
      (e) =>
        !e.excluded && e.connectionId === connectionId && e.path === filePath,
    );
    const work = file && this.get<StoredWork>("work", file.workId);
    if (!file || !work || work.excluded) return;
    const locks =
      this.get<Record<string, boolean>>("metadata-lock", work.id) || {};
    const replaceDerived =
      !work.recognition ||
      work.recognition.status !== "complete" ||
      work.recognition.sourceId === "bilibili";
    this.transaction(() => {
      if (metadata) {
        if (
          initialTitle !== undefined &&
          work.title === initialTitle &&
          !locks["work:title"] &&
          metadata.title
        )
          work.title = metadata.title;
        if (!work.description && !locks["work:description"])
          work.description = metadata.description;
        if (!work.tags.length && !locks["work:tags"]) work.tags = metadata.tags;
        // Keep the URL even if the first image request fails; retries need no LLM.
        if (!work.captureSource || work.captureSource.id === metadata.id)
          work.captureSource = {
            id: metadata.id,
            url: metadata.url,
            cover: metadata.cover,
          };
      }
      if (episode) {
        for (const row of this.all<StoredEpisode>("episode").filter(
          (e) =>
            !e.excluded &&
            e.workId === work.id &&
            (e.logicalId || e.id) === (file.logicalId || file.id),
        )) {
          for (const field of ["title", "number", "description"] as const) {
            if (
              !episode[field] ||
              locks[`${row.id}:${field}`] ||
              locks[`${file.logicalId || file.id}:${field}`]
            )
              continue;
            if (!row[field] || (replaceDerived && field !== "description"))
              row[field] = episode[field];
          }
          if (!row.artworkSource && episode.cover)
            row.artworkSource = episode.cover;
          this.put("episode", row.id, row);
        }
      }
      this.put("work", work.id, work);
      if (metadata && replaceDerived) {
        const current = this.snapshot().works.find((w) => w.id === work.id)!;
        this.setRecognition(work.id, {
          status: "complete",
          sourceId: "bilibili",
          candidate: metadata.id,
          signature: recognitionSignature(current),
        });
      }
    });
  }
  repairCapturedArtwork(
    id: string,
    source: string,
    cover: string,
    episode = false,
  ) {
    if (episode) {
      const rows = this.all<StoredEpisode>("episode").filter(
        (e) => !e.excluded && (e.logicalId || e.id) === id,
      );
      for (const row of rows)
        if (
          !row.cover &&
          row.artworkSource === source &&
          !this.get<StoredWork>("work", row.workId)?.excluded
        )
          this.put("episode", row.id, { ...row, cover, artworkError: false });
      return;
    }
    const work = this.get<StoredWork>("work", id);
    const locks = this.get<Record<string, boolean>>("metadata-lock", id) || {};
    if (
      work &&
      !work.excluded &&
      !work.cover &&
      !locks["work:cover"] &&
      work.captureSource?.cover === source
    )
      this.put("work", id, { ...work, cover });
  }
  failCapturedEpisodeArtwork(id: string, source: string) {
    for (const row of this.all<StoredEpisode>("episode"))
      if (
        !row.excluded &&
        !row.cover &&
        (row.logicalId || row.id) === id &&
        row.artworkSource === source
      )
        this.put("episode", row.id, { ...row, artworkError: true });
  }
  linkDownloadedVersions(
    connectionId: string,
    files: { path: string; label: string; releaseKey: string }[],
  ) {
    const rows = this.all<StoredEpisode>("episode").filter(
      (e) =>
        !e.excluded &&
        e.connectionId === connectionId &&
        files.some((f) => f.path === e.path),
    );
    if (!rows.length || rows.some((e) => e.workId !== rows[0].workId)) return;
    const logicalId = rows[0].logicalId || rows[0].id;
    this.transaction(() => {
      for (const row of rows) {
        const file = files.find((f) => f.path === row.path)!;
        this.put("episode", row.id, {
          ...row,
          logicalId,
          versionLabel: file.label,
          releaseKey: file.releaseKey,
        });
      }
    });
  }
  repairArtwork(id: string, signature: string, cover: string) {
    const work = this.get<StoredWork>("work", id);
    const locks = this.get<Record<string, boolean>>("metadata-lock", id) || {};
    if (
      !work ||
      work.excluded ||
      work.cover ||
      locks["work:cover"] ||
      work.recognition?.signature !== signature
    )
      return;
    this.put("work", id, {
      ...work,
      cover,
      recognition: { ...work.recognition, artworkError: false },
    });
  }
  queueRecognition(
    sourceId: string,
    retryIds: string[] = [],
    requested = false,
  ) {
    const selected = new Set(retryIds);
    this.transaction(() => {
      for (const work of this.snapshot().works) {
        if (requested && !selected.has(work.id)) continue;
        if (!work.episodes.some((e) => !e.missing)) continue;
        const signature = recognitionSignature(work),
          previous = work.recognition;
        if (
          previous?.status === "running" ||
          (!requested && previous?.requested && previous.status === "queued")
        )
          continue;
        if (
          !previous ||
          previous.signature !== signature ||
          (previous.status === "queued" && previous.sourceId !== sourceId) ||
          selected.has(work.id)
        )
          this.setRecognition(work.id, {
            status: "queued",
            sourceId,
            signature,
            ...(requested ? { requested: true } : {}),
            candidate:
              !requested && previous?.sourceId === sourceId
                ? previous.candidate
                : undefined,
          });
      }
    });
  }
  /** Only fill empty, untouched fields. Re-read at commit so concurrent edits win. */
  applyAutomatic(
    baseline: Work,
    result: RecognitionResult,
    recognition: NonNullable<Work["recognition"]>,
  ) {
    const current = this.get<StoredWork>("work", baseline.id);
    if (
      !current ||
      current.excluded ||
      current.recognition?.signature !== baseline.recognition?.signature ||
      current.recognition?.status !== "running"
    )
      return;
    const locks =
      this.get<Record<string, boolean>>("metadata-lock", baseline.id) || {};
    const fill = (
      target: Record<string, unknown>,
      previous: Record<string, unknown>,
      next: Record<string, unknown>,
      prefix: string,
    ) => {
      for (const field of ["title", "description", "tags", "number", "cover"]) {
        if (next[field] == null || locks[`${prefix}:${field}`]) continue;
        if (JSON.stringify(target[field]) !== JSON.stringify(previous[field]))
          continue;
        const empty =
          target[field] == null ||
          target[field] === "" ||
          (Array.isArray(target[field]) && !target[field].length);
        if (empty) target[field] = next[field];
      }
    };
    this.transaction(() => {
      if (result.work)
        fill(
          current as unknown as Record<string, unknown>,
          baseline as unknown as Record<string, unknown>,
          result.work,
          "work",
        );
      this.put("work", current.id, { ...current, recognition });
      for (const incoming of result.files) {
        const old = baseline.episodes.find((e) => e.id === incoming.id);
        if (!old) continue;
        for (const episode of this.all<StoredEpisode>("episode").filter(
          (e) =>
            (e.logicalId || e.id) === incoming.id &&
            e.workId === baseline.id &&
            !e.excluded,
        )) {
          fill(
            episode as unknown as Record<string, unknown>,
            old as unknown as Record<string, unknown>,
            incoming,
            incoming.id,
          );
          this.put("episode", episode.id, episode);
        }
      }
    });
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
      const parser = this.snapshot().settings.recognition.parser;
      for (const group of result.groups) {
        const workId = stableId(connectionId, group.path);
        const old = this.get<StoredWork>("work", workId);
        const work: StoredWork = old || {
          id: workId,
          connectionId,
          root: group.root || root,
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
          const previous =
            this.get<StoredEpisode>("episode", episodeId) ||
            (references.get(file.path) || []).find(
              (e) => e.manual && !e.excluded,
            );
          if (previous) seen.add(previous.id);
          const parsed = previous
            ? null
            : parseFilename(
                file.name,
                parser === "anitomy" ? "anitomy" : "release",
              );
          const episode: StoredEpisode = previous || {
            id: episodeId,
            workId,
            connectionId,
            path: file.path,
            fileName: file.name,
            number: parsed?.number || "",
            title: parsed?.episodeTitle || "",
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
          const paths =
            this.connection(connectionId).type === "local" ? path : path.posix;
          const parent = paths.dirname(episode.path);
          if (
            result.scopes &&
            !result.scopes.some((scope) => {
              const depth = relativeDepth(scope.root, parent);
              return depth !== null && depth <= scope.depth;
            })
          )
            continue;
          let absent = result.completeDirectories.includes(parent);
          // A successful parent listing may prove a descendant's ancestor disappeared.
          if (result.children) {
            let child = parent;
            for (
              let ancestor = paths.dirname(child);
              ancestor !== child;
              ancestor = paths.dirname(child)
            ) {
              if (
                result.children[ancestor] &&
                !result.children[ancestor].includes(child)
              ) {
                absent = true;
                break;
              }
              child = ancestor;
            }
          }
          if (absent)
            this.put("episode", episode.id, { ...episode, missing: true });
        }
      }
    });
  }
  episode(id: string): Episode {
    const files = this.all<StoredEpisode>("episode").filter(
      (e) => (e.logicalId || e.id) === id && !e.excluded,
    );
    const work = files[0] && this.get<StoredWork>("work", files[0].workId);
    if (!work || work.excluded) throw new Error("mediaMissing");
    return this.logicalEpisodes(
      files.filter((e) => e.workId === work.id),
      work.preferredVersionKey,
    )[0];
  }
  file(id: string): StoredEpisode {
    const e = this.get<StoredEpisode>("episode", id);
    if (!e || e.excluded || this.get<StoredWork>("work", e.workId)?.excluded)
      throw new Error("mediaMissing");
    return e;
  }
  media(id: string, versionId?: string, fileId?: string): VideoFile {
    const episode = this.episode(id);
    const v = episode.versions!.find(
      (v) => v.id === (versionId || episode.activeVersionId),
    );
    if (!v) throw new Error("invalidInput");
    const file = fileId
      ? v.files.find((f) => f.id === fileId)
      : v.files.find((f) => f.id === episode.activeFileId && !f.missing) ||
        v.files.find((f) => !f.missing) ||
        v.files[0];
    if (!file) throw new Error("invalidInput");
    return file;
  }
  selectVersion(id: string, versionId: string) {
    const e = this.episode(id),
      file = this.media(id, versionId);
    if (file.missing) throw new Error("mediaMissing");
    this.transaction(() => {
      this.put("playback-choice", id, { versionId, fileId: file.id });
      const work = this.get<StoredWork>("work", e.workId)!;
      this.put("work", work.id, {
        ...work,
        preferredVersionKey: e.versions!.find((v) => v.id === versionId)!
          .releaseKey,
      });
    });
  }
  setProgress(
    id: string,
    position: number,
    duration: number,
    resume: boolean,
    versionId?: string,
    fileId?: string,
  ) {
    const file = this.media(id, versionId, fileId),
      e = this.file(file.id);
    this.transaction(() => {
      this.put("episode", e.id, {
        ...e,
        duration,
        position: Math.min(resume ? position : e.position, duration),
      });
      if (resume)
        for (const copy of this.all<StoredEpisode>("episode"))
          if (
            copy.id !== e.id &&
            copy.versionId === e.versionId &&
            copy.logicalId === e.logicalId &&
            !copy.excluded
          )
            this.put("episode", copy.id, {
              ...copy,
              position: Math.min(position, copy.duration || duration),
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
      if (sameWork && !sameWork.excluded)
        return this.episode(sameWork.logicalId || sameWork.id);
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
      if (!episodes.some((e) => (e.logicalId || e.id) === extra.id))
        episodes.push({
          ...extra,
          excluded: false,
          manual: true,
          assignmentOrigin: "manual",
        });
    }
    const logicalInput = input;
    const owners = new Map(episodes.map((e) => [e.id, e.logicalId || e.id]));
    const logicalIds = new Set(owners.values());
    if (
      new Set(input.episodes.map((e) => e.id)).size !== input.episodes.length ||
      input.episodes.some((e) => !logicalIds.has(e.id)) ||
      input.removedEpisodeIds.some((id) => !logicalIds.has(id))
    )
      throw new Error("invalidInput");
    input = {
      ...input,
      removedEpisodeIds: episodes
        .filter((e) => input.removedEpisodeIds.includes(owners.get(e.id)!))
        .map((e) => e.id),
      episodes: input.episodes.flatMap((e) =>
        episodes
          .filter((f) => owners.get(f.id) === e.id)
          .map((f) => ({ ...e, id: f.id })),
      ),
    };
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
      const locks =
        this.get<Record<string, boolean>>("metadata-lock", work.id) || {};
      const protect = (
        prefix: string,
        old: Record<string, unknown>,
        next: Record<string, unknown>,
      ) => {
        for (const field of ["title", "description", "tags", "number", "cover"])
          if (
            field in next &&
            JSON.stringify(old[field]) !== JSON.stringify(next[field])
          )
            locks[`${prefix}:${field}`] = true;
      };
      protect(
        "work",
        { ...work },
        {
          title: input.title,
          description: input.description,
          tags: input.tags,
          ...(input.cover ? { cover: input.cover } : {}),
        },
      );
      for (const episode of input.episodes)
        protect(
          owners.get(episode.id)!,
          { ...episodes.find((e) => e.id === episode.id)! },
          episode,
        );
      const priorOrder = episodes
        .filter((e) => !e.excluded)
        .sort((a, b) => a.order - b.order);
      if (
        removed.size ||
        additions.length ||
        input.episodes.some((e, i) => priorOrder[i]?.id !== e.id)
      )
        locks["work:files"] = true;
      this.put("metadata-lock", work.id, locks);
      this.put("work", work.id, {
        ...work,
        title: input.title,
        description: input.description,
        tags: [...new Set(input.tags)],
        ...(input.cover ? { cover: input.cover } : {}),
        ...(input.metadataReviewed
          ? {
              recognition: {
                status: "complete",
                sourceId: "manual",
                signature: recognitionSignature({
                  ...work,
                  episodes: this.logicalEpisodes(
                    episodes.filter((e) => !removed.has(e.id)),
                  ),
                }),
              },
            }
          : {}),
        excluded: episodes.every((e) => removed.has(e.id)),
        resumeId: work.resumeId
          ? logicalInput.removedEpisodeIds.includes(work.resumeId)
            ? logicalInput.episodes[0]?.id ||
              episodes.find((e) => !removed.has(e.id))?.logicalId ||
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
    if (
      (collection.seriesIds || []).some(
        (id) => !this.get<Series>("series", id),
      ) ||
      collection.workIds.some((id) => !ids.has(id))
    )
      throw new Error("invalidInput");
    const value = {
      ...collection,
      id: collection.id || randomUUID(),
      workIds: [...new Set(collection.workIds)],
    };
    this.transaction(() => {
      this.put("collection", value.id, value);
      this.recordRelationshipEdit("collection", value, "saved");
    });
    return value;
  }
  saveSeries(series: Omit<Series, "id"> & { id?: string }, manual = true) {
    const ids = new Set(this.snapshot().works.map((w) => w.id));
    if (
      !series.workIds.length ||
      new Set(series.workIds).size !== series.workIds.length ||
      series.workIds.some((id) => !ids.has(id)) ||
      this.all<Series>("series").some(
        (s) =>
          s.id !== series.id &&
          s.workIds.some((id) => series.workIds.includes(id)),
      )
    )
      throw new Error("invalidInput");
    const value = { ...series, id: series.id || randomUUID() };
    this.transaction(() => {
      this.put("series", value.id, value);
      if (manual) this.recordRelationshipEdit("series", value, "saved");
    });
    return value;
  }
  removeSeries(id: string) {
    this.transaction(() => {
      const series = this.get<Series>("series", id);
      if (series) this.recordRelationshipEdit("series", series, "removed");
      for (const c of this.all<Collection>("collection")) {
        if (!c.seriesIds?.includes(id)) continue;
        this.put("collection", c.id, {
          ...c,
          seriesIds: c.seriesIds.filter((s) => s !== id),
          workIds: [...new Set([...c.workIds, ...(series?.workIds || [])])],
        });
      }
      this.db
        .prepare("DELETE FROM records WHERE kind='series' AND id=?")
        .run(id);
    });
  }
  removeCollection(id: string) {
    this.transaction(() => {
      const collection = this.get<Collection>("collection", id);
      if (collection)
        this.recordRelationshipEdit("collection", collection, "removed");
      this.db
        .prepare("DELETE FROM records WHERE kind='collection' AND id=?")
        .run(id);
    });
  }
  private recordRelationshipEdit(
    kind: "collection" | "series",
    value: Collection | Series,
    action: "saved" | "removed",
  ) {
    const workIds = [
      ...new Set([
        ...value.workIds,
        ...("seriesIds" in value ? value.seriesIds || [] : []).flatMap(
          (id) => this.get<Series>("series", id)?.workIds || [],
        ),
      ]),
    ];
    if (action === "saved")
      this.clearSupersededRelationshipEdits(kind, value.id, workIds);
    this.put("organization-relationship-edit", `${kind}:${value.id}`, {
      id: value.id,
      kind,
      action,
      name: value.name,
      workIds,
      updatedAt: Date.now(),
    });
  }
  private clearSupersededRelationshipEdits(
    kind: "collection" | "series",
    id: string,
    workIds: string[],
  ) {
    for (const edit of this.all<
      NonNullable<OrganizationContext["relationshipEdits"]>[number]
    >("organization-relationship-edit")) {
      if (
        edit.kind === kind &&
        (edit.id === id ||
          (edit.workIds.length === workIds.length &&
            edit.workIds.every((w) => workIds.includes(w))))
      )
        this.db
          .prepare("DELETE FROM records WHERE kind=? AND id=?")
          .run("organization-relationship-edit", `${kind}:${edit.id}`);
    }
  }
  organizationSnapshot(): OrganizationSnapshot {
    const locks: Record<string, Record<string, boolean>> = {};
    for (const w of this.all<StoredWork>("work"))
      locks[w.id] =
        this.get<Record<string, boolean>>("metadata-lock", w.id) || {};
    const collections = this.all<Collection>("collection");
    return organizationSnapshot(
      this.all<StoredWork>("work") as unknown as Record<string, unknown>[],
      this.all<StoredEpisode>("episode") as unknown as Record<
        string,
        unknown
      >[],
      [...collections, ...this.all<Series>("series")].map((s, i) => ({
        ...s,
        kind: i < collections.length ? "collection" : "series",
      })) as unknown as Record<string, unknown>[],
      this.connections().flatMap((c) =>
        c.roots.map((path) => ({
          connectionId: c.id,
          path,
          depth: c.scanDepths?.[path] ?? 1,
        })),
      ),
      locks,
      this.all("organization-relationship-edit"),
    );
  }
  organizationChanges(baseline: OrganizationSnapshot) {
    return organizationStateChanges(baseline, this.organizationSnapshot());
  }
  organizationLiveChanges(
    plan: OrganizationPlan,
    baseline: OrganizationSnapshot,
  ) {
    const current = this.organizationSnapshot();
    const changes = organizationStateChanges(baseline, current);
    const scopes =
      plan.scopes ||
      plan.files.map((f) => ({
        connectionId: f.connectionId,
        path: f.root,
        depth: 32,
      }));
    const inScope = (f: { connectionId: string; path: string }) =>
      scopes.some(
        (s) =>
          s.connectionId === f.connectionId &&
          relativeDepth(s.path, f.path) !== null &&
          relativeDepth(s.path, f.path)! <= s.depth + 1,
      );
    const known = new Set(
      plan.files.map((f) => JSON.stringify([f.connectionId, f.path])),
    );
    const removed = changes.removed.filter(inScope),
      modified = changes.modified.filter(inScope);
    const scopedWorkIds = new Set(
      Object.values(baseline.files)
        .filter(inScope)
        .map((f) => f.workId),
    );
    const changedWorkIds = changes.changedWorkIds.filter((id) =>
      scopedWorkIds.has(id),
    );
    const rootsChanged = scopes.some((s) => {
      const key = JSON.stringify([s.connectionId, s.path]);
      return baseline.roots[key] !== current.roots[key];
    });
    const graph = new Map<string, Set<string>>();
    const edge = (a: string, b: string) => {
      if (!graph.has(a)) graph.set(a, new Set());
      if (!graph.has(b)) graph.set(b, new Set());
      graph.get(a)!.add(b);
      graph.get(b)!.add(a);
    };
    for (const relationship of [
      ...(baseline.relationships || []),
      ...(current.relationships || []),
    ])
      for (const id of relationship.workIds)
        edge("r:" + relationship.id, "w:" + id);
    const fileMap = new Map(plan.files.map((f) => [f.id, f]));
    for (const g of plan.groups) {
      if (g.existingWorkId) edge("g:" + g.id, "w:" + g.existingWorkId);
      for (const id of g.fileIds) {
        const file = fileMap.get(id)!;
        const owner =
          file.workId || baseline.files[file.episodeId || file.id]?.workId;
        if (owner) edge("g:" + g.id, "w:" + owner);
      }
    }
    for (const c of plan.collections)
      for (const id of c.groupIds) edge("p:" + c.id, "g:" + id);
    const pending = [
      ...changedWorkIds.map((id) => "w:" + id),
      ...[...removed, ...modified].map((f) => "w:" + f.workId),
    ];
    const byPath = new Map(
      Object.values(current.files).map((f) => [
        JSON.stringify([f.connectionId, f.path]),
        f,
      ]),
    );
    for (const g of plan.groups)
      for (const id of g.fileIds) {
        const f = fileMap.get(id)!;
        const now = byPath.get(JSON.stringify([f.connectionId, f.path]));
        if (
          now &&
          (!baseline.files[now.id] ||
            baseline.files[now.id].signature !== now.signature) &&
          (now.size !== f.size || now.modified !== f.modified)
        )
          pending.push("g:" + g.id);
      }
    if (rootsChanged)
      pending.push(
        ...plan.groups.map((g) => "g:" + g.id),
        ...(plan.delta?.removed || []).map((f) => "w:" + f.workId),
      );
    const visited = new Set<string>();
    for (let i = 0; i < pending.length; i++) {
      const node = pending[i];
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of graph.get(node) || [])
        if (!visited.has(next)) pending.push(next);
    }
    const conflictingGroupIds = plan.groups
      .filter((g) => visited.has("g:" + g.id))
      .map((g) => g.id);
    const deferredRemovalIds = (plan.delta?.removed || [])
      .filter((f) => rootsChanged || visited.has("w:" + f.workId))
      .map((f) => f.id);
    return {
      added: changes.added.filter(
        (f) =>
          inScope(f) && !known.has(JSON.stringify([f.connectionId, f.path])),
      ),
      removed,
      modified,
      changedWorkIds,
      blocked:
        rootsChanged ||
        !!conflictingGroupIds.length ||
        !!deferredRemovalIds.length,
      conflictingGroupIds,
      deferredRemovalIds,
    };
  }
  assertOrganizationSnapshot(
    plan: OrganizationPlan,
    groupIds: string[],
    baseline: OrganizationSnapshot,
    removals: string[] = [],
  ) {
    const changes = this.organizationLiveChanges(plan, baseline);
    if (
      groupIds.some((id) => changes.conflictingGroupIds.includes(id)) ||
      removals.some((id) => changes.deferredRemovalIds.includes(id))
    )
      throw new Error("organizationStale");
    return changes;
  }
  organizationFingerprint(): string {
    return stableId(
      JSON.stringify([
        this.all<StoredWork>("work").map(
          ({ recognition, resumeId, preferredVersionKey, ...w }) => w,
        ),
        this.all<StoredEpisode>("episode").map(
          ({ position, duration, ...e }) => e,
        ),
        this.all<Collection>("collection"),
        this.all<Series>("series"),
        this.connections().map(({ id, type, roots, scanDepths }) => ({
          id,
          type,
          roots,
          scanDepths,
        })),
        this.all("metadata-lock"),
      ]),
    );
  }
  organizationContext(files: OrganizationFile[]): OrganizationContext {
    const selected = new Map(files.map((f) => [f.episodeId, f.id]));
    const stored = new Map(
      this.all<StoredEpisode>("episode").map((e) => [e.id, e]),
    );
    const snapshot = this.snapshot();
    return {
      relationshipEdits: this.all<
        NonNullable<OrganizationContext["relationshipEdits"]>[number]
      >("organization-relationship-edit"),
      works: snapshot.works.map((w) => {
        const locks =
          this.get<Record<string, boolean>>("metadata-lock", w.id) || {};
        const fields = (prefix: string) =>
          Object.keys(locks)
            .filter((k) => locks[k] && k.startsWith(`${prefix}:`))
            .map((k) => k.slice(prefix.length + 1));
        return {
          id: w.id,
          title: w.title,
          description: w.description,
          tags: w.tags,
          hasCover: !!w.cover,
          manualFields: fields("work"),
          recognized: w.recognition?.status === "complete",
          files: w.episodes
            .flatMap((episode) =>
              episode.versions!.flatMap((v) =>
                v.files.map((f) => ({
                  ...episode,
                  id: f.id,
                  logicalId: episode.id,
                  versionId: v.id,
                  versionLabel: v.label,
                  releaseKey: v.releaseKey,
                })),
              ),
            )
            .filter((e) => selected.has(e.id))
            .map((e) => ({
              id: selected.get(e.id)!,
              episodeId: e.logicalId,
              versionId: e.versionId,
              versionLabel: e.versionLabel,
              releaseKey: e.releaseKey,
              number: e.number,
              title: e.title,
              description: e.description,
              manual: stored.get(e.id)?.manual === true,
              assignmentOrigin:
                stored.get(e.id)?.assignmentOrigin ||
                (stored.get(e.id)?.manual ? "unknown" : "scan"),
              manualFields: fields(e.logicalId),
            })),
          outsideFiles: w.episodes
            .flatMap((e) => e.versions!.flatMap((v) => v.files))
            .filter((f) => !selected.has(f.id)).length,
        };
      }),
      collections: [
        ...snapshot.collections.map((c) => ({
          ...c,
          workIds: [
            ...new Set([
              ...c.workIds,
              ...(c.seriesIds || []).flatMap(
                (id) =>
                  snapshot.series?.find((s) => s.id === id)?.workIds || [],
              ),
            ]),
          ],
        })),
        ...(snapshot.series || []).map((s) => ({
          ...s,
          kind: "series" as const,
        })),
      ],
    };
  }
  organizationCandidates(
    connectionId: string,
    result: ScanResult,
  ): { files: OrganizationFile[]; excludedCount: number } {
    const works = new Map(this.all<StoredWork>("work").map((w) => [w.id, w]));
    const references = new Map<string, StoredEpisode[]>();
    for (const e of this.all<StoredEpisode>("episode"))
      if (e.connectionId === connectionId) {
        const list = references.get(e.path) || [];
        list.push(e);
        references.set(e.path, list);
      }
    const files: OrganizationFile[] = [],
      seen = new Set<string>();
    let excludedCount = 0;
    for (const group of result.groups)
      for (const entry of group.files) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        const refs = references.get(entry.path) || [];
        const visible = refs.filter(
          (e) => !e.excluded && !works.get(e.workId)?.excluded,
        );
        const existing =
          visible.find((e) => e.id === stableId(connectionId, entry.path)) ||
          visible[0];
        const scannedOwner = works.get(stableId(connectionId, group.path));
        if (!existing && (refs.length || scannedOwner?.excluded)) {
          excludedCount++;
          continue;
        }
        const root = group.root || result.scopes?.[0]?.root;
        if (!root) throw new Error("invalidInput");
        const paths = root.includes("\\") ? path.win32 : path.posix;
        files.push({
          id: stableId(connectionId, entry.path),
          connectionId,
          root,
          path: entry.path,
          relativePath: paths.relative(root, entry.path),
          name: entry.name,
          size: entry.size,
          modified: entry.modified,
          episodeId: existing?.id,
          workId: existing?.workId,
          currentTitle: existing
            ? works.get(existing.workId)?.title
            : undefined,
          duration:
            existing?.size === entry.size &&
            existing.modified === entry.modified
              ? existing.duration
              : null,
        });
      }
    return { files, excludedCount };
  }
  applyOrganization(
    plan: OrganizationPlan,
    selection: OrganizationApply,
    baseline: string | OrganizationSnapshot,
  ) {
    if (typeof baseline === "string") {
      if (this.organizationFingerprint() !== baseline)
        throw new Error("organizationStale");
    } else
      this.assertOrganizationSnapshot(
        plan,
        selection.groups.map((g) => g.id),
        baseline,
        selection.acknowledgedRemovals || [],
      );
    const fileExclusions = selection.fileExclusionIds || [];
    if (
      new Set(fileExclusions).size !== fileExclusions.length ||
      fileExclusions.some(
        (id) =>
          !plan.fileExclusions?.includes(id) || !plan.unassigned.includes(id),
      )
    )
      throw new Error("invalidInput");
    const relationshipRemovals = selection.relationshipRemovalIds || [];
    if (
      new Set(relationshipRemovals).size !== relationshipRemovals.length ||
      relationshipRemovals.some(
        (id) => !plan.relationshipRemovals?.some((r) => r.id === id),
      )
    )
      throw new Error("invalidInput");
    const choices = new Map(selection.groups.map((g) => [g.id, g.title]));
    if (
      choices.size !== selection.groups.length ||
      selection.groups.some((g) => !plan.groups.some((p) => p.id === g.id)) ||
      new Set(selection.collectionIds).size !==
        selection.collectionIds.length ||
      selection.collectionIds.some(
        (id) => !plan.collections.some((c) => c.id === id),
      )
    )
      throw new Error("invalidInput");
    const groups = plan.groups.filter((g) => choices.has(g.id));
    const removals = selection.acknowledgedRemovals || [];
    if (
      new Set(removals).size !== removals.length ||
      removals.some((id) => !plan.delta?.removed.some((f) => f.id === id)) ||
      (!groups.some((g) => !g.referenceOnly) &&
        !removals.length &&
        !relationshipRemovals.length &&
        !fileExclusions.length)
    )
      throw new Error("invalidInput");
    const existingFiles = this.all<StoredEpisode>("episode");
    const fileMap = new Map(
      plan.files.map((f) => {
        const now = !f.episodeId
          ? existingFiles.find(
              (e) =>
                !e.excluded &&
                e.connectionId === f.connectionId &&
                e.path === f.path &&
                e.size === f.size &&
                e.modified === f.modified,
            )
          : undefined;
        return [
          f.id,
          now ? { ...f, episodeId: now.id, workId: now.workId } : f,
        ];
      }),
    );
    const selectedFiles = groups.flatMap((g) => g.fileIds);
    if (
      new Set(selectedFiles).size !== selectedFiles.length ||
      selectedFiles.some(
        (id) => !fileMap.has(id) || fileExclusions.includes(id),
      ) ||
      fileExclusions.some((id) => !fileMap.has(id))
    )
      throw new Error("invalidInput");
    const oldEpisodes = this.all<StoredEpisode>("episode");
    const groupWorks = new Map<string, string>(),
      replacements = new Map<string, Set<string>>();
    const parser = this.snapshot().settings.recognition.parser;
    const currentState = this.organizationSnapshot();
    this.transaction(() => {
      // Explicit reviewed relationship deletions are atomic with regrouping.
      // Omission from AI output never implies deletion of an existing record.
      for (const id of relationshipRemovals) {
        const removal = plan.relationshipRemovals!.find((r) => r.id === id)!;
        if (
          plan.collections.some(
            (c) =>
              selection.collectionIds.includes(c.id) &&
              c.existingCollectionId === id,
          )
        )
          throw new Error("invalidInput");
        const current = this.get<Collection>(removal.kind, id);
        if (!current) continue;
        const sameMembers = (a: string[] = [], b: string[] = []) =>
          JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        if (
          current.name !== removal.name ||
          !sameMembers(current.workIds, removal.workIds) ||
          !sameMembers(current.seriesIds, removal.seriesIds)
        )
          throw new Error("organizationStale");
        this.recordRelationshipEdit(removal.kind, current, "removed");
        if (removal.kind === "series") {
          for (const c of this.all<Collection>("collection"))
            if (c.seriesIds?.includes(id))
              this.put("collection", c.id, {
                ...c,
                seriesIds: c.seriesIds.filter((s) => s !== id),
                workIds: [...new Set([...c.workIds, ...current.workIds])],
              });
        }
        this.db
          .prepare("DELETE FROM records WHERE kind=? AND id=?")
          .run(removal.kind, id);
      }
      const removedWorks = new Set<string>();
      for (const id of fileExclusions) {
        const f = fileMap.get(id)!;
        const old = oldEpisodes.find(
          (e) =>
            e.connectionId === f.connectionId &&
            e.path === f.path &&
            !e.excluded,
        );
        if (!old) {
          this.put("episode", f.episodeId || f.id, {
            id: f.episodeId || f.id,
            workId: f.workId || stableId("excluded", f.connectionId, f.root),
            connectionId: f.connectionId,
            path: f.path,
            fileName: f.name,
            size: f.size,
            modified: f.modified,
            duration: f.duration,
            position: 0,
            order: 0,
            number: "",
            title: "",
            description: "",
            missing: false,
            excluded: true,
            manual: true,
            assignmentOrigin: "manual",
          });
          continue;
        }
        if (
          typeof baseline !== "string" &&
          (baseline.files[old.id]?.signature !==
            currentState.files[old.id]?.signature ||
            baseline.works[old.workId] !== currentState.works[old.workId])
        )
          throw new Error("organizationStale");
        old.excluded = true;
        old.manual = true;
        old.assignmentOrigin = "manual";
        this.put("episode", old.id, old);
        removedWorks.add(old.workId);
      }
      for (const id of removals) {
        const old = plan.delta!.removed.find((f) => f.id === id)!;
        for (const file of oldEpisodes.filter(
          (e) =>
            !e.excluded &&
            e.connectionId === old.connectionId &&
            e.path === old.path,
        )) {
          file.excluded = true;
          file.manual = true;
          file.assignmentOrigin = "manual";
          this.put("episode", file.id, file);
          removedWorks.add(file.workId);
        }
      }
      for (const id of removedWorks)
        if (!oldEpisodes.some((e) => e.workId === id && !e.excluded)) {
          const work = this.get<StoredWork>("work", id);
          if (work)
            this.put("work", id, { ...work, excluded: true, resumeId: null });
          for (const kind of ["series", "collection"])
            for (const c of this.all<Collection>(kind))
              if (c.workIds.includes(id))
                this.put(kind, c.id, {
                  ...c,
                  workIds: c.workIds.filter((w) => w !== id),
                });
        }
      for (const group of groups) {
        if (group.referenceOnly) {
          const work =
            group.existingWorkId &&
            this.get<StoredWork>("work", group.existingWorkId);
          if (!work || work.excluded || group.fileIds.length)
            throw new Error("organizationStale");
          groupWorks.set(group.id, work.id);
          continue;
        }
        const files = group.fileIds.map((id) => fileMap.get(id)!);
        const previous = files.map((f) =>
          f.episodeId
            ? this.get<StoredEpisode>("episode", f.episodeId)
            : undefined,
        );
        const oldIds = new Set(
          previous.map((e) => e?.workId).filter((id): id is string => !!id),
        );
        const soleId = oldIds.size === 1 ? [...oldIds][0] : undefined;
        const exact =
          soleId &&
          previous.every(Boolean) &&
          (group.existingWorkId === soleId ||
            oldEpisodes.filter((e) => e.workId === soleId && !e.excluded)
              .length === files.length);
        const old = exact ? this.get<StoredWork>("work", soleId) : undefined;
        const workId =
          old?.id || stableId("organization", plan.jobId, group.id);
        groupWorks.set(group.id, workId);
        if (old) {
          // Preserve identity/playback, not erroneous names or ordering. Only
          // changes actually typed in the preview count as manual title edits.
          const title = choices.get(group.id)!;
          const locks = {
            ...this.get<Record<string, boolean>>("metadata-lock", old.id),
          };
          if (title !== old.title) {
            this.put("work", old.id, { ...old, title });
            if (title !== group.title) locks["work:title"] = true;
            else delete locks["work:title"];
          }
          // Reorder only the selected slots, leaving out-of-scope episodes in
          // place. A subset of a work must not renumber or detach the others.
          const slots = previous.map((e) => e!.order).sort((a, b) => a - b);
          const reordered = previous.some((e, i) => e!.order !== slots[i]);
          if (
            reordered &&
            oldEpisodes.filter((e) => e.workId === old.id && !e.excluded)
              .length === files.length
          )
            delete locks["work:files"];
          const oldLocks =
            this.get<Record<string, boolean>>("metadata-lock", old.id) || {};
          if (JSON.stringify(locks) !== JSON.stringify(oldLocks))
            this.put("metadata-lock", old.id, locks);
          for (const [i, file] of files.entries()) {
            const episode = previous[i]!;
            if (
              episode.order !== slots[i] ||
              episode.size !== file.size ||
              episode.modified !== file.modified ||
              episode.missing
            )
              this.put("episode", episode.id, {
                ...episode,
                order: slots[i],
                size: file.size,
                modified: file.modified,
                duration:
                  episode.size === file.size &&
                  episode.modified === file.modified
                    ? episode.duration
                    : null,
                missing: false,
              });
          }
          continue;
        }
        // A split retains its source's metadata. Merges retain the first work's
        // descriptive fields and combine tags; manual changes require review.
        const origins = this.snapshot().works.filter((w) => oldIds.has(w.id));
        const inherited = origins[0];
        const episodes: StoredEpisode[] = files.map((file, order) => {
          const e = previous[order];
          if (
            e &&
            (e.excluded || this.get<StoredWork>("work", e.workId)?.excluded)
          )
            throw new Error("organizationStale");
          const parsed = e ? null : parseFilename(file.name, parser);
          if (e) {
            const ids = replacements.get(e.workId) || new Set<string>();
            ids.add(workId);
            replacements.set(e.workId, ids);
          }
          return {
            ...(e || {}),
            id: e?.id || file.id,
            workId,
            connectionId: file.connectionId,
            path: file.path,
            fileName: file.name,
            size: file.size,
            modified: file.modified,
            duration:
              e?.size === file.size && e.modified === file.modified
                ? e.duration
                : null,
            position: e?.position || 0,
            order,
            missing: false,
            excluded: false,
            manual: true,
            assignmentOrigin: "organization",
            number: e?.number || parsed?.number || "",
            title: e?.title || parsed?.episodeTitle || "",
            description: e?.description || "",
          };
        });
        const resumeId =
          (inherited?.resumeId &&
          episodes.some((e) => e.id === inherited.resumeId)
            ? inherited.resumeId
            : null) ||
          [...episodes].reverse().find((e) => e.position > 0)?.id ||
          null;
        const work: StoredWork = {
          ...(inherited ? { cover: inherited.cover } : {}),
          id: workId,
          connectionId: files[0].connectionId,
          root: files[0].root,
          path: files[0].path,
          title: choices.get(group.id)!,
          description: inherited?.description || "",
          tags: [...new Set(origins.flatMap((w) => w.tags))],
          createdAt: inherited?.createdAt || Date.now(),
          order: inherited?.order ?? -Date.now(),
          resumeId,
          excluded: false,
          recognition: undefined,
        };
        this.put("work", workId, work);
        const locks =
          this.get<Record<string, boolean>>("metadata-lock", workId) || {};
        // Approval of AI output is not manual authorship of every value.
        if (choices.get(group.id) !== group.title) locks["work:title"] = true;
        else delete locks["work:title"];
        delete locks["work:files"];
        if (inherited) {
          const originalLocks =
            this.get<Record<string, boolean>>("metadata-lock", inherited.id) ||
            {};
          for (const field of ["title", "description", "tags", "cover"])
            if (field === "title" && work.title !== inherited.title) continue;
            else if (originalLocks[`work:${field}`])
              locks[`work:${field}`] = true;
        }
        for (const [index, episode] of episodes.entries()) {
          const original = previous[index];
          const originalLocks = original
            ? this.get<Record<string, boolean>>(
                "metadata-lock",
                original.workId,
              ) || {}
            : {};
          for (const field of ["number", "title", "description"])
            if (originalLocks[`${episode.id}:${field}`])
              locks[`${episode.id}:${field}`] = true;
          this.put("episode", episode.id, episode);
        }
        this.put("metadata-lock", workId, locks);
      }
      // Commit logical identities in the same transaction as work allocation.
      // Raw media identities and file progress never change during grouping.
      for (const group of groups) {
        if (group.referenceOnly || !group.episodes) continue; // legacy plans remain one file per episode
        const layoutIds = group.episodes.flatMap((e) =>
          e.versions.flatMap((v) => v.fileIds),
        );
        if (
          layoutIds.length !== group.fileIds.length ||
          new Set(layoutIds).size !== layoutIds.length ||
          layoutIds.some((id) => !group.fileIds.includes(id))
        )
          throw new Error("invalidInput");
        const workId = groupWorks.get(group.id)!;
        const work = this.get<StoredWork>("work", workId)!;
        const locks = {
          ...this.get<Record<string, boolean>>("metadata-lock", workId),
        };
        const rawId = (id: string) => fileMap.get(id)!.episodeId || id;
        const priorById = new Map(oldEpisodes.map((e) => [e.id, e]));
        const remap = new Map<string, string>();
        const used = new Set<string>();
        for (const episode of group.episodes) {
          const ids = episode.versions.flatMap((v) => v.fileIds.map(rawId));
          const prior = ids
            .map((id) => priorById.get(id))
            .filter((e): e is StoredEpisode => !!e);
          const oldLogical = [
            ...new Set(prior.map((e) => e.logicalId || e.id)),
          ];
          const reusable = oldLogical.find(
            (id) =>
              !used.has(id) &&
              oldEpisodes
                .filter((e) => !e.excluded && (e.logicalId || e.id) === id)
                .every((e) => ids.includes(e.id)),
          );
          const logicalId =
            reusable ||
            (ids.length === 1 &&
            !oldEpisodes.some(
              (e) =>
                e.id !== ids[0] &&
                (e.logicalId || e.id) === ids[0] &&
                !e.excluded,
            )
              ? ids[0]
              : stableId("logical-episode", ...[...ids].sort()));
          used.add(logicalId);
          const primary = prior.find((e) => e.id === logicalId) || prior[0];
          const fields = {
            number: episode.number,
            title: episode.title,
            description: primary?.description || "",
          };
          for (const field of ["number", "title", "description"] as const) {
            const authored = prior.find(
              (e) =>
                this.get<Record<string, boolean>>("metadata-lock", e.workId)?.[
                  `${e.logicalId || e.id}:${field}`
                ],
            );
            // Unspecified descriptions follow the strongest authored input.
            if (field === "description" && authored)
              fields.description = authored.description;
            if (authored && authored[field] === fields[field])
              locks[`${logicalId}:${field}`] = true;
            else delete locks[`${logicalId}:${field}`];
          }
          for (const version of episode.versions) {
            const versionFiles = version.fileIds.map(rawId);
            const priorVersion = prior.find((e) =>
              versionFiles.includes(e.id),
            )?.versionId;
            const reuseVersion =
              priorVersion &&
              oldEpisodes
                .filter((e) => !e.excluded && e.versionId === priorVersion)
                .every((e) => versionFiles.includes(e.id));
            const versionId = reuseVersion
              ? priorVersion
              : stableId("version", ...[...versionFiles].sort());
            for (const fileId of versionFiles) {
              const file = this.file(fileId);
              this.put("episode", fileId, {
                ...file,
                ...fields,
                logicalId,
                versionId,
                versionLabel: version.label,
                releaseKey: version.releaseKey,
                manual: true,
                assignmentOrigin: "organization",
              });
              remap.set(fileId, logicalId);
            }
          }
          // Keep a prior selected representation when it survives the merge.
          const choice = oldLogical
            .map((id) =>
              this.get<{ versionId: string; fileId: string }>(
                "playback-choice",
                id,
              ),
            )
            .find((v) => v && ids.includes(v.fileId));
          if (choice) {
            const file = this.file(choice.fileId);
            this.put("playback-choice", logicalId, {
              versionId: file.versionId,
              fileId: file.id,
            });
          } else if (prior.some((e) => e.position > 0)) {
            const file = this.file(
              [...prior].sort((a, b) => b.position - a.position)[0].id,
            );
            this.put("playback-choice", logicalId, {
              versionId: file.versionId,
              fileId: file.id,
            });
          }
        }
        const oldResumeFile = oldEpisodes.find(
          (e) => (e.logicalId || e.id) === work.resumeId && remap.has(e.id),
        );
        const resumeId =
          (work.resumeId &&
            (remap.get(work.resumeId) ||
              (oldResumeFile && remap.get(oldResumeFile.id)))) ||
          work.resumeId;
        this.put("work", workId, { ...work, resumeId });
        this.put("metadata-lock", workId, locks);
      }
      const afterEpisodes = this.all<StoredEpisode>("episode");
      for (const [oldId, nextIds] of replacements) {
        const remaining = afterEpisodes.filter(
          (e) => e.workId === oldId && !e.excluded,
        );
        if (remaining.length) nextIds.add(oldId);
        const old = this.get<StoredWork>("work", oldId);
        if (old)
          this.put("work", oldId, {
            ...old,
            recognition: undefined,
            resumeId: remaining.some(
              (e) => (e.logicalId || e.id) === old.resumeId,
            )
              ? old.resumeId
              : [...remaining].reverse().find((e) => e.position > 0)
                  ?.logicalId || null,
          });
      }
      for (const kind of ["collection", "series"] as const)
        for (const collection of this.all<Collection>(kind))
          this.put(kind, collection.id, {
            ...collection,
            workIds: [
              ...new Set(
                collection.workIds.flatMap((id) =>
                  replacements.has(id) ? [...replacements.get(id)!] : [id],
                ),
              ),
            ],
          });
      for (const edit of this.all<
        NonNullable<OrganizationContext["relationshipEdits"]>[number]
      >("organization-relationship-edit"))
        this.put("organization-relationship-edit", `${edit.kind}:${edit.id}`, {
          ...edit,
          workIds: [
            ...new Set(
              edit.workIds.flatMap((id) =>
                replacements.has(id) ? [...replacements.get(id)!] : [id],
              ),
            ),
          ],
        });
      for (const collection of plan.collections
        .filter(
          (c) =>
            selection.collectionIds.includes(c.id) &&
            c.groupIds.every((id) => choices.has(id)),
        )
        .sort(
          (a, b) => Number(b.kind === "series") - Number(a.kind === "series"),
        )) {
        const ids = collection.groupIds
          .map((id) => groupWorks.get(id))
          .filter((id): id is string => !!id);
        if (ids.length < 2) continue;
        const kind = collection.kind || "collection";
        const existing = this.all<Collection>(kind).find((c) =>
          collection.existingCollectionId
            ? c.id === collection.existingCollectionId
            : c.name.toLocaleLowerCase() ===
                collection.name.toLocaleLowerCase() ||
              (c.workIds.length === ids.length &&
                ids.every((id) => c.workIds.includes(id))),
        );
        const value = {
          id: existing?.id || randomUUID(),
          name: collection.name,
          ...(kind === "collection" ? { seriesIds: [] as string[] } : {}),
          // Approval replaces membership for the works actually applied in this
          // transaction. Preserve untouched/out-of-scope works, but do not union
          // an explicitly excluded selected work back into the corrected set.
          workIds: [
            ...new Set([
              ...[
                ...new Set([
                  ...(existing?.workIds || []),
                  ...(existing?.seriesIds || []).flatMap(
                    (id) => this.get<Series>("series", id)?.workIds || [],
                  ),
                ]),
              ].filter((id) => ![...groupWorks.values()].includes(id)),
              ...ids,
            ]),
          ],
        };
        if (kind === "series") {
          // An approved reassignment moves members, never duplicates ownership.
          for (const other of this.all<Series>("series")) {
            if (other.id === value.id) continue;
            this.put("series", other.id, {
              ...other,
              workIds: other.workIds.filter(
                (id) => !value.workIds.includes(id),
              ),
            });
          }
        }
        this.put(kind, value.id, value);
        this.clearSupersededRelationshipEdits(kind, value.id, value.workIds);
      }
      const series = this.all<Series>("series");
      const membership = new Set<string>();
      for (const s of series)
        for (const id of s.workIds) {
          if (membership.has(id)) throw new Error("invalidInput");
          membership.add(id);
        }
      // Factor complete series into collection entries without widening membership.
      for (const c of this.all<Collection>("collection")) {
        const seriesIds = new Set(c.seriesIds || []);
        const ids = new Set(c.workIds);
        for (const s of series)
          if (s.workIds.length && s.workIds.every((id) => ids.has(id))) {
            seriesIds.add(s.id);
            s.workIds.forEach((id) => ids.delete(id));
          }
        this.put("collection", c.id, {
          ...c,
          workIds: [...ids],
          seriesIds: [...seriesIds],
        });
      }
    });
    return {
      works: groups.filter((g) => !g.referenceOnly).length,
      removed: removals.length,
      excluded: fileExclusions.length,
      relationshipsRemoved: relationshipRemovals.length,
    };
  }
  saveTransfer(transfer: Transfer) {
    this.put("transfer", transfer.id, transfer);
  }
  downloadJobs(): import("../shared/capture").VideoDownloadJob[] {
    return this.all<import("../shared/capture").VideoDownloadJob>(
      "video-download",
    ).sort((a, b) => b.createdAt - a.createdAt);
  }
  removeDownloadJob(id: string) {
    this.db
      .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
      .run("video-download", id);
  }
  saveDownloadJob(job: import("../shared/capture").VideoDownloadJob) {
    this.put("video-download", job.id, job);
  }
}
