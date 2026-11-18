/**
 * O-E4: iptvorg-channels.mjs keys the per-site yield by the entry's
 * site ATTRIBUTE — the key compareEntries looks it up by — not by the
 * directory name. When the two differ, the old directory-keyed map made
 * every lookup miss, so the yield ordering silently fell back to
 * alphabetical site order.
 *
 * Fixture: directory "a-dir" holds site "z.tv" (2 id matches: X and Y);
 * directory "b-dir" holds site "a.tv" (1 id match: X). X must be
 * grabbed from z.tv (higher yield). With the yield lookups missing, the
 * tie-break picks a.tv (alphabetically first) instead.
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

describe("O-E4: site yield is keyed by the site attribute", () => {
  it("picks the higher-yield site when directory names differ from site attributes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-oe4-test-"));
    try {
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.mkdirSync(path.join(dir, "lib"));
      fs.copyFileSync(path.join(repoRoot, "scripts/iptvorg-channels.mjs"), path.join(dir, "scripts/iptvorg-channels.mjs"));
      for (const f of fs.readdirSync(path.join(repoRoot, "lib")))
        fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
      fs.writeFileSync(
        path.join(dir, "catalog.json"),
        JSON.stringify({ channels: [{ id: "X.uk", name: "Ex", countryCode: "GB" }, { id: "Y.uk", name: "Why", countryCode: "GB" }] }),
      );
      fs.mkdirSync(path.join(dir, "sites", "a-dir"), { recursive: true });
      fs.mkdirSync(path.join(dir, "sites", "b-dir"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "sites", "a-dir", "z.channels.xml"),
        `<channels>
          <channel site="z.tv" site_id="zx" xmltv_id="X.uk">Ex</channel>
          <channel site="z.tv" site_id="zy" xmltv_id="Y.uk">Why</channel>
        </channels>`,
      );
      fs.writeFileSync(path.join(dir, "sites", "b-dir", "a.channels.xml"), `<channels><channel site="a.tv" site_id="ax" xmltv_id="X.uk">Ex</channel></channels>`);
      await run(process.execPath, ["scripts/iptvorg-channels.mjs", "--catalog", "catalog.json", "--sites", "sites"], { cwd: dir });
      const out = fs.readFileSync(path.join(dir, "iptvorg.channels.xml"), "utf8");
      assert.match(out, /site="z\.tv"[^>]*xmltv_id="X\.uk"[^>]*site_id="zx"/, out);
      assert.doesNotMatch(out, /site="a\.tv"/, out);
      const map = JSON.parse(fs.readFileSync(path.join(dir, "iptvorg.channels.json"), "utf8"));
      assert.deepEqual(map.stats.perSite, { "z.tv": 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
