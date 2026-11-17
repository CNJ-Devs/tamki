import { setTimeout } from "node:timers/promises";

// Playwright's in-page waitForFunction treats a Promise as truthy. Poll IPC
// predicates from Node so each evaluation is awaited before checking its value.
export async function waitForAsync(page, predicate, arg, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await page.evaluate(predicate, arg)) return;
    await setTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out awaiting asynchronous predicate: ${predicate}`);
}
