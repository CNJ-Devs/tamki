import assert from "node:assert/strict";
export async function checkRecognition(app, shell) {
  const state = () => shell.evaluate(() => window.tamki.library("state"));
  const original = (await state()).works.find((w) => w.title === "Series");
  await shell
    .getByRole("button", { name: "Identify work", exact: true })
    .click();
  let dialog = shell.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Recognition source", exact: true })
    .waitFor();
  assert.match(await dialog.innerText(), /Fixture source/);
  await dialog.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  await shell.screenshot({ path: "test-results/recognition-request.png" });
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Apply and save", exact: true })
    .waitFor();
  assert.equal(
    (await state()).works.find((w) => w.id === original.id).description,
    "",
  );
  await dialog.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  const before = await dialog.boundingBox();
  await dialog
    .locator(".recognition-diff-group")
    .first()
    .getByRole("checkbox", { name: "Apply Name", exact: true })
    .click();
  assert.equal(
    Math.round((await dialog.boundingBox()).height),
    Math.round(before.height),
  );
  await shell.waitForTimeout(150);
  await shell.screenshot({ path: "test-results/recognition-diff.png" });
  await dialog
    .getByRole("button", { name: "Apply and save", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  const work = (await state()).works.find((w) => w.id === original.id);
  assert.equal(work.title, "Series");
  assert.equal(work.description, "Verified work synopsis");
  assert.equal(work.episodes[0].title, "Identified episode");
  await shell
    .getByRole("button", { name: "Organize information", exact: true })
    .click();
  await shell.getByRole("tab", { name: "Episodes", exact: true }).click();
  await shell
    .locator(".edit-episode-row")
    .first()
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  // An invalid response is rejected before it can reach the comparison/application phase.
  await shell
    .getByRole("button", { name: "Identify this episode", exact: true })
    .click();
  await dialog
    .getByLabel("Work title", { exact: true })
    .fill("invalid fixture");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await dialog
    .getByText(
      "The result contains mismatched files or information outside this request. Nothing was changed.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Apply and save", exact: true })
      .count(),
    0,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // Cancel a real in-flight request, leave the editor intact, and discard late responses.
  await shell
    .getByRole("button", { name: "Identify this episode", exact: true })
    .click();
  await dialog.getByLabel("Work title", { exact: true }).fill("slow fixture");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await dialog.getByText("Identifying…", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await shell.waitForTimeout(1900);
  assert.equal(await shell.getByRole("dialog").count(), 0);
  assert.equal(
    (await state()).works.find((w) => w.id === work.id).description,
    "Verified work synopsis",
  );
  await shell.getByRole("button", { name: "Back", exact: true }).click();
  await shell.getByRole("tab", { name: "Work", exact: true }).click();
}
