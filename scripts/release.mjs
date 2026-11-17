import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

export function releaseMetadata(tag, version) {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      tag,
    )
  )
    throw new Error("Expected a version tag such as v0.1.0-alpha.2");
  if (tag !== `v${version}`) throw new Error("Tag and package version differ");
  return { tag, version, prerelease: String(version.includes("-")) };
}

export async function verifyRelease(tag, cwd = process.cwd()) {
  const pkg = JSON.parse(
    await readFile(path.join(cwd, "package.json"), "utf8"),
  );
  const metadata = releaseMetadata(tag, pkg.version);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const target = git("rev-parse", `refs/tags/${tag}^{commit}`);
  if (target !== git("rev-parse", "HEAD"))
    throw new Error("Checkout does not match the release tag");
  git("merge-base", "--is-ancestor", target, "refs/remotes/origin/main");
  return { ...metadata, sha: target };
}

async function prepareArchive(tag) {
  const metadata = await verifyRelease(tag);
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(
      "This release currently supports native macOS arm64 builds only",
    );
  const app = "packages/Tamki-darwin-arm64/Tamki.app";
  const resources = path.join(app, "Contents/Resources");
  const archive = path.join(resources, "app.asar");
  const packaged = JSON.parse(extractFile(archive, "package.json").toString());
  releaseMetadata(tag, packaged.version);
  for (const file of await readdir("dist", { recursive: true })) {
    if (!/\.(cjs|js|css|html)$/.test(file)) continue;
    const relative = `dist/${file.replaceAll(path.sep, "/")}`;
    if (
      !extractFile(archive, relative).equals(
        await readFile(path.join("dist", file)),
      )
    )
      throw new Error(`Packaged build mismatch: ${relative}`);
  }
  for (const file of [
    "ffmpeg",
    "FFMPEG-LICENSE",
    "FFMPEG-LICENSE-NOTES",
    "FFMPEG-BUILD.txt",
    "build-recipe.mjs",
    "ffmpeg-8.0.1-source.tar.xz",
  ])
    await access(path.join(resources, "app.asar.unpacked/dist/tools", file));
  const directory = `packages/releases/${metadata.version}`;
  await mkdir(directory, { recursive: true });
  const name = `Tamki-${metadata.version}-macos-arm64.zip`;
  execFileSync(
    "ditto",
    [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      app,
      path.join(directory, name),
    ],
    { stdio: "inherit" },
  );
  execFileSync("unzip", ["-tq", path.join(directory, name)], {
    stdio: "inherit",
  });
  const checksum = createHash("sha256")
    .update(await readFile(path.join(directory, name)))
    .digest("hex");
  await writeFile(
    path.join(directory, "SHA256SUMS.txt"),
    `${checksum}  ${name}\n`,
  );
  const changelog = await readFile("CHANGELOG.md", "utf8");
  const heading = `## ${metadata.version}\n`;
  if (!changelog.includes(heading))
    throw new Error("Missing release changelog entry");
  const notes = changelog.split(heading)[1].split("\n## ")[0].trim();
  await writeFile(
    path.join(directory, "release-notes.md"),
    `${notes}\n\nBuilt by GitHub Actions from tag \`${tag}\`, commit \`${metadata.sha}\`.\n`,
  );
  return { ...metadata, directory };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, tag] = process.argv.slice(2);
  const result =
    command === "verify"
      ? await verifyRelease(tag)
      : command === "archive"
        ? await prepareArchive(tag)
        : null;
  if (!result)
    throw new Error(
      "Usage: node scripts/release.mjs verify|archive <version-tag>",
    );
  if (process.env.GITHUB_OUTPUT)
    await writeFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { flag: "a" },
    );
  console.log(JSON.stringify(result));
}
