import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { capturePageContextScript } from "../src/capture/page-context";
const read = (payload: unknown, initial?: unknown) =>
  JSON.parse(
    JSON.stringify(
      runInNewContext(capturePageContextScript, {
        document: {
          getElementById: () => ({ textContent: JSON.stringify(payload) }),
        },
        __INITIAL_STATE__: initial,
      }),
    ),
  );
test("page context returns only public, valid player identifiers from current PGC page metadata", () => {
  assert.deepEqual(
    read({
      props: {
        pageProps: {
          dehydratedState: {
            queries: [
              {
                state: {
                  data: {
                    episode_info: { ep_id: 24, cid: 28 },
                    account: { secret: "never-return" },
                  },
                },
              },
            ],
          },
        },
      },
    }),
    { episodeId: 24, cid: 28 },
  );
  assert.deepEqual(
    read({}, { epInfo: { id: 42, cid: 80, token: "never-return" } }),
    { episodeId: 42, cid: 80 },
  );
  assert.deepEqual(
    read({ props: { pageProps: { episode_info: { ep_id: "bad", cid: -1 } } } }),
    {},
  );
  assert.deepEqual(
    read({ account: { ep_id: 100, token: "never-return" } }),
    {},
  );
});
