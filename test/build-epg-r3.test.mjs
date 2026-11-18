/**
 * Black-box tests for the iptvorg.channels.json error message (R3).
 *
 * Runs the real build-epg.mjs in a staged temp dir (test/staged-build.mjs)
 * with a valid matches.json and a fetch stub that 404s everything, and
 * proves the iptvorg adapter distinguishes a missing channels file (a
 * skip: the grab step did not run) from a corrupt one (an error worth
 * naming).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readText, removeDir, runBuild, stageBuild } from "./staged-build.mjs";

// One valid mjh row: the adapters have something to attempt, so the
// build runs its normal course (and fails the gate on zero channels,
// since every fetch 404s) instead of short-circuiting on matches.
const VALID_MATCHES = { "A.uk": { site: "i.mjh.nz", site_id: "UK/all#bbc", xmltv_id: "A.uk" } };

const stage = () => stageBuild({ matches: VALID_MATCHES, previousReport: { channelsWithData: 3000 }, previousEpg: "PREVIOUS-GOOD" });

describe("build-epg.mjs iptvorg.channels.json errors (R3)", () => {
  it("reports a corrupt channels file as an error, not a missing one", async () => {
    const dir = stage();
    try {
      fs.writeFileSync(path.join(dir, "iptvorg.channels.json"), "{corrupt");
      const { report } = await runBuild(dir);
      assert.match(report.adapters.iptvorg.error, /could not be parsed/);
      assert.equal(report.adapters.iptvorg.skipped, undefined);
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");
    } finally {
      removeDir(dir);
    }
  });

  it("still skips quietly when the channels file is absent", async () => {
    const dir = stage();
    try {
      const { report } = await runBuild(dir);
      assert.match(report.adapters.iptvorg.skipped, /not present \(grab step did not run\)/);
      assert.equal(report.adapters.iptvorg.error, undefined);
      assert.equal(readText(dir, "epg.json"), "PREVIOUS-GOOD");
    } finally {
      removeDir(dir);
    }
  });
});
