/**
 * Unit tests for the pure helpers in lib/epg-utils.mjs.
 * Zero dependencies — Node's built-in test runner: `npm test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractXmltv, jstToMs, normalizeName, parseXmltvChannels, unescapeXml, xmltvTime } from "../lib/epg-utils.mjs";

describe("xmltvTime", () => {
  it("applies a positive offset (JST wall clock -> UTC)", () => {
    // 09:30 at +0900 is 00:30 UTC.
    assert.equal(xmltvTime("20261112093000 +0900"), Date.UTC(2026, 10, 12, 0, 30, 0));
  });

  it("applies a negative offset", () => {
    // 09:30 at -0500 is 14:30 UTC.
    assert.equal(xmltvTime("20261112093000 -0500"), Date.UTC(2026, 10, 12, 14, 30, 0));
  });

  it("treats a missing offset as UTC", () => {
    assert.equal(xmltvTime("20261112093000"), Date.UTC(2026, 10, 12, 9, 30, 0));
  });

  it("returns null for malformed input", () => {
    assert.equal(xmltvTime(""), null);
    assert.equal(xmltvTime("not a date"), null);
    assert.equal(xmltvTime("20261112"), null);
  });
});

describe("jstToMs", () => {
  it("converts a JST wall-clock string to epoch ms", () => {
    assert.equal(jstToMs("20261112093000"), Date.UTC(2026, 10, 12, 0, 30, 0));
  });

  it("accepts a numeric-looking value", () => {
    assert.equal(jstToMs(20261112093000), Date.UTC(2026, 10, 12, 0, 30, 0));
  });
});

describe("unescapeXml", () => {
  it("decodes named, decimal and hex entities, and trims", () => {
    assert.equal(unescapeXml("  A &lt; B &amp; C &gt; D  "), "A < B & C > D");
    assert.equal(unescapeXml("&quot;hi&quot; &apos;yo&apos;"), '"hi" \'yo\'');
    assert.equal(unescapeXml("&#65;&#x42;"), "AB");
  });

  it("decodes &amp; last, so double-encoded entities stay single-encoded", () => {
    assert.equal(unescapeXml("&amp;lt;"), "&lt;");
  });
});

describe("normalizeName", () => {
  it("strips quality suffixes, parentheticals and punctuation", () => {
    assert.equal(normalizeName("Sky Arts HD"), "skyarts");
    assert.equal(normalizeName("BBC One (1080p)"), "bbcone");
    assert.equal(normalizeName("QUEST+1"), "quest");
    assert.equal(normalizeName("TV9 KANNADA"), "tv9kannada");
  });

  it("keeps non-Latin letters, so similar CJK names stay distinct", () => {
    assert.notEqual(normalizeName("NHK東京総合"), normalizeName("NHK東京教育"));
    assert.equal(normalizeName("日本テレビ"), "日本テレビ");
  });
});

describe("parseXmltvChannels", () => {
  it("maps numeric epg.pw-style ids to display-names", () => {
    const xml = `<tv>
      <channel id="9121"><display-name lang="GB">Kanshi TV</display-name><icon src="" /></channel>
      <channel id="9122"><display-name lang="GB">SkyPremiereHD</display-name></channel>
    </tv>`;
    assert.deepEqual(
      [...parseXmltvChannels(xml)],
      [["9121", "Kanshi TV"], ["9122", "SkyPremiereHD"]],
    );
  });

  it("skips channels without a display-name and keeps the first of duplicates", () => {
    const xml = `<tv>
      <channel id="1"><icon src="" /></channel>
      <channel id="2"><display-name>A</display-name></channel>
      <channel id="2"><display-name>B</display-name></channel>
    </tv>`;
    assert.deepEqual([...parseXmltvChannels(xml)], [["2", "A"]]);
  });
});

describe("extractXmltv", () => {
  const WIN_START = Date.UTC(2026, 10, 12, 0, 0, 0);
  const WIN_END = Date.UTC(2026, 10, 12, 12, 0, 0);
  const xml = `<tv>
    <programme start="20261112010000 +0000" stop="20261112020000 +0000" channel="ChOne">
      <title>Morning News</title>
    </programme>
    <programme start="20261112020000 +0000" stop="20261112030000 +0000" channel="ChOne">
      <title>Fish &amp; Chips</title>
    </programme>
    <programme start="20261111220000 +0000" stop="20261111230000 +0000" channel="ChOne">
      <title>Too Early</title>
    </programme>
    <programme start="20261112130000 +0000" stop="20261112140000 +0000" channel="ChOne">
      <title>Too Late</title>
    </programme>
    <programme start="20261112010000 +0000" stop="20261112020000 +0000" channel="ChTwo">
      <title>Other Channel</title>
    </programme>
    <programme start="20261112010000 +0000" stop="20261112020000 +0000" channel="ChOne">
    </programme>
  </tv>`;

  it("extracts wanted channels, trims to the window, skips the rest", () => {
    const out = {};
    extractXmltv(xml, new Map([["ChOne", "catalog-1"]]), out, WIN_START, WIN_END);
    assert.deepEqual(Object.keys(out), ["catalog-1"]);
    assert.equal(out["catalog-1"].length, 2);
    assert.deepEqual(out["catalog-1"][0], [Date.UTC(2026, 10, 12, 1, 0, 0), Date.UTC(2026, 10, 12, 2, 0, 0), "Morning News"]);
    // Entities in titles are decoded.
    assert.equal(out["catalog-1"][1][2], "Fish & Chips");
  });

  it("ignores channels that are not wanted", () => {
    const out = {};
    extractXmltv(xml, new Map([["ChTwo", "catalog-2"]]), out, WIN_START, WIN_END);
    assert.deepEqual(out["catalog-2"].map((p) => p[2]), ["Other Channel"]);
  });

  it("skips programmes with unparseable times", () => {
    const bad = `<tv><programme start="garbage" stop="20261112020000 +0000" channel="X"><title>Nope</title></programme></tv>`;
    const out = {};
    extractXmltv(bad, new Map([["X", "c"]]), out, WIN_START, WIN_END);
    assert.deepEqual(out, {});
  });
});
