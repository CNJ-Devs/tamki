import { build } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { prepareMediaTool } from "./media-tool.mjs";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/ui", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron"],
});
await build({
  entryPoints: [
    "src/preload.ts",
    "src/tab-picker-preload.ts",
    "src/capture-preload.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
});
await build({
  entryPoints: [
    "src/ui/app.tsx",
    "src/ui/tab-picker.tsx",
    "src/ui/capture.tsx",
  ],
  bundle: true,
  platform: "browser",
  format: "iife",
  outdir: "dist/ui",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "linked",
});
execFileSync(
  process.execPath,
  [
    "node_modules/@tailwindcss/cli/dist/index.mjs",
    "-i",
    "src/ui/style.css",
    "-o",
    "dist/ui/style.css",
    "--minify",
  ],
  { stdio: "inherit" },
);
await cp("src/ui/index.html", "dist/ui/index.html");
await cp("src/ui/tab-picker.html", "dist/ui/tab-picker.html");
await cp("src/ui/capture.html", "dist/ui/capture.html");
await prepareMediaTool("dist/tools");
await cp("assets", "dist/ui/assets", { recursive: true });
