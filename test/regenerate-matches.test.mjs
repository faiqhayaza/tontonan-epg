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
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/* Fixture: a null entry (the B4 crash), a malformed entry (site is a
 * number), an orphan (site with no adapter), and two valid rows. */
const FIXTURE = {
  "GoodOne.uk@HD": { site: "i.mjh.nz", site_id: "UK/all#good", xmltv_id: "GoodOne.uk" },
  "DupOne.uk": { site: "i.mjh.nz", site_id: "UK/all#good", xmltv_id: "DupOne.uk" },
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
  // The script's imports (lib/fetch.mjs, lib/catalog.mjs,
  // lib/pipeline.mjs) and their own imports (lib/epg-utils.mjs) must
  // all be staged.
  for (const f of ["fetch.mjs", "catalog.mjs", "pipeline.mjs", "epg-utils.mjs"])
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "matches.json"), JSON.stringify(FIXTURE, null, 2));
  return dir;
}

describe("regenerate-matches.mjs", () => {
  it("does not crash on a null entry; reports it as malformed (B4)", async () => {
    const dir = stageFixture();
    try {
      const { stdout } = await run(process.execPath, ["scripts/regenerate-matches.mjs"], { cwd: dir });
      assert.match(stdout, /matches\.json: 6 entries across 3 sites/);
      assert.match(stdout, /malformed entries \(missing site\/site_id\/xmltv_id\): 2/);
      assert.match(stdout, /NullEntry\.uk/);
      assert.match(stdout, /orphan entries \(site has no adapter\): 1/);
      assert.match(stdout, /mjh duplicate \(path, key\) rows \(later row loses its guide\): 1/);
      assert.match(stdout, /UK\/all#good: kept GoodOne\.uk@HD, dropped DupOne\.uk/);
      assert.doesNotMatch(stdout, /TypeError/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--prune-orphans --dry-run drops only the orphan, never a malformed row", async () => {
    const dir = stageFixture();
    try {
      const { stdout } = await run(process.execPath, ["scripts/regenerate-matches.mjs", "--prune-orphans", "--dry-run"], { cwd: dir });
      assert.match(stdout, /would drop 1 entries \(6 -> 5\)/);
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

  it("prune-stale fetches the A1 mirror, not tontonan.online, with an abort signal (S5, S4, E10)", async () => {
    // Behaviour, not source text (E10): a recording fetch stub,
    // preloaded with --import, observes the request the script actually
    // makes. The old version of this test grepped the script's source
    // for the constant's name, so it stayed green when the request went
    // to another host (e.g. the constant's value regressed in
    // lib/catalog.mjs) or the timeout was dropped from the call.
    const dir = stageFixture();
    try {
      const log = path.join(dir, "requests.log");
      fs.writeFileSync(
        path.join(dir, "fetch-stub.mjs"),
        `import fs from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), hasSignal: init.signal instanceof AbortSignal }) + "\\n");
  return new Response(JSON.stringify({ channels: Object.keys(${JSON.stringify(FIXTURE)}).map((id) => ({ id })) }), { status: 200 });
};
`,
      );
      const { stdout } = await run(process.execPath, ["--import", "./fetch-stub.mjs", "scripts/regenerate-matches.mjs", "--prune-stale", "--dry-run"], { cwd: dir });
      assert.match(stdout, /stale entries \(channel not in live catalog\): 0\b/);
      const reqs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(reqs.length, 1);
      const url = new URL(reqs[0].url);
      assert.equal(url.host, "oracle-relay.faiqhayaza.com", `fetched ${reqs[0].url}`);
      assert.notEqual(url.host, "tontonan.online");
      assert.equal(url.pathname, "/catalog.json");
      // The fetch carries an abort signal, i.e. it can time out (S4).
      assert.equal(reqs[0].hasSignal, true, "catalog fetch has no abort signal (no timeout)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
