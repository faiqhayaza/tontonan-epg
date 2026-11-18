/**
 * Black-box test for the gate baseline (E1): the baseline must be the
 * last GOOD build, not the last build.
 *
 * Drives the real build-epg.mjs in a staged temp dir
 * (test/staged-build.mjs) with the REAL build-report.json round-trip:
 * run 1's written report is read back by run 2 as its baseline. The
 * routing fetch stub serves an iptvx feed with N channels of programmes
 * (N set per run by rewriting the routes); every other URL answers 404.
 *
 * Before the fix, run 1 (3,000 -> 1,000) was gated but committed
 * channelsWithData 1,000, so run 2 (1,000 vs 1,000) PASSED and
 * overwrote epg.json with the degraded build.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readText, removeDir, ROUTING_FETCH_STUB, runBuild, stageBuild, writeRoutes } from "./staged-build.mjs";

const IPTVX_URL = "https://iptvx.one/epg/epg_noarch.xml.gz";
const ROWS = 3000;

function stage() {
  // 3,000 iptvx rows; how many of them get programmes is set per run.
  const matches = {};
  for (let i = 0; i < ROWS; i++) matches[`C${i}.uk`] = { site: "epg.iptvx.one", site_id: `s${i}`, xmltv_id: `C${i}.uk` };
  return stageBuild({
    matches,
    stub: ROUTING_FETCH_STUB,
    // The previous committed report: a healthy 3,000-channel build, in
    // the pre-E1 shape (no lastGoodChannelsWithData field).
    previousReport: { channelsWithData: 3000, gate: { prevChannelsWithData: 3000, pass: true } },
    previousEpg: "PREVIOUS-GOOD",
  });
}

/* Serve programmes for the first `n` iptvx channels on the next run. */
function serveChannels(dir, n) {
  const programmes = [];
  for (let i = 0; i < n; i++) programmes.push({ channel: `s${i}`, startH: -1, stopH: 1, title: `P${i}` });
  writeRoutes(dir, { [IPTVX_URL]: { gzip: true, programmes } });
}

describe("build-epg.mjs gate baseline is the last GOOD build (E1)", () => {
  it("a gated build does not become the next build's baseline (two-run report round-trip)", async () => {
    const dir = stage();
    try {
      // Run 1: 1,000 channels vs the previous good 3,000 -> gated.
      serveChannels(dir, 1000);
      const r1 = await runBuild(dir);
      assert.equal(r1.report.channelsWithData, 1000);
      assert.equal(r1.report.gate.pass, false, "run 1 (3000 -> 1000) must fail the gate");
      assert.equal(r1.code, 1);
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");

      // Run 2: the same 1,000 channels, baseline read back from run
      // 1's REAL written report. Must STILL fail: the gated run 1 is
      // not a good build. (Pre-fix this PASSED: 1000 < 1000 * 0.75 is
      // false, and epg.json was overwritten with the degraded build.)
      const r2 = await runBuild(dir);
      assert.equal(r2.report.channelsWithData, 1000);
      assert.equal(r2.report.gate.pass, false, `run 2 (1000 vs run 1's report) must STILL fail the gate; got ${JSON.stringify(r2.report.gate)}`);
      assert.equal(r2.code, 1);
      assert.equal(r2.report.gate.prevChannelsWithData, 3000);
      assert.equal(r2.report.lastGoodChannelsWithData, 3000);
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");

      // Run 3 (positive control): a recovered 2,500-channel build is
      // within 25% of the last good 3,000 -> passes, ships epg.json, and
      // the last-good baseline advances to 2,500.
      serveChannels(dir, 2500);
      const r3 = await runBuild(dir);
      assert.equal(r3.report.gate.pass, true, JSON.stringify(r3.report.gate));
      assert.equal(r3.code, 0);
      assert.equal(r3.report.lastGoodChannelsWithData, 2500);
      assert.equal(Object.keys(JSON.parse(readText(dir, "epg.json")).channels).length, 2500);
    } finally {
      removeDir(dir);
    }
  });
});
