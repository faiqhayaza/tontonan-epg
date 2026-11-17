/**
 * Black-box test for the malformed-matches-entry crash (R1).
 *
 * Runs the real build-epg.mjs in a staged temp dir — never imported
 * (importing it starts the real build) — with a matches.json holding
 * a null entry, and proves: the process exits non-zero, a failing
 * build-report.json is written naming the malformed entry, and the
 * previous good epg.json is left untouched. Same shape as
 * test/build-epg-s10.test.mjs (corrupt matches.json).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const FETCH_STUB = `// Replaces global fetch before build-epg.mjs loads: every
// upstream answers 404, so no real network is touched and every
// adapter that needs the network fails fast (404 is not retried).
globalThis.fetch = async () => ({ ok: false, status: 404, headers: new Headers() });
`;

function stage({ matchesText }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-r1-test-"));
  fs.copyFileSync(path.join(repoRoot, "build-epg.mjs"), path.join(dir, "build-epg.mjs"));
  fs.mkdirSync(path.join(dir, "lib"));
  for (const f of fs.readdirSync(path.join(repoRoot, "lib")))
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "matches.json"), matchesText);
  fs.writeFileSync(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
  fs.writeFileSync(path.join(dir, "build-report.json"), JSON.stringify({ channelsWithData: 3000 }));
  fs.writeFileSync(path.join(dir, "epg.json"), "PREVIOUS-GOOD");
  return dir;
}

async function runStaged(dir) {
  return run(process.execPath, ["--import", "./fetch-stub.mjs", "build-epg.mjs"], { cwd: dir }).catch((e) => e);
}

describe("build-epg.mjs with a malformed matches.json entry (R1)", () => {
  it("writes a failing report and keeps the last good epg.json (null entry)", async () => {
    const dir = stage({ matchesText: '{"A.uk": null}' });
    try {
      const { stdout, stderr } = await runStaged(dir);
      const report = JSON.parse(fs.readFileSync(path.join(dir, "build-report.json"), "utf8"));
      assert.equal(report.channelsWithData, 0);
      assert.equal(report.gate.pass, false);
      assert.match(report.matchesError, /malformed/);
      assert.match(report.matchesError, /"A\.uk"/);
      assert.ok(report.gate.reasons.some((r) => r.includes("matches.json could not be loaded")));
      assert.match(String(stdout + stderr), /GATE FAILED/);
      // The previous good epg.json is untouched.
      assert.equal(fs.readFileSync(path.join(dir, "epg.json"), "utf8"), "PREVIOUS-GOOD");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero for a non-object entry", async () => {
    const dir = stage({ matchesText: '{"A.uk": "not-an-object"}' });
    try {
      await assert.rejects(run(process.execPath, ["--import", "./fetch-stub.mjs", "build-epg.mjs"], { cwd: dir }), (e) => {
        assert.equal(e.code, 1);
        return true;
      });
      const report = JSON.parse(fs.readFileSync(path.join(dir, "build-report.json"), "utf8"));
      assert.match(report.matchesError, /malformed/);
      assert.equal(fs.readFileSync(path.join(dir, "epg.json"), "utf8"), "PREVIOUS-GOOD");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
