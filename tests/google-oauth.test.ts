import test from "node:test";
import { authorize } from "./fixtures/authorization";
import assert from "node:assert/strict";
import { sourceSchema } from "../src/shared/settings";
import { discoverModels } from "../src/providers/models";
import { aiRecognition } from "../src/providers/ai-recognition";

import { googleHarness as harness } from "./fixtures/google-oauth";

test("Google desktop OAuth validates PKCE, state and signed identity; project discovery and inference use bearer + quota project", async () => {
  const { oauth, source, records } = await harness();
  try {
    const account = await authorize(
      oauth.signIn(source, "fixture-secret"),
      oauth,
      source.id,
    );
    assert.equal(account.status, "connected");
    assert(!JSON.stringify(account).includes("refresh"));
    assert.equal(records.get(source.id)?.clientSecret, "fixture-secret");
    assert.deepEqual(await oauth.projects(source), [
      { id: "fixture-project", name: "Test · fixture-project" },
    ]);
    assert.deepEqual(
      await discoverModels(source, "managed", oauth.request(source)),
      [{ id: "fixture", name: "Fixture", outputLimit: 65536 }],
    );
    for (const url of [
      "https://other.example/v1beta/models",
      "https://generativelanguage.googleapis.com/v1beta/files",
      "https://generativelanguage.googleapis.com/v1beta/models?key=secret",
    ])
      await assert.rejects(oauth.request(source)(url), /invalidInput/);
    await assert.rejects(
      oauth.request({ ...source, project: "" })(
        "https://generativelanguage.googleapis.com/v1beta/models",
      ),
      /googleProjectRequired/,
    );
  } finally {
    oauth.close();
  }
});

test("Google rejects invalid identity and missing Cloud grant without saving tokens", async () => {
  for (const invalid of ["nonce", "audience", "scope"]) {
    const { h, oauth, source, records } = await harness();
    h.invalid = invalid;
    try {
      await assert.rejects(
        authorize(oauth.signIn(source, "fixture-secret"), oauth, source.id),
        /authorizationFailed|googleScopeRequired/,
      );
      assert.equal(records.size, 0);
    } finally {
      oauth.close();
    }
  }
});

test("Google refresh is serialized, retains unrotated refresh tokens and revoked sessions cannot resurrect", async () => {
  const { h, oauth, source, records } = await harness();
  try {
    await authorize(oauth.signIn(source, "fixture-secret"), oauth, source.id);
    h.now += 3600000;
    h.refreshWait = true;
    const url = "https://generativelanguage.googleapis.com/v1beta/models";
    await Promise.all([oauth.request(source)(url), oauth.request(source)(url)]);
    assert.equal(h.refreshCalls, 1);
    assert.equal(records.get(source.id)?.refreshToken, "refresh");
    h.now += 3600000;
    const pending = oauth.request(source)(url);
    void pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await oauth.signOut(source.id), true);
    await assert.rejects(pending);
    assert.equal(records.size, 0);
  } finally {
    oauth.close();
  }
});

test("Google permission errors stay actionable and private bodies never reach UI; invalid_grant signs out", async () => {
  const { h, oauth, source } = await harness();
  try {
    await authorize(oauth.signIn(source, "fixture-secret"), oauth, source.id);
    for (const [status, reason, expected] of [
      [403, "SERVICE_DISABLED", "googleAPIDisabled"],
      [403, "BILLING_DISABLED", "googleBillingRequired"],
      [403, "PERMISSION_DENIED", "googleProjectDenied"],
      [429, "", "sourceRateLimited"],
    ] as const) {
      h.apiStatus = status;
      h.reason = reason;
      await assert.rejects(
        oauth.request(source)(
          "https://generativelanguage.googleapis.com/v1beta/models",
        ),
        new RegExp(`^Error: ${expected}$`),
      );
    }
    h.now += 3600000;
    h.refreshError = "invalid_grant";
    await assert.rejects(
      oauth.request(source)(
        "https://generativelanguage.googleapis.com/v1beta/models",
      ),
      /accountSignInRequired/,
    );
    assert.equal(oauth.status(source.id).status, "signedOut");
  } finally {
    oauth.close();
  }
});

test("Google cancellation closes loopback; failed revocation still clears credentials", async () => {
  const setup = await harness();
  try {
    setup.callback(async () => {
      setup.oauth.cancel(setup.source.id);
    });
    await assert.rejects(
      authorize(
        setup.oauth.signIn(setup.source, "fixture-secret"),
        setup.oauth,
        setup.source.id,
      ),
      /oauthCancelled/,
    );
    assert.equal(setup.records.size, 0);
  } finally {
    setup.oauth.close();
  }
  const { h, oauth, source, records } = await harness();
  try {
    await authorize(oauth.signIn(source, "fixture-secret"), oauth, source.id);
    h.revoke = false;
    assert.equal(await oauth.signOut(source.id), false);
    assert.equal(records.size, 0);
  } finally {
    oauth.close();
  }
});

test("Google clears a session when the refreshed access token is also rejected", async () => {
  const { h, oauth, source, records } = await harness();
  try {
    await authorize(oauth.signIn(source, "fixture-secret"), oauth, source.id);
    h.apiStatus = 401;
    await assert.rejects(
      oauth.request(source)(
        "https://generativelanguage.googleapis.com/v1beta/models",
      ),
      /accountSignInRequired/,
    );
    assert.equal(h.refreshCalls, 1);
    assert.equal(records.size, 0);
    assert.equal(oauth.status(source.id).status, "signedOut");
  } finally {
    oauth.close();
  }
});

test("Google recognition requires grounding evidence and preserves file identity", async () => {
  const { h, source, oauth } = await harness();
  const input = {
    title: "Fixture",
    scope: "file" as const,
    files: [{ id: "stable", filename: "01.mkv", duration: 100, order: 1 }],
  };
  try {
    await authorize(oauth.signIn(source, "fixture-secret"), oauth, source.id);
    const run = () =>
      aiRecognition(
        source,
        "managed",
        "",
        input,
        "{{title}}",
        AbortSignal.timeout(2000),
        oauth.request(source),
      );
    assert.equal((await run()).kind, "result");
    h.search = false;
    await assert.rejects(run(), /oauthSearchUnverified/);
    assert(sourceSchema.safeParse(source).success);
    assert(
      !sourceSchema.safeParse({ ...source, oauthClientId: "https://evil.test" })
        .success,
    );
  } finally {
    oauth.close();
  }
});

test("Google exposes only a current public authorization link and permits reopening before cancellation", async () => {
  const fixture = await harness();
  fixture.callback(async () => {});
  try {
    const login = fixture.oauth.signIn(fixture.source, "fixture-secret");
    void login.catch(() => {});
    let state = fixture.oauth.authorization(fixture.source.id);
    for (let attempt = 0; attempt < 100 && !state?.url; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = fixture.oauth.authorization(fixture.source.id);
    }
    assert(state?.url);
    assert.equal(fixture.h.browserCalls, 0);
    assert(!state.url.includes("fixture-secret"));
    assert.equal(new URL(state.url).origin, "https://accounts.google.com");
    await fixture.oauth.openAuthorization(fixture.source.id, state.id);
    assert.equal(fixture.h.auth.href, state.url);
    fixture.oauth.cancel(fixture.source.id);
    await assert.rejects(login, /oauthCancelled/);
    assert.equal(fixture.oauth.authorization(fixture.source.id), null);
    await assert.rejects(
      fixture.oauth.openAuthorization(fixture.source.id, state.id),
      /authExpired/,
    );
    assert.equal(fixture.records.size, 0);
  } finally {
    fixture.oauth.close();
  }
});
