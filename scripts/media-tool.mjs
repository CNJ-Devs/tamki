import { mkdir, readFile, writeFile, stat, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

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
  if (process.platform === "win32") {
    if (!ffmpegStatic) throw new Error("No media tool for this platform");
    const configuration = execFileSync(ffmpegStatic, ["-version"], {
      encoding: "utf8",
    });
    if (configuration.includes("--enable-nonfree"))
      throw new Error("Cannot package a non-redistributable FFmpeg build");
    await cp(ffmpegStatic, path.join(destination, "ffmpeg.exe"));
    await cp(
      "node_modules/ffmpeg-static/ffmpeg.LICENSE",
      path.join(destination, "FFMPEG-BINARY-LICENSE"),
    );
    await cp(
      "node_modules/ffmpeg-static/LICENSE",
      path.join(destination, "FFMPEG-STATIC-LICENSE"),
    );
    await cp(
      "node_modules/ffmpeg-static/ffmpeg.README",
      path.join(destination, "FFMPEG-README"),
    );
    await writeFile(
      path.join(destination, "FFMPEG-BUILD.txt"),
      configuration +
        "\nBinary/source distribution: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1\n",
    );
    return;
  }
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
    flags,
  });
  const executable = path.join(source, "ffmpeg");
  if (
    (await readFile(path.join(cache, "build.json"), "utf8").catch(() => "")) !==
      signature ||
    !(await stat(executable).catch(() => null))
  ) {
    execFileSync("tar", ["-xf", archive, "-C", cache], { stdio: "inherit" });
    execFileSync("./configure", flags, { cwd: source, stdio: "inherit" });
    execFileSync("make", ["-j2"], { cwd: source, stdio: "inherit" });
    await writeFile(path.join(cache, "build.json"), signature);
  }
  const configuration = execFileSync(executable, ["-version"], {
    encoding: "utf8",
  });
  if (
    configuration.includes("--enable-nonfree") ||
    configuration.includes("--enable-gpl")
  )
    throw new Error("Unexpected media tool license configuration");
  await cp(executable, path.join(destination, "ffmpeg"));
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
      `\nSource: https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz\nSHA256: ${sha256}\nBuild: ./configure ${flags.join(" ")} && make -j2\n`,
  );
}
