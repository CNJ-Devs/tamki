# Tamki working rules

- This repository implements the Chromium browser, a local indexed library and player, and an experimental read-only ZSpace CLI adapter. Capture, AI recognition, migration and other providers are future work; do not present placeholders or partially validated adapters as completed integrations.
- Keep remote WebContentsView instances sandboxed, context-isolated, without Node integration or application preloads. Validate IPC callers and inputs in the main process.
- English README.md and README.zh-CN.md must stay aligned. Keep UI text in the explicit English/Chinese catalog.
- Preserve the approved mark, semantic palettes and compact browser tabs with a fixed Home tab. The approved UI supersedes the original sidebar; keep a uniform 8px left/right/bottom content inset. Avoid ornamental borders or redundant containers and copy.
- Requirements/research documents and private NAS data are maintained outside this repository. Never copy personal provider fixtures or credentials into the codebase.
- Use temporary profiles and local HTTP fixtures for automation. Run npm run check, npm test and npm run test:browser for browser changes; verify packaging when build inputs change.
