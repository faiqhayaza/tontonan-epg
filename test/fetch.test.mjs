/**
 * Unit tests for lib/fetch.mjs: the streaming byte cap, the transient
 * retry, and gunzipCapped. All against a local HTTP server — no
 * upstream, no network. (The timeout/abort retry path is in
 * test/fetch-retry-oe7.test.mjs.)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { fetchBuf, gunzipCapped, isTransientFetchError } from "../lib/fetch.mjs";

describe("isTransientFetchError", () => {
  it("retries 5xx, timeouts and connection failures — not 4xx or cap errors", () => {
    assert.equal(isTransientFetchError(Object.assign(new Error("HTTP 503 (http://x)"), { name: "Error" })), true);
    assert.equal(isTransientFetchError(Object.assign(new Error("HTTP 500 (http://x)"), { name: "Error" })), true);
    assert.equal(isTransientFetchError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
    assert.equal(isTransientFetchError(Object.assign(new Error("read ECONNRESET"), { cause: { code: "ECONNRESET" } })), true);
    assert.equal(isTransientFetchError(new Error("HTTP 404 (http://x)")), false);
    assert.equal(isTransientFetchError(new Error("downloaded 123 bytes, exceeds cap 10 (http://x)")), false);
    assert.equal(isTransientFetchError(new Error("content-length 99 exceeds cap 10 (http://x)")), false);
  });
});

describe("fetchBuf against a local server", () => {
  let server;
  let base;
  // Per-path behaviour, reset per test.
  let flakyHits = 0;
  let notFoundHits = 0;
  let dripBytesWritten = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/small") {
        const body = Buffer.from("hello world");
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": body.length });
        res.end(body);
      } else if (req.url === "/lies-about-length") {
        // Claims 10 bytes, streams 1 MiB chunked (no content-length).
        // A post-buffering cap check would swallow the whole MiB first.
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        let sent = 0;
        const chunk = Buffer.alloc(4096, "x");
        const timer = setInterval(() => {
          dripBytesWritten += chunk.length;
          sent += chunk.length;
          if (sent >= 1024 * 1024 || res.destroyed) {
            clearInterval(timer);
            if (!res.destroyed) res.end();
            return;
          }
          if (!res.write(chunk)) {
            /* backpressure: keep dripping on drain; the interval keeps the test moving */
          }
        }, 5);
        req.on("close", () => clearInterval(timer));
        res.on("close", () => clearInterval(timer));
      } else if (req.url === "/honest-too-big") {
        // Honest content-length over the cap: the body must never be sent.
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": 1024 * 1024 });
        res.end(Buffer.alloc(1024 * 1024, "y"));
      } else if (req.url === "/flaky") {
        flakyHits++;
        if (flakyHits === 1) {
          res.writeHead(503);
          res.end("down");
        } else {
          res.writeHead(200, { "Content-Length": 2 });
          res.end("ok");
        }
      } else if (req.url === "/not-found") {
        notFoundHits++;
        res.writeHead(404);
        res.end("nope");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  it("returns a small 200 body intact, byte for byte", async () => {
    const buf = await fetchBuf(`${base}/small`, 5000, { maxBytes: 1024 });
    assert.equal(buf.toString("utf8"), "hello world");
  });

  it("aborts a lying feed mid-stream instead of buffering it whole (B3)", async () => {
    dripBytesWritten = 0;
    await assert.rejects(fetchBuf(`${base}/lies-about-length`, 10_000, { maxBytes: 10 * 1024, retries: 0 }), (e) => {
      assert.match(e.message, /downloaded \d+ bytes, exceeds cap 10240/);
      assert.equal(e.url, `${base}/lies-about-length`);
      return true;
    });
    // The server was still dripping 1 MiB when the client aborted; if the
    // cap had been enforced only after buffering, it would have written
    // the whole MiB. Give the abort a moment to propagate, then check.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(dripBytesWritten < 256 * 1024, `server wrote ${dripBytesWritten} bytes before the abort stopped it`);
  });

  it("refuses an honestly oversized content-length without downloading it", async () => {
    await assert.rejects(fetchBuf(`${base}/honest-too-big`, 5000, { maxBytes: 1024, retries: 0 }), (e) => {
      assert.match(e.message, /content-length 1048576 exceeds cap 1024/);
      return true;
    });
  });

  it("retries once on a transient 503 and then succeeds (S9)", async () => {
    flakyHits = 0;
    const buf = await fetchBuf(`${base}/flaky`, 5000, { retryDelayMs: 10 });
    assert.equal(buf.toString("utf8"), "ok");
    assert.equal(flakyHits, 2);
  });

  it("does not retry a 404", async () => {
    notFoundHits = 0;
    await assert.rejects(fetchBuf(`${base}/not-found`, 5000, { retryDelayMs: 10 }), /HTTP 404/);
    assert.equal(notFoundHits, 1);
  });
});

describe("gunzipCapped", () => {
  it("round-trips and enforces the output cap with the URL tagged", () => {
    const gz = zlib.gzipSync(Buffer.from("abc".repeat(1000)));
    assert.equal(gunzipCapped(gz, 100_000, "http://x/f.xml.gz").toString("utf8"), "abc".repeat(1000));
    assert.throws(() => gunzipCapped(gz, 100, "http://x/f.xml.gz"), (e) => {
      assert.equal(e.url, "http://x/f.xml.gz");
      return true;
    });
  });
});
