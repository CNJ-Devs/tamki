import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  releaseMetadata,
  verifyRelease,
  releaseTarget,
  releaseTargets,
  archiveName,
  combineAssets,
} from "../scripts/release.mjs";

test("release tags must match package versions and reject ref/path injection", () => {
  assert.equal(
    releaseMetadata("v0.1.0-alpha.2", "0.1.0-alpha.2").prerelease,
    "true",
  );
  assert.equal(releaseMetadata("v0.1.0", "0.1.0").prerelease, "false");
  for (const tag of [
    "main",
    "v0.1.1",
    "v0.1.0\nname=other",
    "v0.1.0/../../main",
    "v01.1.0",
  ])
    assert.throws(() => releaseMetadata(tag, "0.1.0"));
});

async function fixture(run) {
  const cwd = await mkdtemp(`${tmpdir()}/tamki-release-test-`);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Release fixture");
    git("config", "user.email", "release@example.test");
    await writeFile(
      `${cwd}/package.json`,
      JSON.stringify({ version: "0.1.0-alpha.2" }),
    );
    git("add", "package.json");
    git("commit", "-m", "Fixture release");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("tag", "v0.1.0-alpha.2");
    await run(cwd, git);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("a matching version tag on merged history is releasable", async () => {
  await fixture(async (cwd, git) => {
    assert.equal(
      (await verifyRelease("v0.1.0-alpha.2", cwd)).sha,
      git("rev-parse", "HEAD"),
    );
  });
});

test("an unmerged tagged commit cannot be released", async () => {
  await fixture(async (cwd, git) => {
    git("switch", "-c", "feature");
    await writeFile(
      `${cwd}/package.json`,
      JSON.stringify({ version: "0.1.0-alpha.3" }),
    );
    git("commit", "-am", "Unmerged version");
    git("tag", "v0.1.0-alpha.3");
    await assert.rejects(verifyRelease("v0.1.0-alpha.3", cwd));
  });
});

test("a checkout newer than the selected tag cannot be packaged as that tag", async () => {
  await fixture(async (cwd, git) => {
    await writeFile(`${cwd}/README.md`, "Unreleased change");
    git("add", "README.md");
    git("commit", "-m", "Unreleased change");
    await assert.rejects(
      verifyRelease("v0.1.0-alpha.2", cwd),
      /Checkout does not match/,
    );
  });
});

test("release artifacts are named for their actual OS and architecture", () => {
  assert.equal(
    archiveName("0.1.0-alpha.3", releaseTarget("win32", "x64")),
    "Tamki-0.1.0-alpha.3-windows-x64.zip",
  );
  assert.equal(
    archiveName("0.1.0-alpha.3", releaseTarget("linux", "x64")),
    "Tamki-0.1.0-alpha.3-linux-x64.tar.gz",
  );
  assert.equal(
    releaseTarget("darwin", "arm64").executable,
    "Tamki.app/Contents/MacOS/Tamki",
  );
  assert.throws(() => releaseTarget("linux", "arm64"), /Unsupported/);
});

test("publication requires every platform from the same tested source and rejects damaged or candidate archives", async () => {
  const temporary = await mkdtemp(`${tmpdir()}/tamki-artifacts-`);
  const input = path.join(temporary, "input"),
    output = path.join(temporary, "output");
  const version = "0.1.0-alpha.3",
    tag = `v${version}`,
    sha = "a".repeat(40);
  const manifests = [];
  try {
    for (const target of releaseTargets) {
      const directory = path.join(input, target.id);
      await mkdir(directory, { recursive: true });
      const name = archiveName(version, target),
        bytes = Buffer.from(`synthetic ${target.id}`);
      const manifest = {
        tag,
        version,
        sha,
        target: target.id,
        candidate: false,
        name,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      };
      manifests.push({ directory, manifest });
      await writeFile(path.join(directory, name), bytes);
      await writeFile(
        path.join(directory, "release-manifest.json"),
        JSON.stringify(manifest),
      );
      await writeFile(
        path.join(directory, "release-notes.md"),
        "Shared release notes\n",
      );
    }
    assert.equal((await combineAssets(input, output, tag)).sha, sha);
    assert.equal(
      (await readFile(path.join(output, "SHA256SUMS.txt"), "utf8"))
        .trim()
        .split("\n").length,
      3,
    );
    const { directory, manifest } = manifests[0];
    const change = (extra) =>
      writeFile(
        path.join(directory, "release-manifest.json"),
        JSON.stringify({ ...manifest, ...extra }),
      );
    await change({ sha: "b".repeat(40) });
    await assert.rejects(combineAssets(input, output, tag), /Mixed/);
    await change({ candidate: true });
    await assert.rejects(combineAssets(input, output, tag), /Mixed/);
    await change({ checksum: "0".repeat(64) });
    await assert.rejects(combineAssets(input, output, tag), /checksum/);
    await change({});
    await rm(directory, { recursive: true });
    await assert.rejects(combineAssets(input, output, tag), /every supported/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
