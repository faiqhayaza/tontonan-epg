/**
 * E11 (regenerate-matches.mjs half): the non-dry-run prune path — the
 * write, the .bak backup, and the "byte-identical format" claim in the
 * script (2-space JSON with leading indentation stripped, no trailing
 * newline, so a re-serialise of an unpruned file reproduces it exactly
 * and a prune diff shows only the dropped entries). Only --dry-run was
 * tested before.
 *
 * Black box: the real script in a staged temp dir (no network needed:
 * --prune-orphans is offline).
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

/* The committed file's format, which the script claims to preserve. */
const fmt = (obj) => JSON.stringify(obj, null, 2).replace(/^ +/gm, "");

const FIXTURE = {
  "Keep.uk@HD": { site: "i.mjh.nz", site_id: "UK/all#keep", xmltv_id: "Keep.uk" },
  "Orphan.fr": { site: "example.com", site_id: "o1", xmltv_id: "Orphan.fr" },
  "Keep.us": { site: "epg.iptvx.one", site_id: "13-strt", xmltv_id: "Keep.us" },
};

function stage(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-e11-regen-test-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(repoRoot, "scripts/regenerate-matches.mjs"), path.join(dir, "scripts/regenerate-matches.mjs"));
  for (const f of fs.readdirSync(path.join(repoRoot, "lib")))
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "matches.json"), text);
  return dir;
}

describe("E11: regenerate-matches.mjs non-dry-run prune", () => {
  it("writes the pruned file in the committed format and backs up the original", async () => {
    const original = fmt(FIXTURE);
    const dir = stage(original);
    try {
      const { stdout } = await run(process.execPath, ["scripts/regenerate-matches.mjs", "--prune-orphans"], { cwd: dir });
      assert.match(stdout, /dropping 1 entries \(3 -> 2\)/);
      assert.match(stdout, /wrote matches\.json \(backup: matches\.json\.bak\)/);
      const written = fs.readFileSync(path.join(dir, "matches.json"), "utf8");
      const { "Orphan.fr": _dropped, ...kept } = FIXTURE;
      // Byte-for-byte the committed format of the kept entries, in order.
      assert.equal(written, fmt(kept));
      assert.ok(!written.endsWith("\n"), "trailing newline added");
      assert.doesNotMatch(written, /^ /m, "leading indentation kept");
      // The backup is the untouched original, byte for byte.
      assert.equal(fs.readFileSync(path.join(dir, "matches.json.bak"), "utf8"), original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the format is a fixed point: an unpruned file re-serialises byte-identically", async () => {
    // Prune an entry that is the LAST one: the rest of the file must be
    // exactly the original bytes minus that entry — the property that
    // keeps a prune's git diff to the dropped lines.
    const withTail = { ...FIXTURE, "Tail.fr": { site: "example.com", site_id: "t", xmltv_id: "Tail.fr" } };
    delete withTail["Orphan.fr"];
    const dir = stage(fmt(withTail));
    try {
      await run(process.execPath, ["scripts/regenerate-matches.mjs", "--prune-orphans"], { cwd: dir });
      const written = fs.readFileSync(path.join(dir, "matches.json"), "utf8");
      const original = fmt(withTail);
      const cut = original.lastIndexOf(',\n"Tail.fr"');
      assert.ok(cut > 0);
      assert.equal(written, original.slice(0, cut) + "\n}");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
