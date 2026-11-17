import { writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

export async function checkConnections(app, shell, temporary) {
  const script = path.join(temporary, "zspace-cli-fixture.mjs");
  const cli =
    process.platform === "win32"
      ? path.join(temporary, "zspace-cli-fixture.exe")
      : script;
  await writeFile(
    script,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const reply = data => console.log(JSON.stringify({ok:true,data}));
if (args.includes('login')) {
  console.log(JSON.stringify({event:'oauth_authorization',url:'https://oauth.zconnect.cn/wbui/authorize?state=fixture'}));
  process.stdin.once('data', () => { reply({backend:'keyring'}); process.exit(0); });
} else if (args.includes('space')) {
  reply({personal_spaces:[{path:'/Drive1',readable:true},{path:'/Drive2',readable:true}]});
} else if (args.includes('list')) {
  const {path:p} = JSON.parse(args[args.indexOf('--params')+1]);
  if(p==='/Drive2') { console.log(JSON.stringify({ok:false,error:{code:'E_NETWORK'}})); process.exit(1); }
  const children = {'/Drive1':['Media','Archive'],'/Drive1/Media':['Series']};
  const list = (children[p]||[]).map(name=>({path:p+'/'+name,name,is_dir:'1',size:'0',modify_time:'1'}));
  reply({list,total:String(list.length)});
}
`,
  );
  await chmod(script, 0o700);
  if (process.platform === "win32") {
    const msys = path.resolve(
      path.dirname(process.env.TAMKI_MSYS2_BASH),
      "../..",
    );
    const compiler = path.join(msys, "ucrt64/bin/gcc.exe");
    execFileSync(
      compiler,
      ["-municode", "-static", "tests/fixtures/cli-launcher.c", "-o", cli],
      {
        env: {
          ...process.env,
          PATH:
            path.join(msys, "ucrt64/bin") + path.delimiter + process.env.PATH,
        },
        stdio: "inherit",
      },
    );
    await app.evaluate((_electron, node) => {
      process.env.TAMKI_FIXTURE_NODE = node;
    }, process.execPath);
  }
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, cli);
  await shell.evaluate(() => window.tamki.library("choose-cli"));
  await shell
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await shell.getByRole("button", { name: "ZSpace NAS", exact: true }).click();
  await shell
    .getByLabel("Authorization code", { exact: true })
    .fill("TEST-CODE-1234");
  await shell.getByRole("button", { name: "Connect", exact: true }).click();
  const dialog = shell.getByRole("dialog");
  await dialog.getByRole("button", { name: "/Drive1", exact: true }).click();
  // This fails when auth -> folders triggers the draft's effect cleanup.
  await dialog.getByRole("button", { name: "Media", exact: true }).click();
  await dialog.getByRole("button", { name: "Series", exact: true }).waitFor();
  await dialog
    .getByRole("checkbox", { name: "Choose folder", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("Fixture NAS");
  await dialog
    .getByRole("combobox", { name: "Scan depth · /Drive1/Media", exact: true })
    .click();
  await shell.getByRole("option", { name: "Custom", exact: true }).click();
  await dialog
    .getByRole("spinbutton", { name: "Scan depth", exact: true })
    .fill("7");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await shell
    .locator(".connection-row")
    .filter({ hasText: "Fixture NAS" })
    .waitFor();
  await shell.waitForFunction(async () => {
    const s = await window.tamki.library("state");
    return !s.refreshing && s.connections.some((c) => c.name === "Fixture NAS");
  });
  const connection = await shell.evaluate(async () =>
    (await window.tamki.library("state")).connections.find(
      (c) => c.name === "Fixture NAS",
    ),
  );
  assert.deepEqual(connection.roots, ["/Drive1/Media"]);
  assert.equal(connection.scanDepths["/Drive1/Media"], 7);
  await shell
    .locator(".connection-row")
    .filter({ hasText: "Fixture NAS" })
    .getByRole("button", { name: "Edit connection", exact: true })
    .click();
  await dialog.getByRole("button", { name: "/Drive1", exact: true }).click();
  await dialog.getByRole("button", { name: "Archive", exact: true }).waitFor();
  assert.equal(
    await dialog
      .getByRole("spinbutton", { name: "Scan depth", exact: true })
      .inputValue(),
    "7",
  );
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: "/Drive2", exact: true }).click();
  await dialog
    .getByText("Could not connect. Check the connection and authorization.", {
      exact: true,
    })
    .first()
    .waitFor();
  assert.equal(
    await dialog.getByText("No folders", { exact: true }).count(),
    0,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await shell.evaluate(
    (id) => window.tamki.library("remove-connection", id),
    connection.id,
  );
}
