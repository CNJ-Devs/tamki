# Tamki working rules

- This repository currently implements a Chromium browser foundation. Library, capture, provider and transfer features are future work; do not present placeholders as completed integrations.
- Keep remote WebContentsView instances sandboxed, context-isolated, without Node integration or application preloads. Validate IPC callers and inputs in the main process.
- English README.md and README.zh-CN.md must stay aligned. Keep UI text in the explicit English/Chinese catalog.
- Preserve the approved mark, warm neutral palette, collapsible navigation and 8px right/bottom content inset. Avoid ornamental borders or redundant containers and copy.
- Requirements/research documents and private NAS data are maintained outside this repository. Never copy personal provider fixtures or credentials into the codebase.
- Use temporary profiles and local HTTP fixtures for automation. Run npm run check, npm test and npm run test:browser for browser changes; verify packaging when build inputs change.
