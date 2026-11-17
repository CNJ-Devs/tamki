import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appIconAsset, appIconStyles } from "../src/shared/app-icon";
import { preferencesSchema } from "../src/shared/validation";
import { LibraryStore } from "../src/library/store";
import type { Palette } from "../src/shared/model";

const palettes: Palette[] = [
  "hazel",
  "forest",
  "mist",
  "iris",
  "rose",
  "lagoon",
];
test("default icon is fixed; themed icon selection follows palette independently of light/dark/system mode", () => {
  for (const palette of palettes)
    for (const mode of ["light", "dark", "system"] as const) {
      const legacy = { palette, mode };
      assert.equal(appIconAsset(legacy), "app-icons/default.png");
      for (const appIconStyle of appIconStyles) {
        const preferences = { palette, mode, appIconStyle };
        assert.equal(
          appIconAsset(preferences),
          appIconStyle === "default"
            ? "app-icons/default.png"
            : `app-icons/${appIconStyle}-${palette}.png`,
        );
      }
    }
});
test("all selectable icons and packaged defaults are real 1024-pixel PNGs with ICO/ICNS defaults", async () => {
  for (const appIconStyle of appIconStyles)
    for (const palette of palettes) {
      const png = await readFile(
        path.join("assets", appIconAsset({ palette, appIconStyle })),
      );
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), 1024);
      assert.equal(png.readUInt32BE(20), 1024);
    }
  assert(
    (await readFile("assets/app.png")).equals(
      await readFile("assets/app-icons/default.png"),
    ),
  );
  const ico = await readFile("assets/app.ico");
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 5);
  const icns = await readFile("assets/app.icns");
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
});
test("legacy preferences remain valid, invalid icon paths are rejected, and selected style survives restart", async () => {
  const preferences = {
    language: "en" as const,
    palette: "iris" as const,
    mode: "dark" as const,
    refreshOnOpen: false,
  };
  assert(preferencesSchema.safeParse(preferences).success);
  assert.equal(
    preferencesSchema.safeParse({ ...preferences, appIconStyle: "../../other" })
      .success,
    false,
  );
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "tamki-icon-preferences-"),
  );
  let store = new LibraryStore(path.join(temporary, "library.sqlite"));
  try {
    store.setPreferences(
      preferencesSchema.parse({ ...preferences, appIconStyle: "color" }),
    );
    store.close();
    store = new LibraryStore(path.join(temporary, "library.sqlite"));
    assert.equal(store.preferences().appIconStyle, "color");
    assert.equal(appIconAsset(store.preferences()), "app-icons/color-iris.png");
  } finally {
    store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
