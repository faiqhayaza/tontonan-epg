/**
 * E11 (iptvorg-channels.mjs half): F6 behaviour that had no test.
 *   - a corrupt epg.json / matches.json makes the script exit non-zero
 *     (loadJsonOrEmpty rethrows anything but ENOENT) and write nothing;
 *     silently treating it as empty would fill the grab list with
 *     already-covered channels
 *   - a catalog fetch that times out is retried once (fetchBuf's
 *     transient-retry policy, via lib/catalog.mjs loadCatalog) and then
 *     fails the script loudly, writing nothing
 *
 * Black box in a staged temp dir; the catalog-timeout case preloads a
 * fetch stub (--import) that fails every request the way an expired
 * abort signal does — with an AbortError, only when a signal was
 * passed — so no real 60 s timeout has to elapse.
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

const TIMEOUT_STUB = `import fs from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  fs.appendFileSync(process.env.STUB_LOG, String(url) + "\\n");
  if (!(init.signal instanceof AbortSignal)) await new Promise(() => setInterval(() => {}, 1 << 30)); // no timeout: hang
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  throw e;
};
`;

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-e11-iptvorg-test-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(repoRoot, "scripts/iptvorg-channels.mjs"), path.join(dir, "scripts/iptvorg-channels.mjs"));
  for (const f of fs.readdirSync(path.join(repoRoot, "lib")))
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ channels: [{ id: "X.uk", name: "Ex", countryCode: "GB" }] }));
  fs.writeFileSync(path.join(dir, "epg.json"), JSON.stringify({ channels: {} }));
  fs.writeFileSync(path.join(dir, "matches.json"), "{}");
  fs.mkdirSync(path.join(dir, "sites", "pluto.tv"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sites", "pluto.tv", "p.channels.xml"), `<channels><channel site="pluto.tv" site_id="x" xmltv_id="X.uk">Ex</channel></channels>`);
  fs.writeFileSync(path.join(dir, "fetch-stub.mjs"), TIMEOUT_STUB);
  return dir;
}

const wroteNothing = (dir) => !fs.existsSync(path.join(dir, "iptvorg.channels.xml")) && !fs.existsSync(path.join(dir, "iptvorg.channels.json"));

describe("E11: iptvorg-channels.mjs failure paths", () => {
  it("the fixture builds a list when nothing is corrupt (control)", async () => {
    const dir = stage();
    try {
      await run(process.execPath, ["scripts/iptvorg-channels.mjs", "--catalog", "catalog.json", "--sites", "sites"], { cwd: dir });
      assert.ok(!wroteNothing(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const file of ["epg.json", "matches.json"]) {
    it(`exits non-zero on a corrupt ${file} and writes nothing`, async () => {
      const dir = stage();
      try {
        fs.writeFileSync(path.join(dir, file), "{corrupt");
        await assert.rejects(run(process.execPath, ["scripts/iptvorg-channels.mjs", "--catalog", "catalog.json", "--sites", "sites"], { cwd: dir }), (e) => {
          assert.notEqual(e.code, 0);
          assert.match(String(e.stderr), /SyntaxError/);
          return true;
        });
        assert.ok(wroteNothing(dir), "output written despite a corrupt input");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("retries a timed-out catalog fetch once, then fails without writing", async () => {
    const dir = stage();
    try {
      const log = path.join(dir, "requests.log");
      await assert.rejects(
        run(process.execPath, ["--import", "./fetch-stub.mjs", "scripts/iptvorg-channels.mjs", "--sites", "sites"], {
          cwd: dir,
          env: { ...process.env, STUB_LOG: log },
          timeout: 30_000,
        }),
        (e) => {
          assert.equal(e.killed ?? false, false, "the script hung (no timeout signal on the catalog fetch)");
          assert.notEqual(e.code, 0);
          assert.match(String(e.stderr), /abort/i);
          return true;
        },
      );
      const reqs = fs.readFileSync(log, "utf8").trim().split("\n");
      assert.deepEqual(reqs, ["https://oracle-relay.faiqhayaza.com/catalog.json", "https://oracle-relay.faiqhayaza.com/catalog.json"], "expected exactly one retry");
      assert.ok(wroteNothing(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
