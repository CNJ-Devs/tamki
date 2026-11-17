import { waitForAsync } from "./wait.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
export async function checkSettings(app, shell, base, profile) {
  const iconGroup = shell.getByRole("radiogroup", {
    name: "App icon",
    exact: true,
  });
  const original = await shell.evaluate(
    async () => (await window.tamki.library("state")).preferences,
  );
  const observeDock = await app.evaluate(({ app }) => {
    globalThis.__iconCalls = [];
    if (!app.dock) return false;
    const setIcon = app.dock.setIcon.bind(app.dock);
    globalThis.__restoreDockIcon = () => {
      app.dock.setIcon = setIcon;
    };
    app.dock.setIcon = (image) => {
      const size = image.getSize(),
        bytes = image.toBitmap(),
        at = (80 * size.width + Math.floor(size.width / 2)) * 4;
      globalThis.__iconCalls.push([bytes[at + 2], bytes[at + 1], bytes[at]]);
    };
    return true;
  });
  const preferences = (patch) =>
    shell.evaluate(async (patch) => {
      const state = await window.tamki.library("state");
      await window.tamki.library("preferences", {
        ...state.preferences,
        ...patch,
      });
    }, patch);
  await iconGroup
    .getByRole("radio", { name: "Color base", exact: true })
    .click();
  await waitForAsync(
    shell,
    async () =>
      (await window.tamki.library("state")).preferences.appIconStyle ===
      "color",
  );
  await preferences({ palette: "hazel" });
  assert.match(
    await iconGroup.locator("img").last().getAttribute("src"),
    /color-hazel\.png$/,
  );
  if (observeDock)
    assert.deepEqual(
      await app.evaluate(() => globalThis.__iconCalls.at(-1)),
      [186, 79, 48],
    );
  const changes = await app.evaluate(() => globalThis.__iconCalls.length);
  await preferences({ mode: "dark" });
  await preferences({ mode: "system" });
  assert.equal(
    await app.evaluate(() => globalThis.__iconCalls.length),
    changes,
    "day/night changes must not alter the app icon",
  );
  await iconGroup.getByRole("radio", { name: "Default", exact: true }).click();
  await preferences({ palette: "mist" });
  if (observeDock)
    assert.deepEqual(
      await app.evaluate(() => globalThis.__iconCalls.at(-1)),
      [233, 160, 127],
    );
  await iconGroup
    .getByRole("radio", { name: "Light base", exact: true })
    .click();
  assert.match(
    await iconGroup.locator("img").nth(1).getAttribute("src"),
    /light-mist\.png$/,
  );
  if (observeDock)
    assert.deepEqual(
      await app.evaluate(() => globalThis.__iconCalls.at(-1)),
      [232, 236, 244],
    );
  await iconGroup.screenshot({ path: "test-results/settings-app-icons.png" });
  await app.evaluate(() => globalThis.__restoreDockIcon?.());
  await preferences({ ...original, appIconStyle: "color" });
  const series = shell.locator('[data-save-kind="series"]');
  await series.getByRole("radio", { name: "Fixed", exact: true }).click();
  await series.getByRole("combobox").click();
  await shell
    .getByRole("option", { name: "Fixture media", exact: true })
    .click();
  await series
    .getByRole("button", {
      name: "Series save location · Choose folder",
      exact: true,
    })
    .click();
  let dialog = shell.getByRole("dialog");
  await dialog.getByRole("button", { name: "Series", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Choose folder", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.match(
    await series.locator(".save-directory-trigger").innerText(),
    /Series$/,
  );
  await series
    .getByRole("radio", { name: "Follow last selection", exact: true })
    .click();
  await shell.waitForFunction(
    () =>
      document.querySelector('[data-save-kind="series"] [role="combobox"]')
        .disabled,
  );
  assert(await series.getByRole("combobox").isDisabled());
  await series.getByRole("radio", { name: "Fixed", exact: true }).click();
  await shell.waitForFunction(
    () =>
      !document.querySelector('[data-save-kind="series"] [role="combobox"]')
        .disabled,
  );
  assert.match(
    await series.locator(".save-directory-trigger").innerText(),
    /Series$/,
  );
  await shell
    .getByRole("combobox", { name: "Filename parser", exact: true })
    .click();
  await shell
    .getByRole("option", { name: "Anime · Anitomy", exact: true })
    .click();
  await shell
    .getByRole("button", { name: "AI recognition prompt", exact: true })
    .click();
  const editor = shell.getByRole("textbox", {
    name: "AI recognition prompt",
    exact: true,
  });
  await editor.waitFor();
  await dialog.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  assert.equal(
    await editor.locator('[data-prompt-variable="scope"]').count(),
    1,
  );
  const promptBounds = await dialog.boundingBox();
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("Fixture preference: ");
  await dialog
    .getByRole("button", { name: "Recognition scope", exact: true })
    .click();
  assert.equal(
    await editor.locator('[data-prompt-variable="scope"]').count(),
    2,
  );
  assert.equal(
    Math.round((await dialog.boundingBox()).height),
    Math.round(promptBounds.height),
  );
  await shell.screenshot({ path: "test-results/prompt-settings.png" });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await shell
    .getByRole("button", { name: "Add AI connection", exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: "Service type", exact: true })
    .click();
  await shell
    .getByRole("option", { name: "OpenAI Compatible", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("Fixture connection");
  await dialog.getByLabel("Service URL", { exact: true }).fill(base + "/v1");
  await dialog
    .getByLabel("API Key", { exact: true })
    .fill("tamki-model-secret-fixture");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await shell
    .getByRole("button", { name: "Source settings", exact: true })
    .click();
  await shell.getByRole("button", { name: "Add source", exact: true }).click();
  dialog = shell.getByRole("dialog");
  await dialog.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  const initialBounds = await dialog.boundingBox();
  await dialog.getByLabel("Name", { exact: true }).fill("Fixture source");
  await dialog
    .getByRole("combobox", { name: "AI connection", exact: true })
    .click();
  await shell
    .getByRole("option", { name: "Fixture connection", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Load models", exact: true })
    .click();
  await dialog.getByRole("combobox", { name: "Model", exact: true }).click();
  await shell
    .getByRole("option", { name: "Fixture text model", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Advanced settings", exact: true })
    .click();
  assert.equal(
    await dialog.getByLabel("Output token limit", { exact: true }).inputValue(),
    "8192",
  );
  assert.equal(
    await dialog
      .getByLabel("Request timeout (seconds)", { exact: true })
      .inputValue(),
    "300",
  );
  assert.equal(
    Math.round((await dialog.boundingBox()).height),
    Math.round(initialBounds.height),
  );
  await shell.screenshot({ path: "test-results/source-settings.png" });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await shell
    .getByRole("region", { name: "Source settings", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  const settings = await shell.evaluate(
    async () => (await window.tamki.library("state")).settings,
  );
  assert.equal(settings.recognition.sources[0].hasKey, true);
  assert(!JSON.stringify(settings).includes("tamki-model-secret-fixture"));
  for (const suffix of ["", "-wal"]) {
    const bytes = await readFile(
      path.join(profile, "library.sqlite" + suffix),
    ).catch(() => Buffer.alloc(0));
    assert(!bytes.includes(Buffer.from("tamki-model-secret-fixture")));
  }
  await shell
    .getByRole("combobox", { name: "Default recognition source", exact: true })
    .click();
  await shell
    .getByRole("option", { name: "Fixture source", exact: true })
    .click();
  await shell
    .getByRole("button", { name: "Source settings", exact: true })
    .click();
  await shell.getByRole("button", { name: "Edit source", exact: true }).click();
  assert.equal(await dialog.getByLabel("API Key", { exact: true }).count(), 0);
  assert.equal(
    await dialog
      .getByRole("combobox", { name: "AI connection", exact: true })
      .innerText(),
    "Fixture connection",
  );
  // Feature IPC cannot inject another transport endpoint.
  const rejected = await shell.evaluate(async () => {
    try {
      await window.tamki.library("recognition-source-models", {
        source: { endpoint: "https://other.test" },
      });
      return false;
    } catch {
      return true;
    }
  });
  assert(rejected);
  await dialog
    .getByRole("button", { name: "Load models", exact: true })
    .click();
  await dialog.getByRole("combobox", { name: "Model", exact: true }).click();
  await shell
    .getByRole("option", { name: "Fixture text model", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await shell
    .getByRole("region", { name: "Source settings", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await shell
    .getByRole("combobox", { name: "Filename parser", exact: true })
    .scrollIntoViewIfNeeded();
  await shell.screenshot({ path: "test-results/settings-recognition.png" });
}
