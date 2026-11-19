/**
 * Black-box test for the schedule scan (E-new) and the overlap repair:
 * overlapping programmes used to fail the build; the repair now clips
 * the earlier programme to the next start and the build ships.
 *
 * The 2026-11-18 epg.json carried 4,597 overlapping programmes across
 * 130 channels and nothing in the build checked for it. Runs the real
 * build-epg.mjs in a staged temp dir (test/staged-build.mjs) with the
 * routing fetch stub serving an iptvx feed whose one channel has two
 * overlapping programmes; before the scan the gate passed and epg.json
 * was overwritten. The scan itself still detects overlaps — that is
 * pinned by the scanSchedules unit tests in test/pipeline.test.mjs,
 * which run the scan on unrepaired input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readText, removeDir, ROUTING_FETCH_STUB, runBuild, stageBuild } from "./staged-build.mjs";

const IPTVX_URL = "https://iptvx.one/epg/epg_noarch.xml.gz";

const stage = (programmes) =>
  stageBuild({
    matches: { "Dup.uk": { site: "epg.iptvx.one", site_id: "d1", xmltv_id: "Dup.uk" } },
    stub: ROUTING_FETCH_STUB,
    routes: { [IPTVX_URL]: { gzip: true, programmes } },
    previousEpg: "PREVIOUS-GOOD",
  });

describe("build-epg.mjs schedule scan (E-new)", () => {
  it("two overlapping programmes on one channel are repaired (the earlier one is clipped) and the build ships", async () => {
    const dir = stage([
      { channel: "d1", startH: -1, stopH: 1, title: "A" },
      { channel: "d1", startH: 0, stopH: 2, title: "B" }, // starts inside A
    ]);
    try {
      const { code, stdout, stderr, report } = await runBuild(dir);
      assert.equal(report.gate.pass, true, `repaired overlaps must pass the gate; got ${JSON.stringify(report.gate)}`);
      assert.equal(code, 0);
      assert.equal(report.scan.overlaps, 0);
      assert.equal(report.scan.overlapChannels, 0);
      assert.deepEqual(report.scan.perChannel, {});
      assert.equal(report.scan.zeroLength, 0);
      assert.equal(report.repair.clipped, 1);
      assert.equal(report.repair.dropped, 0);
      assert.deepEqual(report.repair.perChannel, { "Dup.uk": 1 });
      assert.doesNotMatch(stdout + stderr, /GATE FAILED/);
      const list = JSON.parse(readText(dir, "epg.json")).channels["Dup.uk"];
      assert.equal(list.length, 2);
      assert.equal(list[0][2], "A");
      assert.equal(list[1][2], "B");
      assert.equal(list[0][1], list[1][0]); // A ends exactly when B starts
    } finally {
      removeDir(dir);
    }
  });

  it("back-to-back programmes (end == next start) are not overlaps; the build ships", async () => {
    const dir = stage([
      { channel: "d1", startH: -1, stopH: 0, title: "A" },
      { channel: "d1", startH: 0, stopH: 1, title: "B" },
    ]);
    try {
      const { code, report } = await runBuild(dir);
      assert.equal(report.gate.pass, true, JSON.stringify(report.gate));
      assert.equal(code, 0);
      assert.equal(report.scan.overlaps, 0);
      assert.deepEqual(report.repair, { clipped: 0, dropped: 0, perChannel: {} });
      assert.equal(JSON.parse(readText(dir, "epg.json")).channels["Dup.uk"].length, 2);
    } finally {
      removeDir(dir);
    }
  });
});
