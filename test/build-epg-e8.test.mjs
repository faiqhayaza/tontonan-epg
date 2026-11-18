/**
 * Black-box tests for E8: the iptvorg adapter's file reads split
 * "missing" (ENOENT, a quiet skip) from "unreadable" (EACCES, EISDIR,
 * ...: an error, worded "could not be read") — for the guide file as
 * well as the channels file, and a read error is never called a parse
 * error. EISDIR (the path is a directory) stands in for EACCES: it is
 * a non-ENOENT read error on every platform, while chmod-based EACCES
 * does not work on Windows or as root.
 *
 * Runs the real build-epg.mjs in a staged temp dir (test/staged-build.mjs)
 * with a fetch stub that 404s everything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { removeDir, runBuild, stageBuild } from "./staged-build.mjs";

const VALID_MATCHES = { "A.uk": { site: "i.mjh.nz", site_id: "UK/all#bbc", xmltv_id: "A.uk" } };

const stage = () => stageBuild({ matches: VALID_MATCHES, previousReport: { channelsWithData: 3000 }, previousEpg: "PREVIOUS-GOOD" });

const iptvorgReport = async (dir) => (await runBuild(dir)).report.adapters.iptvorg;

describe("build-epg.mjs iptvorg read errors (E8)", () => {
  it("reports an unreadable guide file as a read error, not a skip", async () => {
    const dir = stage();
    try {
      fs.writeFileSync(path.join(dir, "iptvorg.channels.json"), JSON.stringify({ channels: {} }));
      fs.mkdirSync(path.join(dir, "iptvorg-guide.xml")); // reading it fails with EISDIR
      const r = await iptvorgReport(dir);
      assert.equal(r.skipped, undefined, `reported as a skip: ${r.skipped}`);
      assert.match(r.error, /^iptvorg-guide\.xml could not be read: .*EISDIR/);
    } finally {
      removeDir(dir);
    }
  });

  it("reports an unreadable channels file as a read error, not a parse error", async () => {
    const dir = stage();
    try {
      fs.mkdirSync(path.join(dir, "iptvorg.channels.json"));
      const r = await iptvorgReport(dir);
      assert.equal(r.skipped, undefined);
      assert.match(r.error, /^iptvorg\.channels\.json could not be read: .*EISDIR/);
      assert.doesNotMatch(r.error, /parsed/);
    } finally {
      removeDir(dir);
    }
  });

  it("still names a corrupt channels file a parse error", async () => {
    const dir = stage();
    try {
      fs.writeFileSync(path.join(dir, "iptvorg.channels.json"), "{corrupt");
      const r = await iptvorgReport(dir);
      assert.match(r.error, /^iptvorg\.channels\.json could not be parsed: /);
    } finally {
      removeDir(dir);
    }
  });
});
