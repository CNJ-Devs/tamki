import test from "node:test";
import assert from "node:assert/strict";
import { Slots } from "../src/capture/slots";

test("stage slots enforce the limit, release once, and remove cancelled waiters", async () => {
  const slots = new Slots(() => 2);
  const signal = new AbortController().signal;
  const first = await slots.acquire(signal);
  const second = await slots.acquire(signal);
  const cancelled = new AbortController();
  const waiting = slots.acquire(cancelled.signal);
  const rejection = assert.rejects(waiting);
  cancelled.abort();
  await rejection;
  let entered = false;
  const next = slots.acquire(signal).then((release) => {
    entered = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(entered, false);
  first();
  first();
  const release = await next;
  release();
  second();
  const a = await slots.acquire(signal),
    b = await slots.acquire(signal);
  a();
  b();
});
