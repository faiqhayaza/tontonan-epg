/**
 * O-E2: iptvorg.channels.json is committed, so in CI the adapter always
 * finds it and a failed clone/grab surfaces as the GUIDE-file skip. That
 * skip's wording must cover "the grab step did not run" too (it used to
 * say only "grab produced nothing"), and the README must record the
 * decision to keep the file committed.
 *
 * Black box: the real build-epg.mjs in a staged temp dir
 * (test/staged-build.mjs) with a 404 fetch stub, a channels file present
 * (as in a CI checkout) and no guide file (the grab did not run).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { removeDir, repoRoot, runBuild, stageBuild } from "./staged-build.mjs";

describe("O-E2: committed iptvorg.channels.json", () => {
  it("a CI-like checkout with no guide skips with 'did not run or produced nothing'", async () => {
    const dir = stageBuild({ matches: { "A.uk": { site: "i.mjh.nz", site_id: "UK/all#a", xmltv_id: "A.uk" } } });
    try {
      fs.writeFileSync(path.join(dir, "iptvorg.channels.json"), JSON.stringify({ v: 1, channels: { "X.uk": "X.uk" } }));
      const { report } = await runBuild(dir);
      assert.equal(report.adapters.iptvorg.skipped, "iptvorg-guide.xml not present (grab step did not run or produced nothing)");
    } finally {
      removeDir(dir);
    }
  });

  it("the README records that the channel files stay committed and what that means in CI", () => {
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    assert.match(readme, /`iptvorg\.channels\.json` and `iptvorg\.channels\.xml` are committed/);
    assert.match(readme, /they stay committed \(decision of\s+2026-11-18/);
    assert.match(readme, /reachable only locally or in a clone without the file/);
  });
});
