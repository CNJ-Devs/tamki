import test from "node:test";
import assert from "node:assert/strict";
import { CaptureQualities } from "../src/capture/qualities";
import type { CaptureResource } from "../src/shared/capture";
const resources: CaptureResource[] = Array.from({ length: 5 }, (_, i) => ({
  id: String(i + 1),
  provider: "bilibili",
  title: "Episode",
  aid: i + 1,
  bvid: `BV${String(i + 1).padStart(10, "0")}`,
  cid: i + 1,
  duration: 30,
}));
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test("quality inspection bounds concurrency, caches only availability, and supports explicit refresh", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const checker = new CaptureQualities(
    resources,
    async (r) => {
      calls++;
      peak = Math.max(peak, ++active);
      await new Promise((done) => setTimeout(done, 10));
      active--;
      return {
        kind: "dash",
        duration: 30,
        streams: [{ url: "https://signed.example.org/secret", key: "track" }],
        qualities:
          r.aid === 2
            ? [{ id: 80, label: "1080P" }]
            : [
                { id: 112, label: "1080P+" },
                { id: 80, label: "1080P" },
              ],
      };
    },
    () => {},
  );
  checker.request(resources.map((r) => r.id));
  await until(() => !checker.checking);
  assert.equal(peak, 2);
  assert.equal(calls, 5);
  assert.deepEqual(
    checker.items["2"].qualities?.map((q) => q.id),
    [80],
  );
  assert(!JSON.stringify(checker.items).includes("secret"));
  checker.request(resources.map((r) => r.id));
  await until(() => !checker.checking);
  assert.equal(calls, 5);
  checker.request(["2"], false, true);
  await until(() => !checker.checking);
  assert.equal(calls, 6);
  checker.close();
});
test("quality inspection stops the queue on rate limits and aborts on close", async () => {
  let calls = 0;
  const limited = new CaptureQualities(
    resources,
    async () => {
      calls++;
      throw new Error("captureRateLimited");
    },
    () => {},
  );
  limited.request(resources.slice(0, 2).map((r) => r.id));
  await until(() => !limited.checking);
  assert(calls <= 2);
  const before = calls;
  limited.request(resources.map((r) => r.id));
  assert.equal(calls, before);
  assert.equal(Object.keys(limited.items).length, 5);
  limited.close();
  let aborted = false;
  const pending = new CaptureQualities(
    resources,
    (_r, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    () => {},
  );
  pending.request(["1"]);
  pending.close();
  await until(() => !pending.checking);
  assert(aborted);
  assert.deepEqual(pending.items, {});
});
