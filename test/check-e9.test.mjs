/**
 * E9: `npm run check` (scripts/check.mjs) prints node's own syntax
 * diagnostic — file:line and the SyntaxError message — not just the
 * failing file's name.
 *
 * Black box: scripts/check.mjs runs in a staged temp tree (the layout
 * it scans: build-epg.mjs, lib/, scripts/, test/) where one test file
 * has a syntax error on line 2.
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

describe("E9: check.mjs reports the syntax error itself", () => {
  it("prints node's file:line + SyntaxError diagnostic and exits 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-e9-test-"));
    try {
      for (const d of ["lib", "scripts", "test"]) fs.mkdirSync(path.join(dir, d));
      fs.copyFileSync(path.join(repoRoot, "scripts/check.mjs"), path.join(dir, "scripts/check.mjs"));
      fs.writeFileSync(path.join(dir, "build-epg.mjs"), "export const ok = 1;\n");
      fs.writeFileSync(path.join(dir, "lib", "ok.mjs"), "export const ok = 1;\n");
      fs.writeFileSync(path.join(dir, "test", "bad.mjs"), "export const ok = 1;\nconst broken = ;\n");
      await assert.rejects(run(process.execPath, ["scripts/check.mjs"], { cwd: dir }), (e) => {
        assert.equal(e.code, 1);
        const err = String(e.stderr);
        assert.match(err, /node --check failed: test\/bad\.mjs/);
        assert.match(err, /bad\.mjs:2/, "file:line missing");
        assert.match(err, /SyntaxError: Unexpected token/, "the SyntaxError message is missing");
        return true;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
