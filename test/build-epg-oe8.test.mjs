/**
 * O-E8: the gate reason for a bad matches.json is matchesError itself.
 * It used to be prefixed with "matches.json could not be loaded: " on
 * top of a matchesError that already starts "matches.json is not valid
 * JSON: ..." — the file name twice in one reason.
 *
 * Black box: the real build-epg.mjs in a staged temp dir
 * (test/staged-build.mjs) with a 404 fetch stub.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { removeDir, runBuild, stageBuild } from "./staged-build.mjs";

async function reportFor(matches) {
  const dir = stageBuild({ matches });
  try {
    return (await runBuild(dir)).report;
  } finally {
    removeDir(dir);
  }
}

describe("O-E8: matches.json gate reason is not double-prefixed", () => {
  for (const [label, text] of [["corrupt JSON", "{corrupt"], ["a non-object", "null"], ["a malformed entry", '{"A.uk": null}']]) {
    it(`for ${label}`, async () => {
      const report = await reportFor(text);
      const reason = report.gate.reasons.find((r) => r.includes("matches.json"));
      assert.equal(reason, report.matchesError);
      assert.equal(reason.split("matches.json").length - 1, 1, `"matches.json" repeated in: ${reason}`);
    });
  }
});
