# Contributing to Tamki

Use Node.js 22.12+ and `npm ci`. Run `npm run check`, `npm test`, and `npm run test:browser` for browser behavior changes. The integration suite uses temporary profiles and local fixture pages. Use `npm run package` when changing packaging or build inputs.

Keep the application shell separate from untrusted browsing views. Do not add Node integration, privileged preloads, permissive IPC, disabled web security or arbitrary external protocol launching to remote pages. Preserve sender validation when expanding IPC.

English and Simplified Chinese README versions should describe the same feature state. User-facing strings belong in the explicit language catalog. Planned integrations must remain labeled as planned until their complete workflow is implemented and verified.

Never include personal media, credentials, OAuth codes, storage identifiers, private connection paths or real browsing profiles in commits, tests, screenshots or issue reports. Use synthetic fixtures.

The project is MIT licensed. Third-party code and assets require their own license review and attribution. Preserve the original chipmunk artwork; do not replace it with another product's mascot.
