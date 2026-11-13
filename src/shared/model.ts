export type Language = "en" | "zh";
export type Palette = "hazel" | "forest" | "mist" | "iris" | "rose" | "lagoon";
export interface Preferences {
  language: Language;
  palette: Palette;
  mode: "light" | "dark" | "system";
  refreshOnOpen: boolean;
}
export interface Connection {
  id: string;
  type: "local" | "zspace";
  name: string;
  roots: string[];
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
  size: number;
  modified: number;
  duration: number | null;
  position: number;
  order: number;
  missing: boolean;
}
export interface Work {
  id: string;
  connectionId: string;
  root: string;
  path: string;
  title: string;
  description: string;
  tags: string[];
  createdAt: number;
  order: number;
  resumeId: string | null;
  episodes: Episode[];
}
export interface Collection {
  id: string;
  name: string;
  workIds: string[];
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
  connections: Connection[];
  works: Work[];
  collections: Collection[];
  transfers: Transfer[];
  preferences: Preferences;
  refreshing: boolean;
}
export interface BrowserTab {
  id: number;
  kind: "web" | "player";
  workId?: string;
  title: string;
  url: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  error: string;
}
export interface BrowserState {
  active: number;
  tabs: BrowserTab[];
  pickerOpen: boolean;
}
export interface TabPickerState {
  browser: BrowserState;
  preferences: Preferences;
}
export interface TamkiBridge {
  readonly platform: string;
  action(type: string, value?: unknown): Promise<BrowserState>;
  library<T = LibraryState>(type: string, value?: unknown): Promise<T>;
  onState(callback: (state: BrowserState) => void): () => void;
  onLibrary(callback: (state: LibraryState) => void): () => void;
  onFocusAddress(callback: () => void): () => void;
  onFocusTabs(callback: () => void): () => void;
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
