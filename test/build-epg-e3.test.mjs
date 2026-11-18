/**
 * Tests for the two-schedules-into-one-channel merge (E3).
 *
 * epgpw: "BBC One" and "BBC One HD" both normalize to "bbcone".
 * matchEpgpwNames checked uniqueness only on the CATALOG side, so both
 * guide ids mapped to the one catalog channel, and extractXmltv
 * appended both schedules into one programme list.
 * epgbest: "BBCOne.uk" and "BBCOne.uk@HD" both resolve to base
 * "BBCOne.uk"; with no claimed set, both mapped to the same cid.
 *
 * Unit part: matchEpgpwNames directly. Black-box part: the real
 * build-epg.mjs in a staged temp dir (test/staged-build.mjs), with the
 * routing fetch stub serving a catalog plus an epg.pw country file (or
 * an epg.best feed); asserts the catalog channel holds at most ONE
 * guide id's schedule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCountryNameIndex, CATALOG_MIRROR_URL, matchEpgpwNames } from "../lib/catalog.mjs";
import { removeDir, ROUTING_FETCH_STUB, runBuild, stageBuild } from "./staged-build.mjs";

const CATALOG = {
  channels: [
    { id: "BBCOne.uk", name: "BBC One", countryCode: "GB" },
    { id: "ITV1.uk", name: "ITV1", countryCode: "GB" },
  ],
};

// No build-report.json (no baseline) and no epg.json: the build writes
// epg.json when its gate passes.
const stage = (routes) => stageBuild({ stub: ROUTING_FETCH_STUB, routes: { [CATALOG_MIRROR_URL]: { json: CATALOG }, ...routes } });

async function build(dir, env = {}) {
  const { report } = await runBuild(dir, { env });
  const epgPath = path.join(dir, "epg.json");
  return { report, epg: fs.existsSync(epgPath) ? JSON.parse(fs.readFileSync(epgPath, "utf8")) : null };
}

/* Which guide ids' schedules (by title prefix) landed in a channel. */
const sourcesOf = (list, prefixes) => prefixes.filter((pre) => (list ?? []).some((p) => p[2].startsWith(pre)));

describe("matchEpgpwNames guide-side uniqueness (E3)", () => {
  it("two guide ids sharing one normalized name map neither; unique names still map", () => {
    const names = buildCountryNameIndex(CATALOG.channels).get("GB");
    const guide = new Map([
      ["101", "BBC One"],
      ["102", "BBC One HD"], // normalizes to "bbcone" too
      ["103", "ITV 1"],
    ]);
    const wanted = matchEpgpwNames(guide, names, () => false);
    const toBbc = [...wanted].filter(([, cid]) => cid === "BBCOne.uk").map(([gid]) => gid);
    assert.ok(toBbc.length <= 1, `BBCOne.uk mapped from ${toBbc.length} guide ids: ${toBbc.join(", ")}`);
    assert.deepEqual(toBbc, [], "an ambiguous guide-side name maps neither id");
    assert.equal(wanted.get("103"), "ITV1.uk");
  });
});

describe("build-epg.mjs keeps one upstream schedule per catalog channel (E3)", () => {
  it("epgpw: 'BBC One' + 'BBC One HD' never both land in BBCOne.uk", async () => {
    const dir = stage({
      "https://epg.pw/xmltv/epg_GB.xml.gz": {
        gzip: true,
        channels: [
          { id: "101", name: "BBC One" },
          { id: "102", name: "BBC One HD" },
          { id: "103", name: "ITV 1" },
        ],
        programmes: [
          { channel: "101", startH: -1, stopH: 1, title: "sd-news" },
          { channel: "101", startH: 1, stopH: 2, title: "sd-film" },
          { channel: "102", startH: -0.5, stopH: 1.5, title: "hd-quiz" },
          { channel: "102", startH: 1.5, stopH: 3, title: "hd-drama" },
          { channel: "103", startH: -1, stopH: 1, title: "itv-show" },
        ],
      },
    });
    try {
      const { report, epg } = await build(dir);
      assert.ok(epg, `epg.json written (gate ${JSON.stringify(report.gate)})`);
      const got = sourcesOf(epg.channels["BBCOne.uk"], ["sd-", "hd-"]);
      assert.ok(got.length <= 1, `BBCOne.uk holds ${got.length} upstream schedules (${got.join(", ")}): ${JSON.stringify(epg.channels["BBCOne.uk"])}`);
      assert.equal(epg.channels["ITV1.uk"]?.length, 1, "the unambiguous channel still maps");
    } finally {
      removeDir(dir);
    }
  });

  it("epgbest: 'BBCOne.uk' + 'BBCOne.uk@HD' never both land in BBCOne.uk", async () => {
    const feedUrl = "https://epg.best/feed?token=E3TEST";
    const dir = stage({
      [feedUrl]: {
        channels: [{ id: "BBCOne.uk" }, { id: "BBCOne.uk@HD" }, { id: "ITV1.uk" }],
        programmes: [
          { channel: "BBCOne.uk", startH: -1, stopH: 1, title: "first-news" },
          { channel: "BBCOne.uk@HD", startH: -0.5, stopH: 1.5, title: "second-quiz" },
          { channel: "ITV1.uk", startH: -1, stopH: 1, title: "itv-show" },
        ],
      },
    });
    try {
      const { report, epg } = await build(dir, { EPG_BEST_URL: feedUrl });
      assert.ok(epg, `epg.json written (gate ${JSON.stringify(report.gate)})`);
      const got = sourcesOf(epg.channels["BBCOne.uk"], ["first-", "second-"]);
      assert.deepEqual(got, ["first-"], `BBCOne.uk must hold only the first guide id's schedule: ${JSON.stringify(epg.channels["BBCOne.uk"])}`);
      assert.equal(epg.channels["ITV1.uk"]?.length, 1);
      assert.equal(report.adapters.epgbest.channels, 2);
    } finally {
      removeDir(dir);
    }
  });
});
