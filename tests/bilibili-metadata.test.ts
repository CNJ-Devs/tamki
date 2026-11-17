import test from "node:test";
import assert from "node:assert/strict";
import { bilibiliRecognition } from "../src/providers/bilibili-metadata";
import {
  recognitionRequestSchema,
  type RecognitionInput,
} from "../src/shared/recognition";

const input: RecognitionInput = {
  title: "Example",
  scope: "work",
  files: [
    { id: "file-a", filename: "Example.E01.mkv", duration: null, order: 1 },
    { id: "file-b", filename: "unknown.mkv", duration: null, order: 2 },
  ],
};
const season = {
  season_id: 7,
  title: "Example",
  evaluate: "Public synopsis",
  cover: "//i0.hdslb.com/cover.jpg",
  styles: ["Drama"],
  episodes: [
    { id: 10, title: "1", long_title: "First episode" },
    { id: 11, title: "2", long_title: "Second episode" },
  ],
};
const signal = () => new AbortController().signal;
const fixture = (fn: (url: URL, init: RequestInit) => unknown) =>
  (async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.bilibili.com");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    const value = fn(parsed, init!);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;

test("Bilibili searches public anime and film catalogues with only an ephemeral guest cookie, deduplicating exact season IDs", async () => {
  let calls = 0;
  const response = await bilibiliRecognition(
    input,
    undefined,
    "release",
    signal(),
    fixture((url, init) => {
      calls++;
      if (url.pathname === "/x/frontend/finger/spi") {
        assert.equal(new Headers(init.headers).has("Cookie"), false);
        return { code: 0, data: { b_3: "anonymous-visitor" } };
      }
      assert.equal(
        new Headers(init.headers).get("Cookie"),
        "buvid3=anonymous-visitor",
      );
      assert.equal(url.searchParams.get("keyword"), input.title);
      assert(
        ["media_bangumi", "media_ft"].includes(
          url.searchParams.get("search_type")!,
        ),
      );
      return {
        code: 0,
        data: {
          result: [
            {
              season_id: 7,
              title: '<em class="keyword">Example</em> &amp; Friends',
              org_title: "Example",
              pubtime: 1,
            },
          ],
        },
      };
    }),
  );
  assert.equal(calls, 3);
  assert.equal(response.kind, "candidates");
  if (response.kind === "candidates") {
    assert.equal(response.candidates.length, 1);
    assert.equal(response.candidates[0].id, "bilibili:season:7");
    assert.equal(response.candidates[0].title, "Example & Friends");
    assert(response.candidates[0].aliases?.includes("Example"));
  }
});

test("official selected season returns artwork, synopsis and exact episode matches, never ordinal guesses", async () => {
  const request = fixture((url, init) => {
    assert.equal(url.pathname, "/pgc/view/web/season");
    assert.equal(url.searchParams.get("season_id"), "7");
    assert.equal(new Headers(init.headers).has("Cookie"), false);
    return { code: 0, result: season };
  });
  const response = await bilibiliRecognition(
    input,
    "bilibili:season:7",
    "release",
    signal(),
    request,
  );
  assert.equal(response.kind, "result");
  if (response.kind !== "result") return;
  assert.equal(response.result.work?.cover, "https://i0.hdslb.com/cover.jpg");
  assert.equal(response.result.work?.description, season.evaluate);
  assert.deepEqual(response.result.files, [
    { id: "file-a", number: "1", title: "First episode", description: null },
  ]);
  assert.equal(
    response.citations[0].url,
    "https://www.bilibili.com/bangumi/play/ss7",
  );
  const file = await bilibiliRecognition(
    { ...input, scope: "file", files: input.files.slice(0, 1) },
    "bilibili:season:7",
    "release",
    signal(),
    request,
  );
  assert.equal(file.kind === "result" && file.result.work, null);
});

test("public season/episode/media page locators use fixed API endpoints without forwarding URL queries", async () => {
  for (const locator of [
    "https://www.bilibili.com/bangumi/play/ss7?token=ignored",
    "https://www.bilibili.com/bangumi/play/ep10",
    "https://www.bilibili.com/bangumi/media/md20",
  ]) {
    const response = await bilibiliRecognition(
      { ...input, title: locator },
      undefined,
      "release",
      signal(),
      fixture((url) => {
        assert.equal(url.searchParams.has("token"), false);
        if (url.pathname === "/pgc/review/user")
          return { code: 0, result: { media: { season_id: 7 } } };
        assert.equal(url.pathname, "/pgc/view/web/season");
        return { code: 0, result: season };
      }),
    );
    assert.equal(response.kind, "result");
  }
});

test("duplicate remote numbers remain unmatched and untrusted artwork is discarded", async () => {
  const response = await bilibiliRecognition(
    input,
    "bilibili:season:7",
    "release",
    signal(),
    fixture(() => ({
      code: 0,
      result: {
        ...season,
        cover: "https://i0.hdslb.com.evil.test/private",
        episodes: [season.episodes[0], { ...season.episodes[1], title: "1" }],
      },
    })),
  );
  assert.equal(response.kind, "result");
  if (response.kind !== "result") return;
  assert.equal(response.result.work?.cover, null);
  assert.deepEqual(response.result.files, []);
});

test("Bilibili risk-control responses are surfaced rather than retried or treated as no match", async () => {
  for (const failure of [
    new Response("limited", { status: 412 }),
    { code: -352 },
    { code: -412 },
  ])
    await assert.rejects(
      bilibiliRecognition(
        input,
        undefined,
        "release",
        signal(),
        fixture(() => failure),
      ),
      /sourceRateLimited/,
    );
  await assert.rejects(
    bilibiliRecognition(
      input,
      "tmdb:tv:1",
      "release",
      signal(),
      fixture(() => {
        throw Error("must not fetch");
      }),
    ),
    /invalidInput/,
  );
  await assert.rejects(
    bilibiliRecognition(
      input,
      "bilibili:season:8",
      "release",
      signal(),
      fixture(() => ({ code: 0, result: season })),
    ),
    /recognitionInvalid/,
  );
  assert.equal(
    recognitionRequestSchema.shape.candidate.safeParse("bilibili:season:7")
      .success,
    true,
  );
});
