import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtworkCache, artworkURL } from "../src/library/artwork";
import {
  providerArtworkFetch,
  publicArtworkAddress,
  resolveArtworkAddress,
} from "../src/library/artwork-fetch";
import { pageArtwork } from "../src/library/artwork-page";
import {
  recognitionPrompt,
  recognitionOutputSchema,
  metadataChanges,
} from "../src/shared/recognition";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWsAAAAASUVORK5CYII=",
  "base64",
);
test("artwork can come from public sites beyond metadata providers; private and reserved destinations are denied", async () => {
  assert.equal(
    artworkURL("https://studio.example.org/poster.jpg"),
    "https://studio.example.org/poster.jpg",
  );
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::1",
  ])
    assert.equal(publicArtworkAddress(address), false, address);
  for (const address of ["1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(publicArtworkAddress(address), true);
  for (const url of [
    "https://127.1/a",
    "https://2130706433/a",
    "https://[::1]/a",
    "https://host.local/a",
    "http://example.org/a",
    "https://user:secret@example.org/a",
  ])
    assert.throws(() => artworkURL(url));
  await assert.rejects(
    resolveArtworkAddress("example.org", (async () => [
      { address: "10.0.0.1", family: 4 },
    ]) as any),
  );
  await assert.rejects(
    resolveArtworkAddress("example.org", (async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]) as any),
  );
  assert.deepEqual(
    await resolveArtworkAddress("example.org", (async () => [
      { address: "1.1.1.1", family: 4 },
    ]) as any),
    { address: "1.1.1.1", family: 4 },
  );
});
test("page metadata supports relative URLs, entities and structured works without grabbing arbitrary images", () => {
  assert.deepEqual(
    pageArtwork(
      `<img src="/logo.png"><!-- <meta property="og:image" content="/wrong.png"> --><meta content="/poster.jpg?a=1&amp;b=2" property="og:image"><meta name=twitter:image content="https://cdn.example.org/alt.webp">`,
      "https://studio.example.org/work/1",
    ),
    [
      "https://studio.example.org/poster.jpg?a=1&b=2",
      "https://cdn.example.org/alt.webp",
    ],
  );
  assert.deepEqual(
    pageArtwork(
      `<script type="application/ld+json">{"@graph":[{"@type":"Organization","image":"/logo.png"},{"@type":"TVSeries","image":{"url":"/show.png"}}]}</script>`,
      "https://studio.example.org/work",
    ),
    ["https://studio.example.org/show.png"],
  );
  assert.deepEqual(
    pageArtwork(
      '<meta property="og:image" content="http://127.0.0.1/admin"><img src="/x.png">',
      "https://studio.example.org/work",
    ),
    [],
  );
});
test("missing or failed direct cover falls back to the verified page and caches its public image", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tamki-cover-"));
  try {
    const calls: string[] = [];
    const cache = new ArtworkCache(dir, (async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      assert.equal(init?.credentials, "omit");
      if (url.endsWith("/missing")) return new Response("", { status: 404 });
      if (url.endsWith("/work"))
        return new Response(
          '<meta property="og:image" content="https://cdn.example.org/poster.png">',
          { headers: { "Content-Type": "text/html" } },
        );
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch);
    const key = await cache.resolve(
      "https://studio.example.org/missing",
      "https://studio.example.org/work",
      AbortSignal.timeout(1000),
    );
    assert.equal((await cache.read(key)).type, "image/png");
    assert.equal(calls.length, 3);
    assert.equal(
      await cache.resolve(
        null,
        "https://studio.example.org/work",
        AbortSignal.timeout(1000),
      ),
      key,
    );
    assert.equal(calls.length, 4, "the image is reused from disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("page fallback is bounded, cancellable and cannot use HTML as image bytes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tamki-cover-bounds-"));
  try {
    for (const response of [
      () =>
        new Response("x".repeat(2 * 1024 * 1024 + 1), {
          headers: { "Content-Type": "text/html" },
        }),
      () =>
        new Response('<img src="/poster.jpg">', {
          headers: { "Content-Type": "text/html" },
        }),
    ]) {
      const cache = new ArtworkCache(dir, (async () =>
        response()) as typeof fetch);
      await assert.rejects(
        cache.resolve(
          null,
          "https://studio.example.org/work",
          AbortSignal.timeout(1000),
        ),
      );
    }
    const cache = new ArtworkCache(
      dir,
      (async () =>
        new Response("<html>no</html>", {
          headers: { "Content-Type": "image/png" },
        })) as typeof fetch,
    );
    await assert.rejects(
      cache.resolve(
        "https://studio.example.org/image",
        null,
        AbortSignal.timeout(1000),
      ),
    );
    await assert.rejects(
      cache.resolve(
        "https://studio.example.org/image",
        null,
        AbortSignal.abort(),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("AI contract carries verified work pages without restricting artwork domains", () => {
  const prompt = recognitionPrompt(
    { title: "Work", scope: "work", files: [] },
    "Find metadata",
  );
  assert.ok(prompt.includes("coverPage"));
  assert.ok(prompt.includes("any public website"));
  assert.ok(!prompt.includes("on lain.bgm.tv"));
  assert.ok(
    recognitionOutputSchema.safeParse({
      work: {
        title: "Work",
        description: null,
        tags: null,
        cover: null,
        coverPage: "https://studio.example.org/work",
      },
      files: [],
    }).success,
  );
});

test("AMP page share media supplies a poster without selecting inline recommendations", () => {
  assert.deepEqual(
    pageArtwork(
      `<amp-img src="/recommendation.jpg"></amp-img><amp-social-share type="pinterest" data-param-media="/poster.jpg?a=1&amp;b=2"></amp-social-share><amp-social-share type="pinterest" data-param-media="http://127.0.0.1/private"></amp-social-share>`,
      "https://studio.example.org/work",
    ),
    ["https://studio.example.org/poster.jpg?a=1&b=2"],
  );
});

test("official CDN artwork uses the browser network without credentials or redirects", async () => {
  const request = providerArtworkFetch((async (url, init) => {
    assert.equal(
      String(url),
      "https://lain.bgm.tv/pic/cover/l/aa/bb/42_test.jpg",
    );
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual");
    return new Response(png, { headers: { "content-type": "image/png" } });
  }) as typeof fetch);
  assert.equal(
    (await request("https://lain.bgm.tv/pic/cover/l/aa/bb/42_test.jpg")).status,
    200,
  );
  await assert.rejects(
    providerArtworkFetch(
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/" },
        })) as typeof fetch,
    )("https://lain.bgm.tv/pic/cover/l/aa/bb/42_test.jpg"),
    /artworkUnavailable/,
  );
});

test("Bilibili official artwork uses browser networking with a referer and no credentials", async () => {
  const request = providerArtworkFetch((async (url, init) => {
    assert.equal(String(url), "https://i0.hdslb.com/bfs/bangumi/poster.png");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual");
    assert.equal(
      new Headers(init?.headers).get("Referer"),
      "https://www.bilibili.com/",
    );
    return new Response(png, { headers: { "content-type": "image/png" } });
  }) as typeof fetch);
  assert.equal(
    (await request("https://i0.hdslb.com/bfs/bangumi/poster.png")).status,
    200,
  );
});
