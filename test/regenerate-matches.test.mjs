/**
 * Black-box tests for scripts/regenerate-matches.mjs.
 *
 * The script is a top-level CLI (it reads matches.json on import), so
 * it is tested by running it in a temp copy of the repo layout with a
 * fixture matches.json — never by importing it.
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

/* Fixture: a null entry (the B4 crash), a malformed entry (site is a
 * number), an orphan (site with no adapter), and two valid rows. */
const FIXTURE = {
  "GoodOne.uk@HD": { site: "i.mjh.nz", site_id: "UK/all#good", xmltv_id: "GoodOne.uk" },
  "GoodTwo.us@SD": { site: "epg.iptvx.one", site_id: "13-strt", xmltv_id: "GoodTwo.us" },
  "NullEntry.uk": null,
  "BadSite.uk": { site: 123, site_id: "x", xmltv_id: "BadSite.uk" },
  "OrphanOne.fr": { site: "example.com", site_id: "o1", xmltv_id: "OrphanOne.fr" },
};

function stageFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-regen-test-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(repoRoot, "scripts/regenerate-matches.mjs"), path.join(dir, "scripts/regenerate-matches.mjs"));
  // The script's imports (lib/fetch.mjs, lib/catalog.mjs) and their
  // own imports (lib/epg-utils.mjs) must all be staged.
  for (const f of ["fetch.mjs", "catalog.mjs", "epg-utils.mjs"])
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "matches.json"), JSON.stringify(FIXTURE, null, 2));
  return dir;
}

describe("regenerate-matches.mjs", () => {
  it("does not crash on a null entry; reports it as malformed (B4)", async () => {
    const dir = stageFixture();
    try {
      const { stdout } = await run(process.execPath, ["scripts/regenerate-matches.mjs"], { cwd: dir });
      assert.match(stdout, /matches\.json: 5 entries across 3 sites/);
      assert.match(stdout, /malformed entries \(missing site\/site_id\/xmltv_id\): 2/);
      assert.match(stdout, /NullEntry\.uk/);
      assert.match(stdout, /orphan entries \(site has no adapter\): 1/);
      assert.doesNotMatch(stdout, /TypeError/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--prune-orphans --dry-run drops only the orphan, never a malformed row", async () => {
    const dir = stageFixture();
    try {
      const { stdout } = await run(process.execPath, ["scripts/regenerate-matches.mjs", "--prune-orphans", "--dry-run"], { cwd: dir });
      assert.match(stdout, /would drop 1 entries \(5 -> 4\)/);
      // Dry run must not touch the file.
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "matches.json"), "utf8")), FIXTURE);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--help prints usage and exits 0 (N10)", async () => {
    const dir = stageFixture();
    try {
      const { stdout } = await run(process.execPath, ["scripts/regenerate-matches.mjs", "--help"], { cwd: dir });
      assert.match(stdout, /--prune-orphans/);
      assert.match(stdout, /--verify-sources/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prune-stale fetches the A1 mirror, not tontonan.online (S5)", () => {
    // Regression guard on the URL itself: --prune-stale does live I/O
    // against a hardcoded URL, so there is no fixture that can observe
    // which host it hits. The guard fails loudly if the URL regresses
    // to the host the repo's own comments say 403s from automation.
    // The URL itself lives in exactly one place (lib/catalog.mjs);
    // this asserts the script uses that constant.
    const src = fs.readFileSync(path.join(repoRoot, "scripts/regenerate-matches.mjs"), "utf8");
    assert.ok(src.includes('import { CATALOG_MIRROR_URL } from "../lib/catalog.mjs"'));
    assert.ok(src.includes("fetch(CATALOG_MIRROR_URL, {"));
    assert.ok(!src.includes("https://tontonan.online/catalog.json"));
    // And the fetches carry a timeout (S4).
    assert.ok(src.includes("AbortSignal.timeout(60_000)"));
  });
});
