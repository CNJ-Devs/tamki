import { packager } from "@electron/packager";
const paths = await packager({
  dir: ".",
  electronZipDir: process.env.TAMKI_ELECTRON_ZIP_DIR,
  name: "Tamki",
  out: "packages",
  overwrite: true,
  appBundleId: "dev.cnj.tamki",
  icon:
    process.platform === "darwin"
      ? "assets/app.icns"
      : process.platform === "win32"
        ? "assets/app.ico"
        : "assets/app.png",
  ignore: [
    /^\/(src|tests|scripts|packages|test-results|\.github)(\/|$)/,
    /^\/AGENTS\.md$/,
    /^\/tsconfig\.json$/,
  ],
});
console.log(paths.join("\n"));
