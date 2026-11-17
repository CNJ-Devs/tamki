import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { releaseMetadata, verifyRelease } from "../scripts/release.mjs";

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
