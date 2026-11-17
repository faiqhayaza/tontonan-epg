/**
 * Unit tests for lib/catalog.mjs: the shared catalog indexes and the
 * guide-id matchers that epgshare, epgbest and epg.pw used to inline
 * (in three diverging copies).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baseOf,
  buildCatalogIndexes,
  buildCountryNameIndex,
  ccOf,
  matchEpgpwNames,
  parseCatalog,
  resolveGuideId,
  stripId,
} from "../lib/catalog.mjs";

const CHANNELS = [
  { id: "SkyOne.uk@HD", name: "Sky One", countryCode: "GB" },
  { id: "SkyOne.uk@SD", name: "Sky One", countryCode: "GB" },
  { id: "MBC1.ae", name: "MBC 1", countryCode: "AE" },
  { id: "MBC.1.ae", name: "MBC 1", countryCode: "AE" },
  { id: "NHK.jp", name: "NHK World", countryCode: "JP" },
];

describe("baseOf / ccOf / stripId", () => {
  it("strips @feed suffixes; ccOf matches before @ too", () => {
    assert.equal(baseOf("SkyOne.uk@HD"), "SkyOne.uk");
    assert.equal(baseOf("SkyOne.uk"), "SkyOne.uk");
    assert.equal(ccOf("SkyOne.uk"), "uk");
    // The builder's old regex missed this; the script's caught it.
    // The unified copy must catch it.
    assert.equal(ccOf("SkyOne.uk@HD"), "uk");
    assert.equal(ccOf("SkyOne"), null);
    assert.equal(ccOf("SkyOne.USA"), null);
    assert.equal(ccOf("SkyOne.UK"), "uk");
    assert.equal(stripId("MBC.1.ae"), "mbc1ae");
  });
});

describe("parseCatalog", () => {
  it("parses valid JSON and rejects the rest with a readable error", () => {
    assert.equal(parseCatalog('{"channels": [], "generatedAt": 0}').channels.length, 0);
    assert.throws(() => parseCatalog("{nope"), /catalog\.json is not valid JSON/);
    assert.throws(() => parseCatalog('{"channels": {}}'), /no channels array/);
    assert.throws(() => parseCatalog("null"), /no channels array/);
  });
});

describe("resolveGuideId", () => {
  const idx = buildCatalogIndexes(CHANNELS);

  it("matches exact, then @feed-stripped, then case-insensitive", () => {
    assert.equal(resolveGuideId("MBC1.ae", idx), "MBC1.ae");
    assert.equal(resolveGuideId("SkyOne.uk@HD", idx), "SkyOne.uk");
    assert.equal(resolveGuideId("mbc1.ae", idx), "MBC1.ae");
    assert.equal(resolveGuideId("skyone.uk@hd", idx), "SkyOne.uk");
  });

  it("accepts a unique punctuation-stripped match of 4+ chars", () => {
    // "M.B.C.1.ae" strips to "mbc1ae"; the catalog has two bases that
    // strip to it ("MBC1.ae" and "MBC.1.ae") — ambiguous, rejected.
    assert.equal(resolveGuideId("M.B.C.1.ae", idx), null);
    // "N.H.K.jp" strips to "nhkjp" (5 chars), unique on the catalog side.
    assert.equal(resolveGuideId("N.H.K.jp", idx), "NHK.jp");
  });

  it("rejects stripped matches under 4 chars, and country disagreement", () => {
    assert.equal(resolveGuideId("N.H.K", idx), null); // strips to "nhk", 3 chars
    // Stripped forms equal ("nhkjphd") but the country codes disagree
    // (guide .jp before the @feed suffix, catalog .hd at the end).
    const idx2 = {
      byBase: new Map([["NHKJP.HD", ["NHKJP.HD"]]]),
      byLower: new Map([["nhkjp.hd", "NHKJP.HD"]]),
      stripCount: new Map([["nhkjphd", 1]]),
      byStrip: new Map([["nhkjphd", "NHKJP.HD"]]),
    };
    assert.equal(resolveGuideId("NHK.jp@HD", idx2), null);
    assert.equal(resolveGuideId("NHKJP.HD", idx2), "NHKJP.HD");
  });

  it("requires guide-side uniqueness when a guide strip count is given", () => {
    const guideStripCount = new Map([["nhkjp", 2]]);
    assert.equal(resolveGuideId("N.H.K.jp", idx, { guideStripCount }), null);
    assert.equal(resolveGuideId("N.H.K.jp", idx, { guideStripCount: new Map([["nhkjp", 1]]) }), "NHK.jp");
  });

  it("epgbest (allowStripped: false) uses only the first layers (N4)", () => {
    assert.equal(resolveGuideId("SkyOne.uk@HD", idx, { allowStripped: false }), "SkyOne.uk");
    assert.equal(resolveGuideId("N.H.K.jp", idx, { allowStripped: false }), null);
    assert.equal(resolveGuideId("Nope.zz", idx), null);
  });
});

describe("buildCountryNameIndex / matchEpgpwNames", () => {
  const names = buildCountryNameIndex(CHANNELS);

  it("matches only unique uncovered names in-country", () => {
    const guideAe = new Map([
      ["101", "MBC 1"], // two catalog channels share the name in AE -> ambiguous
    ]);
    const wanted = matchEpgpwNames(guideAe, names.get("AE") ?? new Map(), () => false);
    assert.deepEqual([...wanted], []);
    const guideGb = new Map([
      ["103", "Sky One"], // two feeds, same name, same country -> ambiguous
    ]);
    assert.deepEqual([...matchEpgpwNames(guideGb, names.get("GB"), () => false)], []);
    const wantedJp = matchEpgpwNames(new Map([["102", "NHK World"]]), names.get("JP"), () => false);
    assert.deepEqual([...wantedJp], [["102", "NHK.jp"]]);
  });

  it("does not let a covered channel steal a unique match", () => {
    // "MBC 1" is ambiguous in AE only because two catalog rows share
    // it; if one is already covered, the other becomes the unique match.
    const guide = new Map([["101", "MBC 1"]]);
    const wanted = matchEpgpwNames(guide, names.get("AE"), (cid) => cid === "MBC.1.ae");
    assert.deepEqual([...wanted], [["101", "MBC1.ae"]]);
  });

  it("skips short names in the index", () => {
    const idx = buildCountryNameIndex([{ id: "ABC.us", name: "ABC", countryCode: "US" }]);
    assert.equal(idx.get("US")?.size ?? 0, 0);
  });
});
