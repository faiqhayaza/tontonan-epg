/**
 * Tests for E6 (and the behaviour O-E1 documents): the build's
 * worst-case timeout arithmetic and its overall deadline.
 *
 *  1. Black box: build-epg.mjs runs in a staged temp dir
 *     (test/staged-build.mjs) with a fetch stub that never answers (it
 *     only rejects when its abort signal fires), so every adapter would
 *     sit out its full per-fetch timeouts. With EPG_BUILD_DEADLINE_MS
 *     set to a couple of seconds the build must stop itself, fail the
 *     gate, and STILL write build-report.json — the old code had no
 *     deadline, so in a total outage the job timeout killed it before
 *     any report was written.
 *  2. The worst-case table in build-epg.mjs's TIMEOUT_MS comment must
 *     match a recomputation from the actual EPGSHARE_REGIONS list (the
 *     old comment's region count and "binding constraint" claim were
 *     both wrong). This one reads source text on purpose: the claim
 *     under test IS a comment.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readText, removeDir, repoRoot, runBuild, stageBuild } from "./staged-build.mjs";

const HANGING_FETCH_STUB = `// Every upstream hangs: the request only ends when its abort signal
// fires (the per-fetch timeout), exactly like a dead host.
globalThis.fetch = (url, init = {}) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
`;

/* Blocks the event loop for 1.5 s inside the fetch call, then answers
 * 404: the deadline timer cannot fire while it spins. */
const BLOCKING_FETCH_STUB = `globalThis.fetch = async () => {
  const until = Date.now() + 1500;
  while (Date.now() < until);
  return new Response("not found", { status: 404 });
};
`;

const stage = (stub) =>
  stageBuild({
    matches: { "A.uk": { site: "i.mjh.nz", site_id: "UK/all#a", xmltv_id: "A.uk" } },
    stub,
    previousReport: { channelsWithData: 3000, marker: "PREVIOUS-REPORT" },
    previousEpg: "PREVIOUS-GOOD",
  });

describe("E6: the build has an overall deadline", () => {
  it("a build that exceeds the deadline still writes its failing report", async () => {
    const dir = stage(HANGING_FETCH_STUB);
    try {
      const t0 = Date.now();
      const { code, killed, stderr, report } = await runBuild(dir, {
        env: { EPG_BUILD_DEADLINE_MS: "1500" },
        timeout: 20_000, // without a deadline the first fetch alone waits 2 x 120 s
      });
      assert.equal(killed, false, "the build did not stop by itself; the test had to kill it");
      assert.equal(code, 1, "a deadline build must exit non-zero");
      assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
      assert.equal(report.marker, undefined, "build-report.json was not rewritten");
      assert.equal(report.gate.pass, false);
      assert.ok(
        report.gate.reasons.includes("build deadline (0.03 min) exceeded (iptvx abandoned while running; not run: mjh, myjcom, epgshare, iptvorg, epgpw, epgbest)"),
        JSON.stringify(report.gate.reasons),
      );
      assert.match(report.adapters.iptvx.error, /abandoned: build deadline/);
      for (const name of ["mjh", "myjcom", "epgshare", "iptvorg", "epgpw", "epgbest"])
        assert.match(report.adapters[name].error, /not run: build deadline/, name);
      assert.match(stderr, /GATE FAILED/);
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");
    } finally {
      removeDir(dir);
    }
  });

  it("an adapter that finishes past the deadline is not called abandoned", async () => {
    // A timer cannot interrupt synchronous work: iptvx's fetch blocks
    // past the 600 ms deadline, then fails normally with its own 404,
    // and the deadline is first seen before mjh starts. The reason must
    // say that no adapter was abandoned, rather than blame mjh, which
    // never ran.
    const dir = stage(BLOCKING_FETCH_STUB);
    try {
      const { code, report } = await runBuild(dir, { env: { EPG_BUILD_DEADLINE_MS: "600" }, timeout: 20_000 });
      assert.equal(code, 1);
      assert.match(report.adapters.iptvx.error, /^HTTP 404/);
      assert.match(report.adapters.mjh.error, /^not run: build deadline/);
      assert.ok(
        report.gate.reasons.includes("build deadline (0.01 min) exceeded (not run: mjh, myjcom, epgshare, iptvorg, epgpw, epgbest)"),
        JSON.stringify(report.gate.reasons),
      );
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");
    } finally {
      removeDir(dir);
    }
  });
});

describe("E6: the worst-case comment matches the real region list", () => {
  const src = fs.readFileSync(path.join(repoRoot, "build-epg.mjs"), "utf8");
  const listSrc = /const EPGSHARE_REGIONS = \(([\s\S]*?)\)\.split\(" "\)/.exec(src)[1];
  const regions = [...listSrc.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("").split(" ");
  const n = regions.length;

  it("states the actual region count and round counts", () => {
    assert.ok(n > 0 && new Set(regions).size === n, "region list parsed");
    const lists = Math.ceil(n / 6);
    const xml = Math.ceil(n / 3);
    assert.ok(src.includes(`ceil(${n} regions / 6) = ${lists} x 62 s`), `listing row for ${n} regions`);
    assert.ok(src.includes(`ceil(${n} regions / 3) = ${xml} x 362 s`), `XML row for ${n} regions`);
    assert.ok(src.includes(`(${n} = EPGSHARE_REGIONS.length`));
    assert.ok(src.includes(`.txt listings on 2026-11-17 (${n} regions)`), "the region-list comment's count");
  });

  it("states the summed bound, and epgshare XML (not epgpw) as the largest leg", () => {
    const fetchS = (timeoutS) => 2 * timeoutS + 2; // timeout + 2 s backoff + retry
    const legs = {
      iptvx: 1 * fetchS(120),
      mjh: Math.ceil(27 / 6) * fetchS(90),
      myjcom: 10 * fetchS(30),
      catalog: 3 * fetchS(60),
      lists: Math.ceil(n / 6) * fetchS(30),
      xml: Math.ceil(n / 3) * fetchS(180),
      epgpw: 20 * fetchS(180),
      epgbest: fetchS(180),
    };
    const totalMin = Math.round(Object.values(legs).reduce((a, b) => a + b, 0) / 60);
    assert.match(src, new RegExp(`total\\s+~ ${totalMin} min`));
    assert.match(src, new RegExp(`epgshare XML .*~ ${Math.round(legs.xml / 60)} min`));
    assert.ok(legs.xml > legs.epgpw, "epgshare XML is the largest leg");
    assert.doesNotMatch(src, /binding constraint/);
  });
});
