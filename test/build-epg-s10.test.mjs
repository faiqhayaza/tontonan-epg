/**
 * Black-box test for the "report is ALWAYS written" promise (S10).
 *
 * Runs the real build-epg.mjs in a staged temp dir — never imported
 * (importing it starts the real build) — with a corrupt matches.json
 * and a fetch stub that 404s everything, and proves: the process
 * exits non-zero, build-report.json is written naming the cause, and
 * the previous good epg.json is left untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = new URL("..", import.meta.url).pathname;

const FETCH_STUB = `// Replaces global fetch before build-epg.mjs loads: every
// upstream answers 404, so no real network is touched and every
// adapter that needs the network fails fast (404 is not retried).
globalThis.fetch = async () => ({ ok: false, status: 404, headers: new Headers() });
`;

function stage({ matchesText }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-s10-test-"));
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

describe("build-epg.mjs with a corrupt matches.json (S10)", () => {
  it("writes a failing report and keeps the last good epg.json", async () => {
    const dir = stage({ matchesText: "{corrupt" });
    try {
      const { stdout, stderr } = await run(process.execPath, ["--import", "./fetch-stub.mjs", "build-epg.mjs"], { cwd: dir })
        .catch((e) => e); // non-zero exit lands here; stdout/stderr still attached
      const report = JSON.parse(fs.readFileSync(path.join(dir, "build-report.json"), "utf8"));
      assert.equal(report.channelsWithData, 0);
      assert.equal(report.gate.pass, false);
      assert.match(report.matchesError, /not valid JSON/);
      assert.ok(report.gate.reasons.some((r) => r.includes("matches.json could not be loaded")));
      assert.match(String(stdout + stderr), /GATE FAILED/);
      // The previous good epg.json is untouched.
      assert.equal(fs.readFileSync(path.join(dir, "epg.json"), "utf8"), "PREVIOUS-GOOD");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero", async () => {
    const dir = stage({ matchesText: "null" });
    try {
      await assert.rejects(run(process.execPath, ["--import", "./fetch-stub.mjs", "build-epg.mjs"], { cwd: dir }), (e) => {
        assert.equal(e.code, 1);
        return true;
      });
      const report = JSON.parse(fs.readFileSync(path.join(dir, "build-report.json"), "utf8"));
      assert.match(report.matchesError, /not an object/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
