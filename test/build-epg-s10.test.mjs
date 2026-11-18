/**
 * Black-box test for a corrupt matches.json (S10): the build must still
 * reach the end and write its report.
 *
 * Runs the real build-epg.mjs in a staged temp dir (test/staged-build.mjs)
 * with a corrupt matches.json and a fetch stub that 404s everything, and
 * proves: the process exits non-zero, build-report.json is written
 * naming the cause, and the previous good epg.json is left untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readText, removeDir, runBuild, stageBuild } from "./staged-build.mjs";

const stage = (matches) => stageBuild({ matches, previousReport: { channelsWithData: 3000 }, previousEpg: "PREVIOUS-GOOD" });

describe("build-epg.mjs with a corrupt matches.json (S10)", () => {
  it("writes a failing report and keeps the last good epg.json", async () => {
    const dir = stage("{corrupt");
    try {
      const { stdout, stderr, report } = await runBuild(dir);
      assert.equal(report.channelsWithData, 0);
      assert.equal(report.gate.pass, false);
      assert.match(report.matchesError, /not valid JSON/);
      // The gate reason is matchesError itself (O-E8: no doubled prefix).
      assert.ok(report.gate.reasons.includes(report.matchesError));
      assert.match(stdout + stderr, /GATE FAILED/);
      // The previous good epg.json is untouched.
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");
    } finally {
      removeDir(dir);
    }
  });

  it("exits non-zero", async () => {
    const dir = stage("null");
    try {
      const { code, report } = await runBuild(dir);
      assert.equal(code, 1);
      assert.match(report.matchesError, /not an object/);
    } finally {
      removeDir(dir);
    }
  });
});
