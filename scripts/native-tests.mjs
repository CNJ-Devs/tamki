import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { releaseTarget, tarCommand } from "./release.mjs";

const target = releaseTarget();
let temporary;
try {
  let executable;
  if (process.argv[2] === "packaged") {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const directory = `packages/releases/${pkg.version}/${target.id}`;
    const manifest = JSON.parse(
      await readFile(path.join(directory, "release-manifest.json"), "utf8"),
    );
    temporary = await mkdtemp(path.join(tmpdir(), "tamki-package-smoke-"));
    const archive = path.resolve(directory, manifest.name);
    if (process.platform === "darwin")
      execFileSync("ditto", ["-x", "-k", archive, temporary]);
    else execFileSync(tarCommand(), ["-xf", archive, "-C", temporary]);
    executable = path.join(
      temporary,
      process.platform === "darwin"
        ? "Tamki.app/Contents/MacOS/Tamki"
        : `${target.folder}/${target.executable}`,
    );
  }
  if (process.platform === "linux" && process.env.CI === "true") {
    const helper = executable
      ? path.join(path.dirname(executable), "chrome-sandbox")
      : path.join(
          path.dirname(createRequire(import.meta.url)("electron")),
          "chrome-sandbox",
        );
    // Configure the native setuid sandbox in the disposable runner. Never use
    // --no-sandbox or change remote WebContents security to make tests pass.
    execFileSync("sudo", ["chown", "root:root", helper]);
    execFileSync("sudo", ["chmod", "4755", helper]);
  }
  const env = {
    ...process.env,
    TAMKI_BACKGROUND_TEST: "1",
    ...(executable
      ? {
          TAMKI_PACKAGED_EXECUTABLE: executable,
          TAMKI_CAPTURE_EXECUTABLE: executable,
        }
      : {}),
  };
  for (const test of ["browser", "capture-browser"]) {
    const args = [process.execPath, `tests/${test}.mjs`];
    execFileSync(
      process.platform === "linux" ? "xvfb-run" : process.execPath,
      process.platform === "linux" ? ["-a", ...args] : args.slice(1),
      { env, stdio: "inherit", timeout: 240000 },
    );
  }
  console.log(
    `Passed ${target.id} ${executable ? "extracted package" : "source"} browser, playback, download and persistence checks.`,
  );
} finally {
  if (temporary)
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
}
