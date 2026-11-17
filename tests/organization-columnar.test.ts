import test from "node:test";
import assert from "node:assert/strict";
import {
  columnarOrganizationTask,
  columnarOrganizationSchema,
  decodeColumnarOrganization,
  OrganizationColumnarError,
} from "../src/library/organization-columnar";
import { OrganizationInput } from "../src/library/organization-input";
import { OrganizationOutputError } from "../src/library/organization-output";

function fixture() {
  const files = Array.from({ length: 8 }, (_, index) => ({
    id: `file-${index + 1}`,
    connectionId: "storage",
    root: "/media",
    path: `/media/video-${index + 1}.mkv`,
    relativePath: `video-${index + 1}.mkv`,
    name: `video-${index + 1}.mkv`,
    size: 100,
    modified: 1,
    duration: null,
  }));
  const input = new OrganizationInput(
    files,
    [],
    {
      works: [
        {
          id: "existing",
          title: "Existing work",
          description: "",
          tags: [],
          hasCover: false,
          manualFields: [],
          recognized: false,
          outsideFiles: 0,
          files: [
            {
              id: "file-7",
              number: "special",
              title: "Keep this title",
              description: "",
              manual: false,
              manualFields: [],
            },
          ],
        },
      ],
      collections: [],
    },
    [{ connectionId: "storage", path: "/media", depth: 1 }],
  );
  const proposal = {
    g: [
      {
        i: "series",
        t: "A series",
        f: ["f1", "f2", "f3", "f4", "f5", "f6", "f7"],
        r: [
          { l: "Original", k: "" },
          { l: "Alternative", k: "release-b" },
        ],
        e: {
          n: ["1", ""],
          t: ["First title", ""],
          v: [
            { r: 0, f: [["f1", "f2"], null] },
            { r: 1, f: ["f3", "f4"] },
            { r: 0, f: [null, "f5"] },
            { r: 0, f: [null, "f6"] },
          ] as { r: number; f: (string | string[] | null)[] }[],
        },
        q: false,
        m: "",
      },
      {
        i: "film",
        t: "A related film",
        f: ["f8"],
        r: [],
        e: { n: [], t: [], v: [] },
        q: false,
        m: "",
      },
    ],
    u: [] as string[],
    c: [{ n: "Related works", g: ["series", "film"] }],
  };
  return { input, proposal };
}

test("columnar task changes the output wire contract without changing input or preferences", () => {
  const { input } = fixture();
  const original = input.directTask("Preserve my choices", "en");
  const saved = structuredClone(original);
  const task = columnarOrganizationTask(original);
  assert.deepEqual(original, saved);
  assert.equal(
    task.prompt.split("\nOUTPUT CONTRACT:\n")[0],
    original.prompt.split("\nOUTPUT CONTRACT:\n")[0],
  );
  assert.deepEqual(task.schema, columnarOrganizationSchema);
  assert.deepEqual(
    JSON.parse(task.prompt.split("\nOUTPUT CONTRACT:\n")[1]),
    task.schema,
  );
  assert.equal(task.reasoningEffort, "medium");
  assert.equal(task.searchPolicy, original.searchPolicy);
  assert.deepEqual(task.queries, original.queries);
  assert.match(task.system, /Columnar output dictionary/);
  assert.doesNotMatch(task.system, /Use groups\.episodes/);
  assert.match(task.system, /Correct unsuitable automatic metadata/);
  assert.throws(() => columnarOrganizationTask(task), /TaskContract/);
});

test("columns preserve copies, absent versions, order and distinct versions with identical labels", () => {
  const { input, proposal } = fixture();
  const canonical = JSON.parse(
    decodeColumnarOrganization(JSON.stringify(proposal)),
  );
  assert.deepEqual(canonical.groups[0].episodes, [
    {
      number: "1",
      title: "First title",
      versions: [
        { label: "Original", releaseKey: "", fileIds: ["f1", "f2"] },
        { label: "Alternative", releaseKey: "release-b", fileIds: ["f3"] },
      ],
    },
    {
      number: "",
      title: "",
      versions: [
        { label: "Alternative", releaseKey: "release-b", fileIds: ["f4"] },
        { label: "Original", releaseKey: "", fileIds: ["f5"] },
        { label: "Original", releaseKey: "", fileIds: ["f6"] },
      ],
    },
  ]);
  assert.deepEqual(canonical.groups[1].episodes, []);
  const final = input.stabilize(input.decode(JSON.stringify(canonical)));
  const episodes = final.groups[0].episodes;
  assert.ok(episodes);
  assert.equal(episodes.length, 3);
  assert.deepEqual(episodes[2], {
    number: "special",
    title: "Keep this title",
    versions: [{ label: "", releaseKey: "", fileIds: ["file-7"] }],
  });
  assert.equal(episodes[1].number, "");
  assert.equal(episodes[1].title, "");
  assert.equal(episodes[1].versions.length, 3);
});

test("columnar decoder rejects malformed tables without filling or truncating cells", () => {
  const mutations: ((value: ReturnType<typeof fixture>["proposal"]) => void)[] =
    [
      (v) => {
        v.g[0].e.t.pop();
      },
      (v) => {
        v.g[0].e.v[0].f.pop();
      },
      (v) => {
        v.g[0].e.v[0].f.push("f8");
      },
      (v) => {
        v.g[0].e.v[0].r = 2;
      },
      (v) => {
        v.g[0].e.v[0].r = -1;
      },
      (v) => {
        v.g[0].e.v[0].r = 0.5;
      },
      (v) => {
        v.g[0].e.v[0].f = [null, null];
      },
      (v) => {
        v.g[0].e.v.forEach((c) => {
          c.f[1] = null;
        });
      },
      (v) => {
        v.g[0].e.v[0].f[0] = ["f1"];
      },
      (v) => {
        v.g[0].e.v[0].f[0] = [];
      },
      (v) => {
        v.g[0].e.v[0].f[0] = "d1";
      },
      (v) => {
        v.g[0].e.v[0].f[0] = "f1-f2";
      },
      (v) => {
        v.g[0].e.v[0].f[0] = "f01";
      },
      (v) => {
        Object.assign(v.g[0].e, { extra: "ignored?" });
      },
      (v) => {
        Object.assign(v.g[0].e.v[0], { r: "0" });
      },
    ];
  for (const mutate of mutations) {
    const { proposal } = fixture();
    mutate(proposal);
    assert.throws(
      () => decodeColumnarOrganization(JSON.stringify(proposal)),
      OrganizationColumnarError,
    );
  }
  assert.throws(
    () => decodeColumnarOrganization("{"),
    OrganizationColumnarError,
  );
});

test("decoded proposals still require canonical coverage and reference validation", () => {
  const mutations: ((value: ReturnType<typeof fixture>["proposal"]) => void)[] =
    [
      (v) => {
        v.g.pop();
        v.c = [];
      },
      (v) => {
        v.g[1].f.push("f1");
      },
      (v) => {
        v.g[0].e.v[0].f[0] = "f999";
      },
      (v) => {
        v.c[0].g[0] = "unknown";
      },
      (v) => {
        v.c[0].g[1] = "series";
      },
    ];
  for (const mutate of mutations) {
    const { input, proposal } = fixture();
    mutate(proposal);
    assert.throws(
      () => input.decode(decodeColumnarOrganization(JSON.stringify(proposal))),
      OrganizationOutputError,
    );
  }
});
