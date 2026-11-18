/**
 * E7: attribute regexes are anchored to an attribute boundary, so a
 * prefixed attribute that contains the name (XMLTV's vps-start /
 * pdc-start, any *-id) is never read in its place.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractXmltv, parseXmltvChannels, xmltvTime } from "../lib/epg-utils.mjs";

const WIN = [Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)];

describe("E7: prefixed attributes do not shadow start / stop / id", () => {
  it("reads start, not vps-start, when vps-start comes first", () => {
    const xml = `<tv><programme vps-start="20261118050000 +0000" start="20261118060000 +0000" stop="20261118070000 +0000" channel="c"><title>News</title></programme></tv>`;
    const out = {};
    extractXmltv(xml, new Map([["c", "C.uk"]]), out, ...WIN);
    assert.deepEqual(out["C.uk"], [[xmltvTime("20261118060000 +0000"), xmltvTime("20261118070000 +0000"), "News"]]);
  });

  it("reads start, not pdc-start, and stop, not a prefixed *-stop", () => {
    const xml = `<tv><programme pdc-start="20261118010000 +0000" x-stop="20261118020000 +0000" channel="c" start="20261118060000 +0000" stop="20261118070000 +0000"><title>T</title></programme></tv>`;
    const out = {};
    extractXmltv(xml, new Map([["c", "C.uk"]]), out, ...WIN);
    assert.deepEqual(out["C.uk"], [[xmltvTime("20261118060000 +0000"), xmltvTime("20261118070000 +0000"), "T"]]);
  });

  it("reads id, not a prefixed *-id, on a <channel>", () => {
    const xml = `<tv><channel tvg-id="wrong" id="right"><display-name>Right</display-name></channel></tv>`;
    assert.deepEqual([...parseXmltvChannels(xml)], [["right", "Right"]]);
  });
});
