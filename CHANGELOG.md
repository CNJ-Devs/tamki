# Changelog

## 0.1.0-alpha.2

- Build and publish macOS Apple Silicon releases through GitHub Actions when a matching version tag is pushed after merging to main. Standard hosted runners are used; no local build or manual binary upload is required.
- Validate the release tag against package metadata and merged history, verify packaged assets and FFmpeg license/source files, and publish a ZIP with SHA-256 checksums only after tests pass.
- Correct the browser screenshot regression check for menu surfaces and display scaling on hosted runners.

This preview includes persistent browsing, Bilibili discovery/downloads, the indexed library/player and reviewed AI organization. Developer ID signing/notarization and additional platform binaries remain outside this release.

## 0.1.0-alpha.1

First packaged preview of Tamki's browser, indexed media library and player.

- Browse with persistent tabs, history, bookmarks, site controls and quick task panels.
- Discover Bilibili episodes, seasons and related series; preview streams and select videos and multiple qualities for download.
- Manage downloads with progress, rates, retries, stage-specific concurrency and batch actions.
- Organize indexed files into works, episodes, playback versions, series and collections. Review AI proposals and submit follow-up feedback before applying; incremental organization uses applied results as its baseline.
- Configure shared AI connections and recognition sources; cache work artwork and episode previews separately.
- Switch playback versions at the current timestamp and navigate episodes and series in the player.
- Use English or Simplified Chinese, semantic light/dark palettes and themed app icons.

The release artifact targets macOS Apple Silicon. It is unsigned and not notarized. The ZSpace CLI adapter remains experimental; synthetic contract coverage does not establish complete live-provider support. Other video/storage providers and storage migration remain future work. Live paid AI providers require account validation, and AI organization results require human review.
