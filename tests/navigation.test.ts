import { test } from "node:test";
import assert from "node:assert/strict";
import { isWebURL, resolveAddress } from "../src/navigation";
test("addresses and searches stay within web protocols", () => {
  assert.equal(resolveAddress("example.com/a"), "https://example.com/a");
  assert.equal(resolveAddress("localhost:8000"), "http://localhost:8000/");
  assert.equal(resolveAddress("https://example.com"), "https://example.com/");
  assert.equal(
    resolveAddress("a video title"),
    "https://www.google.com/search?q=a%20video%20title",
  );
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "tamki://shell",
    "chrome://settings",
    "httpsx://example.com",
  ]) {
    assert.equal(isWebURL(value), false);
    assert.throws(() => resolveAddress(value));
  }
});
