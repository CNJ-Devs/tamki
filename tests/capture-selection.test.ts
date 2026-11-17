import test from "node:test";
import assert from "node:assert/strict";
import { downloadChoices, selectDownload } from "../src/capture/selection";
import {
  downloadSubmitSchema,
  type CaptureGroup,
  type CaptureResource,
} from "../src/shared/capture";

const resource = (n: number): CaptureResource => ({
  provider: "bilibili",
  id: `r${n}`,
  title: `Episode ${n}`,
  aid: n,
  bvid: `BV${String(n).padStart(10, "0")}`,
  cid: n,
  duration: 30,
});
const resources = [1, 2, 3, 4].map(resource);
const groups: CaptureGroup[] = [
  {
    id: "work1",
    title: "Work one",
    resources: resources.slice(0, 3),
    sections: [{ id: "extra", title: "Extras", resources: [resources[2]] }],
  },
  { id: "work2", title: "Work two", resources: [resources[3]] },
];
test("download choices preserve work/section hierarchy without repeating episodes", () => {
  const choices = downloadChoices(resources, groups);
  assert.deepEqual(choices[0].resourceIds, ["r1", "r2", "r3"]);
  assert.deepEqual(
    choices[0].children?.map((c) => c.title),
    ["Episode 1", "Episode 2", "Extras"],
  );
  assert.deepEqual(choices[0].children?.[2].children?.[0].resourceIds, ["r3"]);
  assert.equal(downloadChoices(resources).length, 4);
});
test("selection retains source order and original numbering, drops empty works and sections", () => {
  const selection = selectDownload(resources, groups, ["r4", "r2"]);
  assert.deepEqual(
    selection.resources.map((r) => r.id),
    ["r2", "r4"],
  );
  assert.deepEqual(
    selection.groups?.map((g) => g.resources.length),
    [1, 1],
  );
  assert.deepEqual(selection.groups?.[0].sections, []);
  assert.equal(selection.positions.get("r2"), 1);
  assert.equal(selection.positions.get("r4"), 0);
  assert.equal(selectDownload(resources, groups, ["r2"]).groups?.length, 1);
  assert.equal(selectDownload(resources, groups).resources.length, 4);
});
test("empty, duplicate and forged selection IDs cannot select or enqueue other page resources", () => {
  for (const ids of [[], ["r1", "unknown"], ["r1", "r1"]])
    assert.throws(
      () => selectDownload(resources, groups, ids),
      /captureChanged/,
    );
  const input = {
    draftId: "123e4567-e89b-42d3-a456-426614174000",
    name: "Work",
    target: { connectionId: "local", path: "/media" },
  };
  assert(downloadSubmitSchema.safeParse(input).success);
  assert(
    !downloadSubmitSchema.safeParse({ ...input, resourceIds: [] }).success,
  );
  assert(
    !downloadSubmitSchema.safeParse({ ...input, resourceIds: ["r1", "r1"] })
      .success,
  );
});
