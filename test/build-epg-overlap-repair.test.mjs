/**
 * Black-box tests for the overlap repair's shapes: the 24h container,
 * same-start pairs, exact duplicates, and two interleaved schedules
 * seen in the real guide data. The canonical overlapping-pair and
 * back-to-back cases live in test/build-epg-enew.test.mjs.
 *
 * Runs the real build-epg.mjs in a staged temp dir
 * (test/staged-build.mjs) with the routing fetch stub serving an iptvx
 * feed. Before the repair, every case here failed the gate and kept
 * the previous epg.json; after it, the gate passes and epg.json is
 * written with 0 overlaps.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readText, removeDir, ROUTING_FETCH_STUB, runBuild, stageBuild } from "./staged-build.mjs";

const IPTVX_URL = "https://iptvx.one/epg/epg_noarch.xml.gz";

const stage = (programmes) =>
  stageBuild({
    matches: { "Dup.uk": { site: "epg.iptvx.one", site_id: "d1", xmltv_id: "Dup.uk" } },
    stub: ROUTING_FETCH_STUB,
    routes: { [IPTVX_URL]: { gzip: true, programmes } },
    previousEpg: "PREVIOUS-GOOD",
  });

const shipped = (dir) => JSON.parse(readText(dir, "epg.json")).channels["Dup.uk"];

describe("build-epg.mjs overlap repair shapes", () => {
  it("a 24h container is clipped to the first short programme; the shorts are intact", async () => {
    const dir = stage([
      { channel: "d1", startH: -2, stopH: 15, title: "All day" },
      { channel: "d1", startH: -1, stopH: 0, title: "S1" },
      { channel: "d1", startH: 0, stopH: 1, title: "S2" },
      { channel: "d1", startH: 1, stopH: 2, title: "S3" },
    ]);
    try {
      const { code, report } = await runBuild(dir);
      assert.equal(report.gate.pass, true, JSON.stringify(report.gate));
      assert.equal(code, 0);
      assert.equal(report.scan.overlaps, 0);
      assert.equal(report.repair.clipped, 1);
      assert.equal(report.repair.dropped, 0);
      const list = shipped(dir);
      assert.equal(list.length, 4);
      assert.deepEqual(list.map((p) => p[2]), ["All day", "S1", "S2", "S3"]);
      assert.equal(list[0][1], list[1][0]); // container ends when S1 starts
      assert.equal(list[1][1], list[2][0]);
      assert.equal(list[2][1], list[3][0]);
    } finally {
      removeDir(dir);
    }
  });

  it("same-start pair: the longer programme wins, the shorter is dropped and counted", async () => {
    const dir = stage([
      { channel: "d1", startH: -1, stopH: 1, title: "Long" },
      { channel: "d1", startH: -1, stopH: 0, title: "Filler" }, // same start, shorter
    ]);
    try {
      const { code, report } = await runBuild(dir);
      assert.equal(report.gate.pass, true, JSON.stringify(report.gate));
      assert.equal(code, 0);
      assert.equal(report.scan.overlaps, 0);
      assert.equal(report.repair.clipped, 0);
      assert.equal(report.repair.dropped, 1);
      assert.deepEqual(report.repair.perChannel, { "Dup.uk": 1 });
      const list = shipped(dir);
      assert.equal(list.length, 1);
      assert.equal(list[0][2], "Long");
    } finally {
      removeDir(dir);
    }
  });

  it("an exact duplicate is dropped and counted", async () => {
    const dir = stage([
      { channel: "d1", startH: -1, stopH: 1, title: "A" },
      { channel: "d1", startH: -1, stopH: 1, title: "A" },
    ]);
    try {
      const { code, report } = await runBuild(dir);
      assert.equal(report.gate.pass, true, JSON.stringify(report.gate));
      assert.equal(code, 0);
      assert.equal(report.scan.overlaps, 0);
      assert.equal(report.repair.dropped, 1);
      assert.equal(shipped(dir).length, 1);
    } finally {
      removeDir(dir);
    }
  });

  it("two interleaved schedules are clipped into one consecutive schedule", async () => {
    const dir = stage([
      { channel: "d1", startH: -2, stopH: -1, title: "a1" },
      { channel: "d1", startH: -1, stopH: 0, title: "a2" },
      { channel: "d1", startH: -1.5, stopH: -0.5, title: "b1" },
      { channel: "d1", startH: -0.5, stopH: 0.5, title: "b2" },
    ]);
    try {
      const { code, report } = await runBuild(dir);
      assert.equal(report.gate.pass, true, JSON.stringify(report.gate));
      assert.equal(code, 0);
      assert.equal(report.scan.overlaps, 0);
      assert.equal(report.repair.clipped, 3);
      assert.equal(report.repair.dropped, 0);
      const list = shipped(dir);
      assert.equal(list.length, 4);
      assert.deepEqual(list.map((p) => p[2]), ["a1", "b1", "a2", "b2"]);
      for (let i = 0; i < list.length - 1; i++) assert.equal(list[i][1], list[i + 1][0]);
    } finally {
      removeDir(dir);
    }
  });
});
