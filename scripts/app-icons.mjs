// Deterministic recoloring of the approved mark. Run explicitly when updating
// theme icon assets; normal builds consume the checked-in PNG/ICO/ICNS files.
import { chromium } from "playwright";
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const source = await readFile("assets/app-icon-template.png");
const themes = JSON.parse(await readFile("src/ui/themes.json", "utf8"));
const colorBase = (hex) =>
  "#" +
  [1, 3, 5]
    .map((i) =>
      Math.round(parseInt(hex.slice(i, i + 2), 16) * 1.1)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const specs = [
  { name: "default", background: "#e9a07f", foreground: "#191816" },
  ...Object.entries(themes.palettes).flatMap(([key, p]) => [
    {
      name: `light-${key}`,
      background: p.light.rail,
      foreground: p.light.accent,
    },
    {
      name: `color-${key}`,
      background: colorBase(p.light.accent),
      foreground: p.dark.page,
    },
  ]),
];
await mkdir("assets/app-icons", { recursive: true });
const browser = await chromium.launch({ headless: true });
let icons;
try {
  const page = await browser.newPage();
  icons = await page.evaluate(
    async ({ data, specs }) => {
      const bitmap = await createImageBitmap(await (await fetch(data)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const source = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)),
        base = [238, 233, 225],
        mark = [23, 23, 23];
      const encode = async (canvas) => {
        const bytes = new Uint8Array(
          await (
            await canvas.convertToBlob({ type: "image/png" })
          ).arrayBuffer(),
        );
        let value = "";
        for (let i = 0; i < bytes.length; i += 8192)
          value += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(value);
      };
      const out = [];
      for (const spec of specs) {
        const image = new ImageData(
            new Uint8ClampedArray(source.data),
            source.width,
            source.height,
          ),
          pixels = image.data,
          bg = rgb(spec.background),
          fg = rgb(spec.foreground);
        for (let p = 0; p < pixels.length; p += 4) {
          if (!pixels[p + 3]) continue;
          for (let c = 0; c < 3; c++) {
            const t = Math.max(
              0,
              Math.min(1, (source.data[p + c] - mark[c]) / (base[c] - mark[c])),
            );
            pixels[p + c] = Math.round(fg[c] + t * (bg[c] - fg[c]));
          }
        }
        ctx.putImageData(image, 0, 0);
        const frames = [];
        if (spec.name === "default")
          for (const size of [256, 128, 64, 32, 16]) {
            const scaled = new OffscreenCanvas(size, size);
            scaled.getContext("2d").drawImage(canvas, 0, 0, size, size);
            frames.push({ size, data: await encode(scaled) });
          }
        out.push({ ...spec, data: await encode(canvas), frames });
      }
      return out;
    },
    { data: "data:image/png;base64," + source.toString("base64"), specs },
  );
} finally {
  await browser.close();
}
for (const icon of icons)
  await writeFile(
    `assets/app-icons/${icon.name}.png`,
    Buffer.from(icon.data, "base64"),
  );
await copyFile("assets/app-icons/default.png", "assets/app.png");
const frames = icons[0].frames,
  header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
const payload = [];
for (const [index, frame] of frames.entries()) {
  const png = Buffer.from(frame.data, "base64"),
    at = 6 + index * 16;
  header[at] = frame.size === 256 ? 0 : frame.size;
  header[at + 1] = header[at];
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png.length;
  payload.push(png);
}
await writeFile("assets/app.ico", Buffer.concat([header, ...payload]));
if (process.platform === "darwin") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tamki-app-icon-")),
    iconset = path.join(temporary, "Tamki.iconset");
  try {
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512])
      for (const scale of [1, 2])
        execFileSync(
          "sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            "assets/app.png",
            "--out",
            path.join(
              iconset,
              `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
            ),
          ],
          { stdio: "ignore" },
        );
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", "assets/app.icns"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
console.log(
  `Created ${icons.length} PNG icon variants and platform app icon assets.`,
);
