import { build } from "esbuild";
import { mkdir, cp } from "node:fs/promises";
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
  entryPoints: ["src/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/preload.cjs",
  external: ["electron"],
});
await cp("src/ui", "dist/ui", { recursive: true });
await cp("assets", "dist/ui/assets", { recursive: true });
