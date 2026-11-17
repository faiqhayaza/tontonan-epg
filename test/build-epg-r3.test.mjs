/**
 * Black-box tests for the iptvorg.channels.json error message (R3).
 *
 * Runs the real build-epg.mjs in a staged temp dir — never imported
 * (importing it starts the real build) — with a valid matches.json
 * and a fetch stub that 404s everything, and proves the iptvorg
 * adapter distinguishes a missing channels file (a skip: the grab
 * step did not run) from a corrupt one (an error worth naming).
 * Same staging shape as test/build-epg-s10.test.mjs.
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

// One valid mjh row: the adapters have something to attempt, so the
// build runs its normal course (and fails the gate on zero channels,
// since every fetch 404s) instead of short-circuiting on matches.
const VALID_MATCHES = JSON.stringify({
  "A.uk": { site: "i.mjh.nz", site_id: "UK/all#bbc", xmltv_id: "A.uk" },
});

function stage({ channelsText = undefined }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-r3-test-"));
  fs.copyFileSync(path.join(repoRoot, "build-epg.mjs"), path.join(dir, "build-epg.mjs"));
  fs.mkdirSync(path.join(dir, "lib"));
  for (const f of fs.readdirSync(path.join(repoRoot, "lib")))
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "matches.json"), VALID_MATCHES);
  if (channelsText !== undefined)
    fs.writeFileSync(path.join(dir, "iptvorg.channels.json"), channelsText);
  fs.writeFileSync(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
  fs.writeFileSync(path.join(dir, "build-report.json"), JSON.stringify({ channelsWithData: 3000 }));
  fs.writeFileSync(path.join(dir, "epg.json"), "PREVIOUS-GOOD");
  return dir;
}

async function runStaged(dir) {
  return run(process.execPath, ["--import", "./fetch-stub.mjs", "build-epg.mjs"], { cwd: dir }).catch((e) => e);
}

describe("build-epg.mjs iptvorg.channels.json errors (R3)", () => {
  it("reports a corrupt channels file as an error, not a missing one", async () => {
    const dir = stage({ channelsText: "{corrupt" });
    try {
      await runStaged(dir);
      const report = JSON.parse(fs.readFileSync(path.join(dir, "build-report.json"), "utf8"));
      assert.match(report.adapters.iptvorg.error, /could not be parsed/);
      assert.equal(report.adapters.iptvorg.skipped, undefined);
      assert.equal(fs.readFileSync(path.join(dir, "epg.json"), "utf8"), "PREVIOUS-GOOD");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still skips quietly when the channels file is absent", async () => {
    const dir = stage({});
    try {
      await runStaged(dir);
      const report = JSON.parse(fs.readFileSync(path.join(dir, "build-report.json"), "utf8"));
      assert.match(report.adapters.iptvorg.skipped, /not present \(grab step did not run\)/);
      assert.equal(report.adapters.iptvorg.error, undefined);
      assert.equal(fs.readFileSync(path.join(dir, "epg.json"), "utf8"), "PREVIOUS-GOOD");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
