/**
 * Test for the epg.best secret-URL leak (E2, latent: EPG_BEST_URL is
 * unset in production today).
 *
 * The epg.best feed URL is a personal token (the EPG_BEST_URL secret).
 * build-report.json is committed to a public repo on every build
 * (`if: always()`), and Actions masks secrets only in logs, not in
 * committed files. Before the fix, an epgbest fetch or gunzip failure
 * wrote the raw URL into the report twice: in `error` ("HTTP 404
 * (<url>)") and in `url`.
 *
 * Black-box part: runs the real build-epg.mjs in a staged temp dir
 * (test/staged-build.mjs) with EPG_BEST_URL set to a FAKE secret URL,
 * then asserts the fake secret appears nowhere in the written
 * build-report.json. Unit part: lib/fetch.mjs's label option on
 * fetchError / gunzipCapped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchBuf, fetchError, gunzipCapped } from "../lib/fetch.mjs";
import { readText, removeDir, ROUTING_FETCH_STUB, runBuild, stageBuild } from "./staged-build.mjs";

const SECRET = "FAKESECRET123";
const SECRET_URL = `https://epg.best/feed?token=${SECRET}`;
const LABEL = "epgbest feed (EPG_BEST_URL)";

const stage = (routes) => stageBuild({ stub: ROUTING_FETCH_STUB, routes, previousEpg: "PREVIOUS-GOOD" });
const buildWithSecret = (dir) => runBuild(dir, { env: { EPG_BEST_URL: SECRET_URL } });

describe("build-epg.mjs never writes the epg.best secret URL into build-report.json (E2)", () => {
  it("fetch failure (HTTP 404 at the secret URL): report carries the label, not the URL", async () => {
    const dir = stage({});
    try {
      const { stderr } = await buildWithSecret(dir);
      const text = readText(dir, "build-report.json");
      assert.ok(!text.includes(SECRET), `secret token leaked into build-report.json: ${JSON.stringify(JSON.parse(text).adapters.epgbest)}`);
      assert.ok(!text.includes("epg.best/feed"), "secret URL leaked into build-report.json");
      const eb = JSON.parse(text).adapters.epgbest;
      assert.match(eb.error, /HTTP 404/);
      assert.equal(eb.url, LABEL);
      assert.ok(eb.error.includes(LABEL));
      // The console log still names the full URL for diagnosis (Actions
      // masks registered secrets in logs; committed files are not masked).
      assert.ok(stderr.includes(SECRET_URL), "console log should carry the full URL for diagnosis");
    } finally {
      removeDir(dir);
    }
  });

  it("gunzip failure (corrupt gzip at the secret URL): report carries the label, not the URL", async () => {
    // gzip magic bytes, then garbage: the adapter takes the gunzip path,
    // and zlib throws.
    const corruptGz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]).toString("base64");
    const dir = stage({ [SECRET_URL]: { raw: corruptGz } });
    try {
      await buildWithSecret(dir);
      const text = readText(dir, "build-report.json");
      assert.ok(!text.includes(SECRET), `secret token leaked into build-report.json: ${JSON.stringify(JSON.parse(text).adapters.epgbest)}`);
      assert.ok(!text.includes("epg.best/feed"), "secret URL leaked into build-report.json");
      const eb = JSON.parse(text).adapters.epgbest;
      assert.ok(eb.error, "the gunzip failure is still recorded");
      assert.equal(eb.url, LABEL);
    } finally {
      removeDir(dir);
    }
  });
});

describe("lib/fetch.mjs label option (E2)", () => {
  it("fetchError with a label keeps the raw URL out of message and url", () => {
    const e = fetchError(SECRET_URL, "HTTP 403", LABEL);
    assert.equal(e.message, `HTTP 403 (${LABEL})`);
    assert.equal(e.url, LABEL);
    assert.equal(e.fullUrl, SECRET_URL);
    // Without a label: unchanged (public URLs stay in the report).
    const p = fetchError("https://example.test/a.xml", "HTTP 404");
    assert.equal(p.message, "HTTP 404 (https://example.test/a.xml)");
    assert.equal(p.url, "https://example.test/a.xml");
    assert.equal(p.fullUrl, undefined);
  });

  it("fetchBuf with a label scrubs the raw URL out of a native error message", async () => {
    // A runtime error can embed the URL in its own message (e.g.
    // "Failed to parse URL from <url>"); the label must replace it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    };
    try {
      await assert.rejects(fetchBuf(SECRET_URL, 1000, { label: LABEL, retries: 0 }), (e) => {
        assert.ok(!String(e.message).includes(SECRET), e.message);
        assert.equal(e.message, `Failed to parse URL from ${LABEL}`);
        assert.equal(e.name, "TypeError");
        assert.equal(e.url, LABEL);
        assert.equal(e.fullUrl, SECRET_URL);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("gunzipCapped with a label tags the label, not the URL", () => {
    assert.throws(
      () => gunzipCapped(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]), 1024, SECRET_URL, { label: LABEL }),
      (e) => {
        assert.equal(e.url, LABEL);
        assert.equal(e.fullUrl, SECRET_URL);
        assert.ok(!String(e.message).includes(SECRET));
        return true;
      },
    );
  });
});
