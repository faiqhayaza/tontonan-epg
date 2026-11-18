/**
 * Black-box test for the malformed-matches-entry crash (R1).
 *
 * Runs the real build-epg.mjs in a staged temp dir (test/staged-build.mjs)
 * with a matches.json holding a null entry, and proves: the process
 * exits non-zero, a failing build-report.json is written naming the
 * malformed entry, and the previous good epg.json is left untouched.
 * Same shape as test/build-epg-s10.test.mjs (corrupt matches.json).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readText, removeDir, runBuild, stageBuild } from "./staged-build.mjs";

const stage = (matches) => stageBuild({ matches, previousReport: { channelsWithData: 3000 }, previousEpg: "PREVIOUS-GOOD" });

describe("build-epg.mjs with a malformed matches.json entry (R1)", () => {
  it("writes a failing report and keeps the last good epg.json (null entry)", async () => {
    const dir = stage('{"A.uk": null}');
    try {
      const { stdout, stderr, report } = await runBuild(dir);
      assert.equal(report.channelsWithData, 0);
      assert.equal(report.gate.pass, false);
      assert.match(report.matchesError, /malformed/);
      assert.match(report.matchesError, /"A\.uk"/);
      // The gate reason is matchesError itself (O-E8: no doubled prefix).
      assert.ok(report.gate.reasons.includes(report.matchesError));
      assert.match(stdout + stderr, /GATE FAILED/);
      // The previous good epg.json is untouched.
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");
    } finally {
      removeDir(dir);
    }
  });

  it("exits non-zero for a non-object entry", async () => {
    const dir = stage('{"A.uk": "not-an-object"}');
    try {
      const { code, report } = await runBuild(dir);
      assert.equal(code, 1);
      assert.match(report.matchesError, /malformed/);
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");
    } finally {
      removeDir(dir);
    }
  });
});
