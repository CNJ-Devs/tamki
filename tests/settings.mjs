import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
export async function checkSettings(app, shell, base, profile) {
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
  await shell.getByRole("button", { name: "Add source", exact: true }).click();
  dialog = shell.getByRole("dialog");
  await dialog.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  const initialBounds = await dialog.boundingBox();
  await dialog
    .getByRole("combobox", { name: "Source type", exact: true })
    .click();
  await shell
    .getByRole("option", { name: "OpenAI Compatible", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("Fixture source");
  await dialog.getByLabel("Service URL", { exact: true }).fill(base + "/v1");
  await dialog
    .getByLabel("API Key", { exact: true })
    .fill("tamki-model-secret-fixture");
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
  await shell.getByRole("button", { name: "Edit source", exact: true }).click();
  assert.equal(
    await dialog.getByLabel("API Key", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await dialog
      .getByLabel("API Key", { exact: true })
      .getAttribute("placeholder"),
    "Configured",
  );
  // A changed endpoint cannot inherit the old credential, even through direct IPC.
  const leaked = await shell.evaluate(
    async (s) => {
      try {
        await window.tamki.library("source-models", {
          source: { ...s, endpoint: s.endpoint + "/other" },
        });
        return true;
      } catch (e) {
        return e.message;
      }
    },
    (({ hasKey, hasSearchKey, models, ...s }) => s)(
      settings.recognition.sources[0],
    ),
  );
  assert.equal(leaked, "keyRequired");
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
    .getByRole("combobox", { name: "Filename parser", exact: true })
    .scrollIntoViewIfNeeded();
  await shell.screenshot({ path: "test-results/settings-recognition.png" });
}
