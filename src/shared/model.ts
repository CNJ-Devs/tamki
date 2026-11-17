export type Language = "en" | "zh";
export type Palette = "hazel" | "forest" | "mist" | "iris" | "rose" | "lagoon";
export type AppIconStyle = "default" | "light" | "color";
export interface Preferences {
  language: Language;
  palette: Palette;
  mode: "light" | "dark" | "system";
  refreshOnOpen: boolean;
  appIconStyle?: AppIconStyle;
}
export interface Connection {
  id: string;
  type: "local" | "zspace";
  name: string;
  roots: string[];
  /** Relative directory depth per selected root. Absent legacy values mean one level. */
  scanDepths?: Record<string, number>;
  allowLANHTTP?: boolean;
  /** Authorized browsing scope; roots above are only the selected scan folders. */
  browseRoots?: string[];
  status: "connected" | "offline" | "scanning";
  error: string | null;
  scannedAt: number | null;
}
export interface Entry {
  path: string;
  name: string;
  directory: boolean;
  size: number;
  modified: number;
}
export interface Episode {
  id: string;
  workId: string;
  connectionId: string;
  path: string;
  fileName: string;
  number: string;
  title: string;
  description: string;
  /** Local cached official episode artwork; never a whole-work poster. */
  cover?: string;
  artworkSource?: string;
  artworkError?: boolean;
  size: number;
  modified: number;
  duration: number | null;
  position: number;
  order: number;
  missing: boolean;
  /** Logical episode. The legacy media fields above project the selected file. */
  versions?: EpisodeVersion[];
  activeVersionId?: string;
  activeFileId?: string;
}
export interface VideoFile {
  id: string;
  connectionId: string;
  path: string;
  fileName: string;
  size: number;
  modified: number;
  duration: number | null;
  position: number;
  missing: boolean;
}
export interface EpisodeVersion {
  id: string;
  label: string;
  /** Same release across episodes, scoped to this work; empty means unknown. */
  releaseKey: string;
  /** Distinct storage copies of the same representation. */
  files: VideoFile[];
}
export interface Work {
  id: string;
  connectionId: string;
  root: string;
  path: string;
  title: string;
  description: string;
  tags: string[];
  /** Opaque key of verified artwork in the local cache. */
  cover?: string;
  captureSource?: { id: string; url: string; cover?: string };
  recognition?: {
    status:
      | "queued"
      | "running"
      | "complete"
      | "needs-choice"
      | "no-match"
      | "failed"
      | "local";
    sourceId: string;
    signature: string;
    candidate?: string;
    /** An explicit batch request runs even when automatic recognition is off. */
    requested?: boolean;
    error?: string;
    artworkError?: boolean;
    artworkSource?: { cover: string | null; coverPage: string | null };
  };
  createdAt: number;
  order: number;
  resumeId: string | null;
  preferredVersionKey?: string;
  episodes: Episode[];
}
export interface Series {
  id: string;
  name: string;
  /** Ordered independent works; never other series. */
  workIds: string[];
}
export interface Collection {
  id: string;
  name: string;
  workIds: string[];
  seriesIds?: string[];
}
export interface Transfer {
  id: string;
  name: string;
  destination: string;
  state: "running" | "paused" | "completed" | "cancelled" | "interrupted";
  received: number;
  total: number;
  createdAt: number;
}
export interface LibraryState {
  settings: import("./settings").SettingsState;
  connections: Connection[];
  works: Work[];
  collections: Collection[];
  series?: Series[];
  transfers: Transfer[];
  videoDownloads?: import("./capture").VideoDownloadJob[];
  preferences: Preferences;
  refreshing: boolean;
}
export interface PlaybackGroup {
  id: string;
  title: string;
  episodeIds: string[];
}
export interface OnlineWork extends Work {
  playbackGroups?: PlaybackGroup[];
  pageURL?: string;
  collectionError?: string;
}
export interface BrowserTab {
  onlineWork?: OnlineWork;
  id: number;
  favicon?: string;
  audible?: boolean;
  muted?: boolean;
  zoom?: number;
  find?: { open: boolean; text: string; active: number; matches: number };
  kind: "web" | "player";
  workId?: string;
  title: string;
  url: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  error: string;
}
export interface BrowserBookmark {
  id: string;
  url: string;
  title: string;
}
export interface BrowserState {
  bookmarks?: BrowserBookmark[];
  searchEngine?: import("../navigation").SearchEngine;
  active: number;
  tabs: BrowserTab[];
  pickerOpen: boolean;
  pickerMode?: "tabs" | "history" | "tasks" | "bookmarks" | "address";
}
export interface BrowserVisit {
  url: string;
  title: string;
  time: number;
}
export interface TabPickerState {
  mode?: "tabs" | "history" | "tasks" | "bookmarks" | "address";
  history?: BrowserVisit[];
  suggestions?: BrowserVisit[];
  suggestionIndex?: number;
  jobs?: import("./capture").VideoDownloadJob[];
  transfers?: Transfer[];
  browser: BrowserState;
  preferences: Preferences;
}
export interface TamkiBridge {
  readonly platform: string;
  action(type: string, value?: unknown): Promise<BrowserState>;
  library<T = LibraryState>(type: string, value?: unknown): Promise<T>;
  onState(callback: (state: BrowserState) => void): () => void;
  onLibrary(callback: (state: LibraryState) => void): () => void;
  onDownloads(
    callback: (jobs: import("./capture").VideoDownloadJob[]) => void,
  ): () => void;
  onFocusAddress(callback: () => void): () => void;
  onFocusFind(callback: () => void): () => void;
  onFocusTabs(callback: () => void): () => void;
  onPlayDownload(
    callback: (value: { workId: string; episodeId: string }) => void,
  ): () => void;
  onOpenPage(callback: (page: "settings" | "tasks") => void): () => void;
}
declare global {
  interface Window {
    tamki: TamkiBridge;
    tamkiTabs: {
      action(type: string, value?: unknown): Promise<TabPickerState>;
      onState(callback: (state: TabPickerState) => void): () => void;
    };
  }
}

export function episodeName(episode: Episode): string {
  return (
    [episode.number, episode.title].filter(Boolean).join(" · ") ||
    episode.fileName
  );
}
export function progress(work: Work): number {
  const total = work.episodes.reduce((sum, e) => sum + (e.duration || 0), 0);
  if (!total) return 0;
  const current = work.episodes.findIndex((e) => e.id === work.resumeId);
  const watched = work.episodes.reduce(
    (sum, e, i) =>
      sum +
      (i < current
        ? e.duration || 0
        : i === current
          ? Math.min(e.position, e.duration || 0)
          : 0),
    0,
  );
  return Math.min(1, watched / total);
}
