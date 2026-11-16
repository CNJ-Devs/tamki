import { packager } from "@electron/packager";
import { access } from "node:fs/promises";
import path from "node:path";
const paths = await packager({
  dir: ".",
  electronZipDir: process.env.TAMKI_ELECTRON_ZIP_DIR,
  name: "Tamki",
  out: process.env.TAMKI_PACKAGE_OUT || "packages",
  overwrite: true,
  asar: { unpackDir: "dist/tools" },
  appBundleId: "dev.cnj.tamki",
  icon:
    process.platform === "darwin"
      ? "assets/app.icns"
      : process.platform === "win32"
        ? "assets/app.ico"
        : "assets/app.png",
  ignore: [
    /^\/(src|tests|scripts|packages|test-results|\.github|\.cache)(\/|$)/,
    /^\/AGENTS\.md$/,
    /^\/tsconfig\.json$/,
  ],
});
for (const packaged of paths) {
  const resources =
    process.platform === "darwin"
      ? path.join(packaged, "Tamki.app", "Contents", "Resources")
      : path.join(packaged, "resources");
  await access(
    path.join(
      resources,
      "app.asar.unpacked",
      "dist",
      "tools",
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    ),
  );
}
console.log(paths.join("\n"));
