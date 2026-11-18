/**
 * Black-box tests for E5: `regenerate-matches.mjs --prune-stale` must
 * never empty matches.json because the catalog is broken. A 200 with
 * `{}` used to become an empty live set, every entry "stale", and a
 * non-dry run dropped them all (only the .bak copy remained). Now the
 * catalog's shape is checked (parseCatalog) and dropping more than half
 * of the entries needs --force.
 *
 * Runs the real script in a staged temp dir with a fetch stub
 * preloaded via --import (no real network); STUB_BODY is the catalog.
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

const FETCH_STUB = `globalThis.fetch = async () => new Response(process.env.STUB_BODY ?? "{}", { status: 200 });
`;

const MATCHES = {
  "A.uk": { site: "i.mjh.nz", site_id: "UK/all#a", xmltv_id: "A.uk" },
  "B.uk": { site: "i.mjh.nz", site_id: "UK/all#b", xmltv_id: "B.uk" },
  "C.uk": { site: "epg.iptvx.one", site_id: "1-c", xmltv_id: "C.uk" },
  "D.uk": { site: "epg.iptvx.one", site_id: "1-d", xmltv_id: "D.uk" },
};
const MATCHES_TEXT = JSON.stringify(MATCHES, null, 2).replace(/^ +/gm, "");

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-e5-test-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(repoRoot, "scripts/regenerate-matches.mjs"), path.join(dir, "scripts/regenerate-matches.mjs"));
  for (const f of fs.readdirSync(path.join(repoRoot, "lib")))
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
  fs.writeFileSync(path.join(dir, "matches.json"), MATCHES_TEXT);
  return dir;
}

const catalogOf = (...ids) => JSON.stringify({ channels: ids.map((id) => ({ id })) });

function prune(dir, catalogText, extra = []) {
  return run(process.execPath, ["--import", "./fetch-stub.mjs", "scripts/regenerate-matches.mjs", "--prune-stale", ...extra], {
    cwd: dir,
    env: { ...process.env, STUB_BODY: catalogText },
    timeout: 30_000,
  });
}

const matchesNow = (dir) => fs.readFileSync(path.join(dir, "matches.json"), "utf8");
const hasBak = (dir) => fs.existsSync(path.join(dir, "matches.json.bak"));

describe("E5: --prune-stale cannot empty matches.json on a broken catalog", () => {
  it("aborts on a 200 {} catalog with no deletions (not a dry run)", async () => {
    const dir = stage();
    try {
      await assert.rejects(prune(dir, "{}"), (e) => {
        assert.notEqual(e.code, 0);
        assert.match(String(e.stderr), /aborted, nothing dropped.*no channels array/);
        return true;
      });
      assert.equal(matchesNow(dir), MATCHES_TEXT, "matches.json was modified");
      assert.ok(!hasBak(dir), "a prune ran (backup written)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty channels array (100% stale) without --force", async () => {
    const dir = stage();
    try {
      await assert.rejects(prune(dir, catalogOf()), /refused, nothing dropped: 4 of 4/);
      assert.equal(matchesNow(dir), MATCHES_TEXT);
      assert.ok(!hasBak(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a prune that drops more than 50% without --force", async () => {
    const dir = stage();
    try {
      await assert.rejects(prune(dir, catalogOf("A.uk")), (e) => {
        assert.match(String(e.stderr), /refused, nothing dropped: 3 of 4 entries would be dropped \(more than 50%\)/);
        assert.match(String(e.stderr), /--force/);
        return true;
      });
      assert.equal(matchesNow(dir), MATCHES_TEXT, "matches.json was modified");
      assert.ok(!hasBak(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the >50% set when --force is given", async () => {
    const dir = stage();
    try {
      const { stdout } = await prune(dir, catalogOf("A.uk"), ["--force"]);
      assert.match(stdout, /dropping 3 entries \(4 -> 1\)/);
      assert.deepEqual(Object.keys(JSON.parse(matchesNow(dir))), ["A.uk"]);
      assert.equal(fs.readFileSync(path.join(dir, "matches.json.bak"), "utf8"), MATCHES_TEXT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a small stale set (25%) without --force", async () => {
    const dir = stage();
    try {
      const { stdout } = await prune(dir, catalogOf("A.uk", "B.uk", "C.uk"));
      assert.match(stdout, /stale entries \(channel not in live catalog\): 1 of 4/);
      assert.deepEqual(Object.keys(JSON.parse(matchesNow(dir))), ["A.uk", "B.uk", "C.uk"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run reports a >50% set without dropping, and says a real run would refuse", async () => {
    const dir = stage();
    try {
      const { stdout } = await prune(dir, catalogOf("A.uk"), ["--dry-run"]);
      assert.match(stdout, /a real run would refuse without --force/);
      assert.match(stdout, /would drop 3 entries/);
      assert.equal(matchesNow(dir), MATCHES_TEXT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
