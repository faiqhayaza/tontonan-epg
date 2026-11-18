/**
 * O-E7: fetchBuf's timeout/abort retry path. A fetch that hits its own
 * timeout (the AbortController fires) is a transient failure: it is
 * retried exactly once after the backoff, then the AbortError is thrown
 * tagged with the URL. `retries: 0` disables the retry. Against a local
 * server that accepts the request and never answers — no network.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchBuf } from "../lib/fetch.mjs";

describe("fetchBuf timeout / abort retry path (O-E7)", () => {
  let server;
  let base;
  let hangHits = 0;
  let slowHits = 0;
  const open = new Set();

  before(async () => {
    server = http.createServer((req, res) => {
      open.add(res);
      res.on("close", () => open.delete(res));
      if (req.url === "/hang") {
        hangHits++; // never answers: only the client's timeout ends it
      } else if (req.url === "/slow-then-ok") {
        slowHits++;
        if (slowHits === 1) return; // first attempt hangs
        res.writeHead(200, { "Content-Length": 2 });
        res.end("ok");
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    for (const res of open) res.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  it("retries a timed-out fetch once, then throws the AbortError tagged with the URL", async () => {
    hangHits = 0;
    const t0 = Date.now();
    await assert.rejects(fetchBuf(`${base}/hang`, 150, { retryDelayMs: 20 }), (e) => {
      assert.equal(e.name, "AbortError");
      assert.equal(e.url, `${base}/hang`);
      return true;
    });
    assert.equal(hangHits, 2, "expected the first attempt plus exactly one retry");
    assert.ok(Date.now() - t0 >= 150 * 2 + 20, "both attempts ran to their timeout, with the backoff between");
  });

  it("a timed-out first attempt is recovered by the retry", async () => {
    slowHits = 0;
    const buf = await fetchBuf(`${base}/slow-then-ok`, 150, { retryDelayMs: 20 });
    assert.equal(buf.toString("utf8"), "ok");
    assert.equal(slowHits, 2);
  });

  it("retries: 0 gives up after the first timeout", async () => {
    hangHits = 0;
    await assert.rejects(fetchBuf(`${base}/hang`, 150, { retries: 0 }), (e) => e.name === "AbortError");
    assert.equal(hangHits, 1);
  });
});
