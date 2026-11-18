/**
 * E12: the README's build-report.json example is valid JSON and has the
 * report's CURRENT shape — the same top-level keys a real run of
 * build-epg.mjs writes (including lastGoodChannelsWithData, gate and
 * scan), the same gate/scan sub-keys, and per-adapter withData figures
 * that sum to channelsWithData as the README says.
 *
 * The real shape comes from running build-epg.mjs in a staged temp dir
 * (test/staged-build.mjs) with a 404 fetch stub and a valid matches.json.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { removeDir, repoRoot, runBuild, stageBuild } from "./staged-build.mjs";

function readmeExample() {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const section = readme.split(/^## build-report\.json$/m)[1];
  assert.ok(section, "README has a build-report.json section");
  const block = /```json\n([\s\S]*?)```/.exec(section);
  assert.ok(block, "the section has a json example");
  return JSON.parse(block[1]); // throws (test fails) on invalid JSON
}

async function realReport() {
  const dir = stageBuild({ matches: { "A.uk": { site: "i.mjh.nz", site_id: "UK/all#a", xmltv_id: "A.uk" } } });
  try {
    return (await runBuild(dir)).report;
  } finally {
    removeDir(dir);
  }
}

describe("E12: README build-report example", () => {
  it("is valid JSON with the report's current top-level shape", async () => {
    const example = readmeExample();
    const real = await realReport();
    assert.deepEqual(Object.keys(example).sort(), Object.keys(real).sort());
    for (const k of ["lastGoodChannelsWithData", "gate", "scan"]) assert.ok(k in example, `example lacks ${k}`);
    assert.deepEqual(Object.keys(example.adapters).sort(), Object.keys(real.adapters).sort());
    assert.deepEqual(Object.keys(example.scan).sort(), Object.keys(real.scan).sort());
    // A passing example: the gate has no reasons, and its other keys
    // are the real gate's.
    assert.equal(example.gate.pass, true);
    assert.deepEqual(Object.keys(example.gate).sort(), Object.keys(real.gate).filter((k) => k !== "reasons").sort());
  });

  it("is internally consistent (withData sums, last-good, zero scan on a pass)", () => {
    const example = readmeExample();
    assert.notEqual(example.generatedAt, 0, "a placeholder generatedAt");
    const sum = Object.values(example.adapters).reduce((a, r) => a + (r.withData ?? 0), 0);
    assert.equal(sum, example.channelsWithData);
    assert.equal(example.lastGoodChannelsWithData, example.channelsWithData, "a passing build's last-good is its own count");
    assert.deepEqual(example.scan, { overlaps: 0, overlapChannels: 0, zeroLength: 0, perChannel: {} });
  });
});
