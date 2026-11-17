import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const releaseTargets = [
  {
    id: "macos-arm64",
    platform: "darwin",
    arch: "arm64",
    folder: "Tamki-darwin-arm64",
    extension: "zip",
    executable: "Tamki.app/Contents/MacOS/Tamki",
    resources: "Tamki.app/Contents/Resources",
  },
  {
    id: "windows-x64",
    platform: "win32",
    arch: "x64",
    folder: "Tamki-win32-x64",
    extension: "zip",
    executable: "Tamki.exe",
    resources: "resources",
  },
  {
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    folder: "Tamki-linux-x64",
    extension: "tar.gz",
    executable: "Tamki",
    resources: "resources",
  },
];

export function releaseTarget(
  platform = process.platform,
  arch = process.arch,
) {
  const target = releaseTargets.find(
    (t) => t.platform === platform && t.arch === arch,
  );
  if (!target)
    throw new Error(`Unsupported release target: ${platform}-${arch}`);
  return target;
}

export function archiveName(version, target) {
  releaseMetadata(`v${version}`, version);
  return `Tamki-${version}-${target.id}.${target.extension}`;
}

export function tarCommand() {
  return process.platform === "win32"
    ? path.join(process.env.SystemRoot, "System32", "tar.exe")
    : "tar";
}

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

export async function prepareArchive(tag, candidate = false) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const metadata = candidate
    ? {
        ...releaseMetadata(`v${pkg.version}`, pkg.version),
        sha: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      }
    : await verifyRelease(tag);
  const target = releaseTarget();
  const bundle = path.join("packages", target.folder);
  const app =
    target.platform === "darwin" ? path.join(bundle, "Tamki.app") : bundle;
  const resources = path.join(bundle, target.resources);
  const archive = path.join(resources, "app.asar");
  const { extractFile } = await import("@electron/asar");
  const packaged = JSON.parse(extractFile(archive, "package.json").toString());
  releaseMetadata(metadata.tag, packaged.version);
  for (const file of await readdir("dist", { recursive: true })) {
    if (!/\.(cjs|js|css|html)$/.test(file)) continue;
    const relative = path.join("dist", file);
    if (
      !extractFile(archive, relative).equals(
        await readFile(path.join("dist", file)),
      )
    )
      throw new Error(`Packaged build mismatch: ${relative}`);
  }
  for (const file of [
    target.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    "FFMPEG-LICENSE",
    "FFMPEG-LICENSE-NOTES",
    "FFMPEG-BUILD.txt",
    "build-recipe.mjs",
    "ffmpeg-8.0.1-source.tar.xz",
  ])
    await access(path.join(resources, "app.asar.unpacked/dist/tools", file));
  if (target.platform === "win32")
    await access(
      path.join(resources, "app.asar.unpacked/dist/tools/TOOLCHAIN-LICENSES"),
    );
  const directory = `packages/releases/${metadata.version}/${target.id}`;
  await mkdir(directory, { recursive: true });
  const name = archiveName(metadata.version, target);
  if (target.platform === "darwin")
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
  else
    execFileSync(
      tarCommand(),
      [
        target.platform === "win32" ? "-acf" : "-czf",
        path.resolve(directory, name),
        "-C",
        "packages",
        target.folder,
      ],
      { stdio: "inherit" },
    );
  if (target.platform === "darwin")
    execFileSync("unzip", ["-tq", path.join(directory, name)], {
      stdio: "inherit",
    });
  else
    execFileSync(tarCommand(), ["-tf", path.join(directory, name)], {
      stdio: "ignore",
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
    `${notes}\n\n${candidate ? "Candidate" : `Built from tag \`${metadata.tag}\``}, commit \`${metadata.sha}\`.\n`,
  );
  await writeFile(
    path.join(directory, "release-manifest.json"),
    JSON.stringify({
      ...metadata,
      candidate,
      target: target.id,
      name,
      checksum,
    }),
  );
  return { ...metadata, directory, target: target.id, name };
}

export async function combineAssets(input, output, tag) {
  const manifests = [];
  for (const entry of await readdir(input, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(input, entry.name);
    manifests.push({
      ...JSON.parse(
        await readFile(path.join(directory, "release-manifest.json"), "utf8"),
      ),
      directory,
    });
  }
  if (
    manifests.length !== releaseTargets.length ||
    new Set(manifests.map((m) => m.target)).size !== releaseTargets.length
  )
    throw new Error(
      "Release requires one archive for every supported platform",
    );
  const first = manifests[0];
  releaseMetadata(tag, first.version);
  await mkdir(output, { recursive: true });
  let notes;
  const sums = [];
  for (const target of releaseTargets) {
    const manifest = manifests.find((m) => m.target === target.id);
    if (
      !manifest ||
      manifest.candidate !== false ||
      manifest.tag !== tag ||
      manifest.sha !== first.sha ||
      !/^[a-f0-9]{40}$/.test(manifest.sha) ||
      manifest.version !== first.version ||
      manifest.name !== archiveName(first.version, target)
    )
      throw new Error("Mixed or invalid release source/platform metadata");
    const bytes = await readFile(path.join(manifest.directory, manifest.name));
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.checksum)
      throw new Error("Release archive checksum mismatch");
    const text = await readFile(
      path.join(manifest.directory, "release-notes.md"),
      "utf8",
    );
    if (notes !== undefined && notes !== text)
      throw new Error("Release notes differ across platforms");
    notes = text;
    await writeFile(path.join(output, manifest.name), bytes);
    sums.push(`${manifest.checksum}  ${manifest.name}`);
  }
  await writeFile(path.join(output, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  await writeFile(path.join(output, "release-notes.md"), notes);
  return { tag, version: first.version, sha: first.sha };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, tag, output, expectedTag] = process.argv.slice(2);
  const result =
    command === "verify"
      ? await verifyRelease(tag)
      : command === "archive"
        ? await prepareArchive(tag)
        : command === "candidate"
          ? await prepareArchive(undefined, true)
          : command === "combine"
            ? await combineAssets(tag, output, expectedTag)
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
