import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LibraryStore } from "../src/library/store";
import { LocalProvider } from "../src/providers/local";
import { scanRoot } from "../src/library/scan";
import type { Entry } from "../src/shared/model";
import { progress } from "../src/shared/model";
import { parseRange } from "../src/library/range";
import { seekBoundary } from "../src/shared/seek-boundary";
import { ZSpaceProvider } from "../src/providers/zspace";
import { editSchema, progressSchema } from "../src/shared/validation";
const root = "/media";
const file = (p: string): Entry => ({
  path: p,
  name: path.basename(p),
  size: 100,
  modified: 10,
  directory: false,
});
const group = {
  path: root + "/Show",
  name: "Show",
  files: [file(root + "/Show/1.webm"), file(root + "/Show/2.webm")],
};
const scan = {
  groups: [group],
  completeDirectories: [root, group.path],
  failures: [],
};
function store() {
  const s = new LibraryStore(":memory:");
  s.saveConnection({
    id: "local",
    type: "local",
    name: "Local",
    roots: [root],
    status: "connected",
    error: null,
    scannedAt: null,
  });
  return s;
}
test("bounded scanner ignores empty media, nested folders, symlinks and non-video files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tamki-scan-"));
  try {
    const media = path.join(temporary, "media");
    await mkdir(path.join(media, "Show/deep"), { recursive: true });
    await mkdir(path.join(media, "Empty"));
    for (const p of [
      "standalone.webm",
      "Show/2.webm",
      "Show/10.webm",
      "Show/deep/hidden.webm",
      "note.txt",
    ])
      await writeFile(path.join(media, p), "video");
    await writeFile(path.join(media, "zero.mp4"), "");
    await writeFile(path.join(temporary, "outside.webm"), "outside");
    await symlink(
      path.join(temporary, "outside.webm"),
      path.join(media, "escape.webm"),
    );
    const provider = new LocalProvider([await realpath(media)]);
    const result = await scanRoot(provider, media);
    assert.deepEqual(
      result.groups.map((g) => g.name),
      ["Show", "standalone"],
    );
    assert.deepEqual(
      result.groups[0].files.map((f) => f.name),
      ["2.webm", "10.webm"],
    );
    assert(!result.groups.some((g) => g.path.includes("deep")));
    await assert.rejects(
      provider.resolve(path.join(media, "escape.webm")),
      /outsideRoot/,
    );
    await assert.rejects(provider.list(temporary), /outsideRoot/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test("refresh preserves manual titles, arbitrary episode numbers, order and playback", () => {
  const s = store();
  try {
    s.applyScan("local", root, scan);
    const original = s.snapshot().works[0];
    s.setProgress(original.episodes[0].id, 25, 100, true);
    s.setProgress(original.episodes[0].id, 0, 100, false);
    assert.equal(
      s.episode(original.episodes[0].id).position,
      25,
      "thumbnail probes cannot reset playback",
    );
    s.setProgress(original.episodes[1].id, 0, 200, false);
    s.edit({
      id: original.id,
      title: "My series",
      description: "Edited",
      tags: ["Comedy"],
      removedEpisodeIds: [],
      episodes: [...original.episodes].reverse().map((e, i) => ({
        id: e.id,
        number: i ? "2026-11-13" : "Special",
        title: "Custom",
        description: "",
      })),
    });
    s.applyScan("local", root, scan);
    const updated = s.snapshot().works[0];
    assert.equal(updated.title, "My series");
    assert.equal(updated.episodes[0].id, original.episodes[1].id);
    assert.equal(updated.episodes[1].number, "2026-11-13");
    assert.equal(updated.episodes[1].position, 25);
    assert.equal(progress(updated), 225 / 300);
  } finally {
    s.close();
  }
});
test("exclusions survive scans; explicit manual re-add restores the original identity", () => {
  const s = store();
  try {
    s.applyScan("local", root, scan);
    const w = s.snapshot().works[0];
    s.removeWork(w.id);
    s.applyScan("local", root, scan);
    assert.equal(s.snapshot().works.length, 0);
    s.applyScan(
      "local",
      root,
      {
        groups: [
          { path: group.files[0].path, name: "1", files: [group.files[0]] },
        ],
        completeDirectories: [],
        failures: [],
      },
      true,
    );
    assert.equal(s.snapshot().works[0].id, w.id);
    s.edit({
      id: w.id,
      title: w.title,
      description: "",
      tags: [],
      episodes: [{ ...w.episodes[0] }],
      removedEpisodeIds: [w.episodes[1].id],
    });
    s.applyScan("local", root, scan);
    assert.equal(s.snapshot().works[0].episodes.length, 1);
  } finally {
    s.close();
  }
});
test("partial failure retains cached items; confirmed absence marks them unavailable", () => {
  const s = store();
  try {
    s.applyScan("local", root, scan);
    s.applyScan("local", root, {
      groups: [],
      completeDirectories: [root],
      failures: [group.path],
    });
    assert(s.snapshot().works[0].episodes.every((e) => !e.missing));
    s.applyScan("local", root, {
      groups: [],
      completeDirectories: [root, group.path],
      failures: [],
    });
    assert(s.snapshot().works[0].episodes.every((e) => e.missing));
  } finally {
    s.close();
  }
});
test("invalid edit cannot move unrelated episode IDs or partially change metadata", () => {
  const s = store();
  try {
    s.applyScan("local", root, scan);
    const w = s.snapshot().works[0];
    assert.throws(
      () =>
        s.edit({
          id: w.id,
          title: "Changed",
          description: "",
          tags: [],
          removedEpisodeIds: [],
          episodes: [{ id: "other", number: "", title: "", description: "" }],
        }),
      /invalidInput/,
    );
    assert.equal(s.snapshot().works[0].title, "Show");
    assert.equal(
      progressSchema.safeParse({ id: "x", position: Infinity, duration: 20 })
        .success,
      false,
    );
    assert.equal(
      editSchema.safeParse({
        id: w.id,
        title: "",
        description: "",
        tags: [],
        removedEpisodeIds: [],
        episodes: [],
      }).success,
      false,
    );
  } finally {
    s.close();
  }
});
test("index, preferences, exclusions and collection membership survive restart", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tamki-index-"));
  const database = path.join(temporary, "library.sqlite");
  let s = new LibraryStore(database);
  try {
    s.applyScan("local", root, scan);
    const w = s.snapshot().works[0];
    s.setProgress(w.episodes[1].id, 19, 30, true);
    s.saveCollection({ name: "Favorites", workIds: [w.id] });
    s.setPreferences({
      language: "zh",
      palette: "iris",
      mode: "dark",
      refreshOnOpen: false,
    });
    s.close();
    s = new LibraryStore(database);
    assert.equal(s.snapshot().works[0].episodes[1].position, 19);
    assert.deepEqual(s.snapshot().collections[0].workIds, [w.id]);
    assert.equal(s.preferences().palette, "iris");
    s.removeWork(w.id);
    s.close();
    s = new LibraryStore(database);
    s.applyScan("local", root, scan);
    assert.equal(s.snapshot().works.length, 0);
  } finally {
    s.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
test("HTTP byte ranges preserve correct inclusive endpoints and reject malformed ranges", () => {
  assert.deepEqual(parseRange("bytes=5-9", 100), {
    start: 5,
    end: 9,
    partial: true,
  });
  assert.deepEqual(parseRange("bytes=-10", 100), {
    start: 90,
    end: 99,
    partial: true,
  });
  assert.deepEqual(parseRange("bytes=90-200", 100), {
    start: 90,
    end: 99,
    partial: true,
  });
  for (const header of [
    "bytes=100-",
    "bytes=5-4",
    "bytes=-0",
    "bytes=-",
    "bytes=1-3,5-8",
    "bytes=9007199254740992-",
  ])
    assert.equal(parseRange(header, 100), null);
});
test("seek bounds tolerate 20 ms without disabling 1 second early", () => {
  assert.equal(seekBoundary(0.01, 120).atStart, true);
  assert.equal(seekBoundary(0.1, 120).atStart, false);
  assert.equal(seekBoundary(119.99, 120).atEnd, true);
  assert.equal(seekBoundary(119, 120).atEnd, false);
  assert.equal(seekBoundary(120, 120).atEnd, true);
});
test("ZSpace reads all pages using numeric totals and rejects inconsistent listings", async () => {
  const calls: unknown[] = [];
  const provider = new ZSpaceProvider(
    async (args) => {
      const p = JSON.parse(args.at(-1)!);
      calls.push(p);
      return {
        total: "3",
        list: Array.from({ length: p.start === 0 ? 2 : 1 }, (_, i) => ({
          path: `/pool/my/data/${p.start + i}.mp4`,
          name: `${p.start + i}.mp4`,
          is_dir: "0",
          size: "100",
          modify_time: "123",
        })),
      };
    },
    ["/pool/my/data"],
  );
  assert.equal((await provider.list("/pool/my/data")).length, 3);
  assert.equal((calls[1] as { start: number }).start, 2);
  await assert.rejects(provider.list("/pool/my/other"), /outsideRoot/);
  const broken = new ZSpaceProvider(
    async () => ({ total: "3", list: [] }),
    ["/pool/my/data"],
  );
  await assert.rejects(broken.list("/pool/my/data"), /invalidListing/);
});
test("ZSpace rejects changed lengths and wrong offsets when reading media", async () => {
  const read = {
    path: "/pool/movie.mp4",
    offset: 0,
    size: 4,
    bytes: 4,
    next_offset: 4,
    encoding: "base64",
    content: Buffer.from("test").toString("base64"),
  };
  const provider = new ZSpaceProvider(async () => read, ["/pool"]);
  assert.equal(
    Buffer.from(await provider.read("/pool/movie.mp4", 0, 4, 4)).toString(),
    "test",
  );
  await assert.rejects(
    provider.read("/pool/movie.mp4", 1, 4, 4),
    /mediaChanged/,
  );
});

test("official-tool authorization uses stdin, parses multiline completion, and can be cancelled", async () => {
  const { chmod } = await import("node:fs/promises");
  const { ZSpaceCLI } = await import("../src/providers/zspace");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tamki-oauth-"));
  const executable = path.join(temporary, "fixture-cli.mjs");
  const source = `#!/usr/bin/env node
    if(process.argv.includes('login')) {
      console.log(JSON.stringify({event:'oauth_authorization',url:'https://oauth.zconnect.cn/wbui/authorize?state=local-fixture',expires_in:180}));
      process.stdin.once('data', chunk => {
        if(process.argv.includes(chunk.toString().trim())) process.exit(3);
        console.log(JSON.stringify({ok:true,data:{backend:'keyring'}}, null, 2)); process.exit(0);
      });
    } else { console.log(JSON.stringify({ok:true,data:{personal_spaces:[]}},null,2)); }
  `;
  await writeFile(executable, source);
  await chmod(executable, 0o700);
  const cli = new ZSpaceCLI(executable, path.join(temporary, "profile"));
  try {
    const login = await cli.begin("fixture-one");
    assert.equal(new URL(login.url).origin, "https://oauth.zconnect.cn");
    await cli.finish("fixture-one", "LOCAL-FIXTURE-CODE");
    assert.deepEqual(
      await ZSpaceProvider.spaces(cli.runner("fixture-one")),
      [],
    );
    await cli.begin("fixture-two");
    cli.cancel("fixture-two");
    await assert.rejects(
      cli.finish("fixture-two", "LOCAL-FIXTURE-CODE"),
      /authExpired/,
    );
  } finally {
    cli.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("saving an open editor preserves new episodes discovered by a background scan", () => {
  const s = store();
  try {
    s.applyScan("local", root, scan);
    const before = s.snapshot().works[0];
    s.applyScan("local", root, {
      ...scan,
      groups: [
        { ...group, files: [...group.files, file(root + "/Show/3.webm")] },
      ],
    });
    s.edit({
      id: before.id,
      title: "Updated",
      description: "",
      tags: [],
      episodes: before.episodes.slice(1),
      removedEpisodeIds: [before.episodes[0].id],
    });
    const after = s.snapshot().works[0];
    assert.deepEqual(
      after.episodes.map((e) => e.fileName),
      ["2.webm", "3.webm"],
    );
    s.applyScan("local", root, scan);
    assert(
      !s
        .snapshot()
        .works[0].episodes.some((e) => e.id === before.episodes[0].id),
    );
  } finally {
    s.close();
  }
});
test("older applications refuse a newer database without downgrading its version", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tamki-version-"));
  const file = path.join(temporary, "library.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version=2");
    db.close();
    assert.throws(() => new LibraryStore(file), /databaseNewer/);
    const read = new DatabaseSync(file, { readOnly: true });
    assert.equal(read.prepare("PRAGMA user_version").get()!.user_version, 2);
    read.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("cross-storage episode drafts are atomic, deduplicated and preserve source ownership", () => {
  const s = store();
  try {
    s.applyScan("local", root, scan);
    const work = s.snapshot().works[0];
    const extra = file("/second/hidden/Bonus.webm");
    s.saveConnection({
      id: "second",
      name: "Second",
      type: "local",
      roots: ["/second"],
      status: "connected",
      error: null,
      scannedAt: null,
    });
    const prepared = s.prepareEpisodes(work.id, "second", [extra]);
    assert.equal(
      s.snapshot().works[0].episodes.length,
      2,
      "selection is a draft",
    );
    const edit = {
      id: work.id,
      title: work.title,
      description: "",
      tags: [],
      removedEpisodeIds: [],
      episodes: [...work.episodes, ...prepared],
    };
    s.edit(edit, prepared);
    const after = s.snapshot().works[0];
    assert.equal(after.episodes.length, 3);
    assert.equal(after.episodes[2].connectionId, "second");
    assert.equal(after.episodes[2].fileName, "Bonus.webm");
    assert.equal(
      s.prepareEpisodes(work.id, "second", [extra])[0].id,
      prepared[0].id,
    );
    s.applyScan("second", "/second", {
      groups: [
        {
          path: "/second/hidden",
          name: "Bonus",
          files: [{ ...extra, modified: 20 }],
        },
      ],
      completeDirectories: ["/second", "/second/hidden"],
      failures: [],
    });
    assert.equal(
      s.snapshot().works.find((w) => w.id === work.id)!.episodes[2].modified,
      20,
    );
    s.removeConnection("second");
    assert(
      s.snapshot().works.find((w) => w.id === work.id)!.episodes[2].missing,
    );
    assert(
      !s.snapshot().works.find((w) => w.id === work.id)!.episodes[0].missing,
    );
  } finally {
    s.close();
  }
});
