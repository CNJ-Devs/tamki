import { mkdir, readFile, writeFile, stat, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

// A local-only remuxer built from unmodified upstream LGPL source. Do not ship
// ffmpeg-static's macOS binary: that build enables non-redistributable components.
const version = "8.0.1";
const sha256 =
  "05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41";
const flags = [
  "--disable-autodetect",
  "--disable-asm",
  "--disable-debug",
  "--enable-small",
  "--disable-doc",
  "--disable-ffprobe",
  "--disable-ffplay",
  "--disable-network",
  "--disable-everything",
  "--enable-ffmpeg",
  "--enable-protocol=file",
  "--enable-demuxer=mov,flv,mpegts,concat",
  "--enable-muxer=mp4",
  "--enable-parser=aac,h264,hevc,av1,mpegaudio,opus",
  "--enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,null",
  "--enable-decoder=h264,hevc,av1,aac,mp3,opus",
];
export async function prepareMediaTool(destination) {
  await mkdir(destination, { recursive: true });
  const windows = process.platform === "win32";
  const buildFlags = windows
    ? [
        ...flags,
        "--target-os=mingw32",
        "--arch=x86_64",
        "--enable-cross-compile",
        "--cc=gcc",
        "--extra-ldflags=-static",
      ]
    : flags;
  const cache = path.resolve(".cache", `ffmpeg-${version}`),
    source = path.join(cache, `ffmpeg-${version}`),
    archive = path.join(cache, "source.tar.xz");
  await mkdir(cache, { recursive: true });
  if (!(await stat(archive).catch(() => null)))
    execFileSync(
      "curl",
      [
        "-fL",
        "--retry",
        "2",
        "--max-time",
        "120",
        `https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`,
        "-o",
        archive,
      ],
      { stdio: "inherit" },
    );
  if (
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") !== sha256
  )
    throw new Error("FFmpeg source checksum mismatch");
  const signature = JSON.stringify({
    version,
    sha256,
    platform: process.platform,
    arch: process.arch,
    flags: buildFlags,
  });
  const executable = path.join(source, windows ? "ffmpeg.exe" : "ffmpeg");
  if (
    (await readFile(path.join(cache, "build.json"), "utf8").catch(() => "")) !==
      signature ||
    !(await stat(executable).catch(() => null))
  ) {
    execFileSync(
      windows
        ? path.join(process.env.SystemRoot, "System32", "tar.exe")
        : "tar",
      ["-xf", archive, "-C", cache],
      { stdio: "inherit" },
    );
    if (windows) {
      if (!process.env.TAMKI_MSYS2_BASH)
        throw new Error(
          "Windows builds require MSYS2 UCRT64; set TAMKI_MSYS2_BASH to its usr/bin/bash.exe",
        );
      const run = (command, args, timeout) =>
        execFileSync(
          process.env.TAMKI_MSYS2_BASH,
          [
            "-lc",
            'cd "$(cygpath -u "$TAMKI_FFMPEG_SOURCE")" && ' + command,
            "ffmpeg-build",
            ...args,
          ],
          {
            env: {
              ...process.env,
              MSYSTEM: "UCRT64",
              CHERE_INVOKING: "1",
              TAMKI_FFMPEG_SOURCE: source,
            },
            stdio: "inherit",
            timeout,
          },
        );
      try {
        // Avoid executing configure probes in the MSYS2 host. The resulting
        // Windows binary is executed by version checks and real mux tests below.
        run('./configure "$@"', buildFlags, 180000);
        run("make -j4", [], 900000);
      } catch (error) {
        if (process.env.CI === "true") {
          await mkdir("test-results", { recursive: true });
          await cp(
            path.join(source, "ffbuild/config.log"),
            "test-results/ffmpeg-config.log",
          ).catch(() => {});
        }
        throw error;
      }
    } else {
      execFileSync("./configure", buildFlags, {
        cwd: source,
        stdio: "inherit",
      });
      execFileSync("make", ["-j2"], { cwd: source, stdio: "inherit" });
    }
    await writeFile(path.join(cache, "build.json"), signature);
  }
  const configuration = execFileSync(executable, ["-version"], {
    encoding: "utf8",
    timeout: 20000,
  });
  if (
    configuration.includes("--enable-nonfree") ||
    configuration.includes("--enable-gpl")
  )
    throw new Error("Unexpected media tool license configuration");
  if (windows) {
    const msys = path.resolve(
      path.dirname(process.env.TAMKI_MSYS2_BASH),
      "../..",
    );
    const dependencies = execFileSync(
      path.join(msys, "ucrt64/bin/objdump.exe"),
      ["-p", executable],
      { encoding: "utf8" },
    );
    if (/DLL Name:\s*(?:libgcc|libstdc\+\+|libwinpthread)/i.test(dependencies))
      throw new Error(
        "Windows media tool still needs external compiler runtime DLLs",
      );
    await cp(
      path.join(msys, "ucrt64/share/licenses"),
      path.join(destination, "TOOLCHAIN-LICENSES"),
      { recursive: true },
    );
  }
  await cp(
    executable,
    path.join(destination, windows ? "ffmpeg.exe" : "ffmpeg"),
  );
  await cp(
    path.join(source, "COPYING.LGPLv2.1"),
    path.join(destination, "FFMPEG-LICENSE"),
  );
  await cp(
    path.join(source, "LICENSE.md"),
    path.join(destination, "FFMPEG-LICENSE-NOTES"),
  );
  // Corresponding unmodified source and the exact build recipe travel with the executable.
  await cp(archive, path.join(destination, `ffmpeg-${version}-source.tar.xz`));
  await cp(
    "scripts/media-tool.mjs",
    path.join(destination, "build-recipe.mjs"),
  );
  await writeFile(
    path.join(destination, "FFMPEG-BUILD.txt"),
    configuration +
      `\nSource: https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz\nSHA256: ${sha256}\nBuild: ./configure ${buildFlags.join(" ")} && make -j${windows ? 4 : 2}\n`,
  );
}
