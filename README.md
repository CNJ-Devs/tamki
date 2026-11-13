<div align="center">
  <img src="assets/mark.png" width="88" alt="Tamki chipmunk" />
  <h1>Tamki</h1>
  <p>A browser for discovering videos. A library across your own storage.</p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>
  <p><a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-a9482c" /></a></p>
</div>

Tamki is a desktop Chromium browser and a video library across user-selected storage. This development build adds a persistent library and player to the browser foundation.

## Current implementation

Uses Electron 45.3.1, Chromium, TypeScript, React, shadcn/Radix, Phosphor Regular icons and SQLite.

- Compact browser tabs with a pinned Home/library tab; settings and tasks are secondary pages.
- Real HTTP(S) browsing, navigation history, website popups in tabs and isolated persistent website sessions.
- Local storage connections with multiple native-selected folders. Scans include videos directly in each root and its immediate child directories.
- SQLite indexing, explicit/background refresh, partial-failure retention and persistent scan exclusions. Removing library entries never deletes their files; explicit manual addition can restore them.
- Search, watch-state filters, source/tag grouping, sorting, custom ordering and overlapping, non-nested collections.
- Work and episode editing, independent episode number/title fields, episode ordering/removal, cross-storage episode appending and tags. File paths are never renamed by metadata edits.
- Player tabs with real local media, byte-range seeking, resume history, automatic next episode, transport/speed/volume controls, fullscreen and mini player. Picture in picture uses Chromium's platform API where available.
- Real website-attachment task records with progress and live pause/resume/cancel. Interrupted tasks remain visible after restart; automatic transfer recovery is not implemented.
- Six semantic palettes, light/dark/system modes and English/Simplified Chinese.

**This is not the complete product.** Website video detection, Bilibili/series downloading, storage migration, AI/search metadata recognition, additional cloud providers and production update/installer distribution are still pending.

### Storage setup

Open **Home → Settings → Add connection**. Local folders use the operating system picker; select multiple folders and save to scan them. Network folders mounted by the OS can use this path, subject to the mount being available.

**ZSpace is an experimental read-only adapter to the separately installed [official ZSpace NAS Agent Toolkit](https://download.zspace.cn/), tested against its 0.3.11 command contracts.** Tamki detects the toolkit's standard runtime cache or lets you locate its CLI. It starts a dedicated OAuth profile; complete authorization in the browser and enter the one-time code in Tamki, then choose media folders from the directory browser. The code travels only through the active child process's stdin, and the CLI is instructed to use the system credential store. Tamki does not bundle the toolkit, borrow an existing account profile, or implement a private OAuth client.

The directory adapter and a 1 MiB media read have been checked against a real NAS. End-to-end fresh authorization and sustained remote playback in the packaged app still need live validation. CLI-mediated reads have per-request overhead and do not establish high-bitrate streaming performance or full-file version consistency. This is not a completed production NAS integration.

## Direction

The planned workflow is to browse, discover a video, choose a destination, and play or organize it from one aggregated library. Storage connections and multiple library roots belong in Settings. Downloads and storage transfers will share one task area.

The interface uses a chipmunk mark, warm neutral surfaces and a restrained hazel accent. Spacing and surface colors carry most of the hierarchy.

## Develop

Use Node.js **22.12+** and npm. Electron downloads its platform runtime on first use; allow access to its official release assets.

```sh
npm ci
npm run check
npm test
npm start
```

Shortcuts: `Cmd/Ctrl+L` focuses the address field, `Cmd/Ctrl+T` creates a tab, `Cmd/Ctrl+W` closes the current tab, and `Cmd/Ctrl+R` reloads it. `Ctrl+Tab` switches tabs on systems where the key event reaches the application.

```sh
npm run test:browser
npm run package
```

The integration suite uses local HTTP pages, a generated WebM fixture and temporary profiles. It covers browser isolation, native picker grants, scanning, editing, media ranges, playback, responsive controls and restart persistence, without real accounts. Packaging writes a development bundle for the current platform to `packages/`; it has no Developer ID signing or Apple notarization.

Validated locally on macOS Apple Silicon. Windows and Linux source paths are present, but native runtime behavior has not yet been validated there.

## Browser boundaries

Remote content runs without Node integration or an application preload, with sandboxing and context isolation enabled. The local shell has a narrow IPC bridge with sender validation. Remote navigation is limited to HTTP(S); site permission requests currently default to deny. Camera, microphone, notification and location permission management still needs a user interface.

This build does not include bookmarks, a history manager, password management, tab restoration, browser account sync, extension installation or automatic updates. Electron supports only part of Chrome's extension APIs; it does not provide general Chrome Web Store compatibility. Playback is currently limited to Chromium-supported containers/codecs. External subtitles, alternate audio tracks, transcoding and DRM are not implemented. Mini playback is currently contained in the trusted application shell; it does not overlay a native remote browsing view. Media codec and DRM compatibility must be tested separately. See [Electron's extension documentation](https://www.electronjs.org/docs/latest/api/extensions) and [security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep both README versions aligned and describe only verified behavior as implemented. Do not commit private storage paths, accounts, tokens, browser profiles or personal media.

MIT licensed. Maintained by CNJ-Devs.
