/**
 * Black-box tests for E4: both scripts load the catalog through
 * lib/catalog.mjs (fetchBuf + parseCatalog) instead of an inline
 * fetch() + r.json(), so a 200 with `{}` is refused instead of being
 * read as "no channels" — an empty grab list written silently
 * (iptvorg-channels.mjs) or an empty live set (regenerate-matches.mjs).
 * The mjh checks go through fetchBuf too.
 *
 * The scripts are top-level CLIs, so they run in a staged temp dir with
 * a fetch stub preloaded via --import (no real network). The stub
 * records every request (URL, whether an abort signal was passed, the
 * User-Agent) to STUB_LOG and answers with STUB_STATUS / STUB_BODY.
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

const FETCH_STUB = `import fs from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  const rec = { url: String(url), hasSignal: init.signal instanceof AbortSignal, ua: new Headers(init.headers ?? {}).get("user-agent") };
  if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(rec) + "\\n");
  return new Response(process.env.STUB_BODY ?? "{}", { status: Number(process.env.STUB_STATUS ?? 200) });
};
`;

const MATCHES = {
  "A.uk": { site: "i.mjh.nz", site_id: "UK/all#a", xmltv_id: "A.uk" },
  "B.uk": { site: "epg.iptvx.one", site_id: "1-b", xmltv_id: "B.uk" },
};

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-e4-test-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "lib"));
  for (const f of ["iptvorg-channels.mjs", "regenerate-matches.mjs"])
    fs.copyFileSync(path.join(repoRoot, "scripts", f), path.join(dir, "scripts", f));
  for (const f of fs.readdirSync(path.join(repoRoot, "lib")))
    fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
  fs.writeFileSync(path.join(dir, "matches.json"), JSON.stringify(MATCHES, null, 2));
  // A grabbable site, so a script that accepts the empty catalog gets
  // all the way to writing its (empty) output instead of dying early.
  fs.mkdirSync(path.join(dir, "sites", "pluto.tv"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sites", "pluto.tv", "pluto.tv.channels.xml"),
    `<channels><channel site="pluto.tv" site_id="a1" lang="en" xmltv_id="X.uk">X</channel></channels>`,
  );
  return dir;
}

function runIn(dir, script, args, env = {}) {
  return run(process.execPath, ["--import", "./fetch-stub.mjs", `scripts/${script}`, ...args], {
    cwd: dir,
    env: { ...process.env, STUB_LOG: path.join(dir, "stub.log"), ...env },
    timeout: 30_000,
  });
}

const readLog = (dir) =>
  fs.existsSync(path.join(dir, "stub.log"))
    ? fs.readFileSync(path.join(dir, "stub.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

describe("E4: scripts refuse a catalog with no channels array", () => {
  it("iptvorg-channels.mjs refuses a local {} catalog and writes nothing", async () => {
    const dir = stage();
    try {
      fs.writeFileSync(path.join(dir, "catalog.json"), "{}");
      await assert.rejects(runIn(dir, "iptvorg-channels.mjs", ["--catalog", "catalog.json", "--sites", "sites"]), (e) => {
        assert.notEqual(e.code, 0);
        assert.match(String(e.stderr), /no channels array/);
        return true;
      });
      assert.ok(!fs.existsSync(path.join(dir, "iptvorg.channels.xml")), "an empty grab list was written");
      assert.ok(!fs.existsSync(path.join(dir, "iptvorg.channels.json")), "an empty channel map was written");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("iptvorg-channels.mjs refuses a 200 {} from the mirror and writes nothing", async () => {
    const dir = stage();
    try {
      await assert.rejects(runIn(dir, "iptvorg-channels.mjs", ["--sites", "sites"], { STUB_BODY: "{}" }), (e) => {
        assert.match(String(e.stderr), /no channels array/);
        return true;
      });
      assert.ok(!fs.existsSync(path.join(dir, "iptvorg.channels.xml")), "an empty grab list was written");
      assert.ok(!fs.existsSync(path.join(dir, "iptvorg.channels.json")), "an empty channel map was written");
      // The fetch went through fetchBuf: mirror URL, abort signal, UA.
      const [req] = readLog(dir);
      assert.equal(req.url, "https://oracle-relay.faiqhayaza.com/catalog.json");
      assert.equal(req.hasSignal, true);
      assert.match(req.ua ?? "", /Mozilla\/5\.0/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regenerate-matches.mjs --prune-stale refuses a 200 {} instead of reading it as an empty live set", async () => {
    const dir = stage();
    try {
      const before = fs.readFileSync(path.join(dir, "matches.json"), "utf8");
      await assert.rejects(runIn(dir, "regenerate-matches.mjs", ["--prune-stale", "--dry-run"], { STUB_BODY: "{}" }), (e) => {
        assert.notEqual(e.code, 0);
        assert.match(String(e.stderr), /no channels array/);
        assert.doesNotMatch(String(e.stdout), /would drop/);
        return true;
      });
      assert.equal(fs.readFileSync(path.join(dir, "matches.json"), "utf8"), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regenerate-matches.mjs --verify-sources checks mjh paths through fetchBuf", async () => {
    const dir = stage();
    try {
      const { stdout } = await runIn(dir, "regenerate-matches.mjs", ["--verify-sources"], { STUB_STATUS: "404", STUB_BODY: "nope" });
      // fetchBuf's error text (status + URL), and the affected channel.
      assert.match(stdout, /FAIL UK\/all: HTTP 404 \(https:\/\/raw\.githubusercontent\.com\/matthuisman\/i\.mjh\.nz\/master\/UK\/all\.xml\) \(1 channels: A\.uk\)/);
      const reqs = readLog(dir);
      assert.equal(reqs.length, 1, "a 404 is not retried");
      assert.equal(reqs[0].hasSignal, true);
      assert.match(reqs[0].ua ?? "", /Mozilla\/5\.0/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
