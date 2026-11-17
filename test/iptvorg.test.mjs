/**
 * Unit tests for lib/iptvorg.mjs: the iptv-org grab-list matching,
 * dedup and cap logic that used to live untested in the script.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
import {
  buildCatByBase,
  buildNameIndex,
  buildUncovered,
  dedupEntries,
  matchEntry,
  parseEntries,
  parseMaxChannels,
  pickChannels,
} from "../lib/iptvorg.mjs";

describe("parseEntries", () => {
  it("parses attributes in any order, defaults lang to en, trims names", () => {
    const xml = `<channels>
      <channel site="pluto.tv" site_id="abc" lang="fr" xmltv_id="PlutoOne.fr">Pluto One</channel>
      <channel xmltv_id="X.uk" site_id="z9" site="xumo">  Xumo X  </channel>
      <channel site="a" site_id="b">No Xmltv Id</channel>
    </channels>`;
    assert.deepEqual(parseEntries(xml), [
      { site: "pluto.tv", site_id: "abc", lang: "fr", xmltv_id: "PlutoOne.fr", name: "Pluto One" },
      { site: "xumo", site_id: "z9", lang: "en", xmltv_id: "X.uk", name: "Xumo X" },
      { site: "a", site_id: "b", lang: "en", xmltv_id: "", name: "No Xmltv Id" },
    ]);
  });

  it("reads single-quoted attributes too (N14)", () => {
    const xml = `<channels><channel site='pluto.tv' site_id='abc' xmltv_id='P.fr'>Pluto</channel></channels>`;
    assert.deepEqual(parseEntries(xml), [{ site: "pluto.tv", site_id: "abc", lang: "en", xmltv_id: "P.fr", name: "Pluto" }]);
  });
});

describe("parseMaxChannels", () => {
  it("accepts 0 and positives, rejects negatives and junk (N7)", () => {
    assert.equal(parseMaxChannels("2500"), 2500);
    assert.equal(parseMaxChannels("0"), 0);
    assert.throws(() => parseMaxChannels("-1"), /whole number >= 0/);
    assert.throws(() => parseMaxChannels("abc"), /whole number >= 0/);
    assert.throws(() => parseMaxChannels("2.5"), /whole number >= 0/);
  });
});

const CHANNELS = [
  { id: "BBCOne.uk@HD", name: "BBC One", countryCode: "GB" },
  { id: "BBCOne.uk@SD", name: "BBC One", countryCode: "GB" },
  { id: "PlutoOne.fr", name: "Pluto One", countryCode: "FR" },
  { id: "XumoX.us", name: "Xumo X", countryCode: "US" },
  { id: "Covered.de", name: "Covered", countryCode: "DE" },
  { id: "Matched.jp", name: "Matched", countryCode: "JP" },
];

function setup() {
  const catByBase = buildCatByBase(CHANNELS);
  const covered = new Set(["Covered.de"]);
  const matchedIds = new Set(["Matched.jp"]);
  const uncovered = buildUncovered(catByBase, covered, matchedIds);
  return { catByBase, uncovered, byName: buildNameIndex(uncovered) };
}

describe("buildUncovered", () => {
  it("excludes covered and adapter-matched bases, keeps the rest", () => {
    const { uncovered } = setup();
    assert.deepEqual([...uncovered.keys()].sort(), ["BBCOne.uk", "PlutoOne.fr", "XumoX.us"]);
  });

  it("excludes a base when ANY of its feeds is covered", () => {
    const { catByBase } = setup();
    const uncovered = buildUncovered(catByBase, new Set(["BBCOne.uk@SD"]), new Set());
    assert.ok(!uncovered.has("BBCOne.uk"));
  });
});

describe("matchEntry", () => {
  it("matches by xmltv_id base first", () => {
    const { uncovered, byName } = setup();
    assert.deepEqual(
      matchEntry({ xmltv_id: "BBCOne.uk@ChannelIslandsHD", name: "Whatever" }, uncovered, byName),
      { kind: "id", xmltv_id: "BBCOne.uk" },
    );
  });

  it("falls back to a unique name match, filtered by country", () => {
    const { uncovered, byName } = setup();
    assert.deepEqual(matchEntry({ xmltv_id: "", name: "Pluto One" }, uncovered, byName), { kind: "name", xmltv_id: "PlutoOne.fr" });
    // Same name but the site says the channel is German: no match.
    assert.equal(matchEntry({ xmltv_id: "PlutoOne.de", name: "Pluto One" }, uncovered, byName), null);
    // No country on the site side: the unique name still matches.
    assert.deepEqual(matchEntry({ xmltv_id: "", name: "Xumo X" }, uncovered, byName), { kind: "name", xmltv_id: "XumoX.us" });
  });

  it("rejects an ambiguous name", () => {
    const { uncovered, byName } = setup();
    // "BBC One" names two uncovered feeds of one base — but the base
    // is one entry, so the name index has two rows for it (HD + SD):
    // hit.length is 2, so no match by name. (The id layer finds it.)
    assert.equal(matchEntry({ xmltv_id: "", name: "BBC One" }, uncovered, byName), null);
    assert.equal(matchEntry({ xmltv_id: "", name: "No Such Channel" }, uncovered, byName), null);
  });
});

describe("iptvorg-channels.mjs end to end (black box)", () => {
  it("builds the grab list from fixture inputs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-iptvorg-test-"));
    try {
      const repoRoot = new URL("..", import.meta.url).pathname;
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.mkdirSync(path.join(dir, "lib"));
      fs.copyFileSync(path.join(repoRoot, "scripts/iptvorg-channels.mjs"), path.join(dir, "scripts/iptvorg-channels.mjs"));
      for (const f of ["fetch.mjs", "catalog.mjs", "epg-utils.mjs", "iptvorg.mjs"])
        fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
      fs.writeFileSync(
        path.join(dir, "catalog.json"),
        JSON.stringify({
          generatedAt: 0,
          channels: [
            { id: "BBCOne.uk@HD", name: "BBC One", countryCode: "GB" },
            { id: "PlutoOne.fr", name: "Pluto One", countryCode: "FR" },
            { id: "Covered.de", name: "Covered", countryCode: "DE" },
          ],
        }),
      );
      fs.writeFileSync(path.join(dir, "epg.json"), JSON.stringify({ channels: { "Covered.de": [] } }));
      fs.writeFileSync(path.join(dir, "matches.json"), JSON.stringify({}));
      fs.mkdirSync(path.join(dir, "sites", "pluto.tv"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "sites", "pluto.tv", "pluto.tv.channels.xml"),
        `<channels>
          <channel site="pluto.tv" site_id="a1" lang="en" xmltv_id="BBCOne.uk@HD">BBC One</channel>
          <channel site="pluto.tv" site_id="a2" lang="en" xmltv_id="">Pluto One</channel>
          <channel site="pluto.tv" site_id="a3" lang="en" xmltv_id="">Covered</channel>
        </channels>`,
      );
      const { stdout } = await run(process.execPath, ["scripts/iptvorg-channels.mjs", "--catalog", "catalog.json", "--sites", "sites"], { cwd: dir });
      assert.match(stdout, /2 channels \(1 id matches, 1 name matches; cap 2500\)/);
      const out = fs.readFileSync(path.join(dir, "iptvorg.channels.xml"), "utf8");
      assert.ok(out.includes('xmltv_id="BBCOne.uk"'));
      assert.ok(out.includes('xmltv_id="PlutoOne.fr"'));
      assert.ok(!out.includes("Covered"));
      const map = JSON.parse(fs.readFileSync(path.join(dir, "iptvorg.channels.json"), "utf8"));
      assert.deepEqual(map.channels, { "BBCOne.uk": "BBCOne.uk@HD", "PlutoOne.fr": "PlutoOne.fr" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dedupEntries / pickChannels", () => {
  const yieldMap = new Map([
    ["pluto.tv", { id: 10, name: 5 }],
    ["xumo", { id: 1, name: 1 }],
  ]);
  const a = { site: "pluto.tv", site_id: "1", xmltv_id: "A.uk", name: "A" };
  const aDupSite = { site: "pluto.tv", site_id: "1", xmltv_id: "B.uk", name: "B" };
  const aDupBase = { site: "xumo", site_id: "2", xmltv_id: "A.uk", name: "A" };
  const b = { site: "xumo", site_id: "3", xmltv_id: "B.uk", name: "B" };

  it("keeps the first per base and per (site, site_id), yield order first", () => {
    const out = dedupEntries([b, aDupBase, a, aDupSite], yieldMap);
    assert.deepEqual(out.map((e) => e.xmltv_id), ["A.uk", "B.uk"]);
    assert.equal(out[0].site, "pluto.tv"); // higher yield wins the sort
  });

  it("picks id matches before name matches, dedups across lists, caps", () => {
    const id = [{ site: "pluto.tv", site_id: "1", xmltv_id: "A.uk", name: "A" }];
    const name = [
      { site: "xumo", site_id: "2", xmltv_id: "A.uk", name: "A" },
      { site: "xumo", site_id: "3", xmltv_id: "B.uk", name: "B" },
    ];
    assert.deepEqual(pickChannels(id, name, yieldMap, 10).map((e) => e.xmltv_id), ["A.uk", "B.uk"]);
    assert.deepEqual(pickChannels(id, name, yieldMap, 1).map((e) => e.xmltv_id), ["A.uk"]);
    assert.deepEqual(pickChannels(id, name, yieldMap, 0), []);
  });
});
