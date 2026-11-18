/**
 * lib/iptvorg.mjs parseEntries reads each attribute by its own name
 * only: an attribute whose name ends in the same letters (`website=`,
 * `xml:lang=`), or an earlier attribute's value that itself contains a
 * quoted `name='...'`, must not be read in its place. The same boundary
 * rule as the XMLTV attribute regexes in lib/epg-utils.mjs
 * (test/epg-utils-e7.test.mjs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEntries } from "../lib/iptvorg.mjs";

describe("parseEntries attribute boundaries", () => {
  it("reads site and lang, not website= / xml:lang= listed before them", () => {
    const xml = `<channels><channel website="https://x.example" xml:lang="fr" site="real.tv" lang="de" xmltv_id="B.de" site_id="b">B</channel></channels>`;
    assert.deepEqual(parseEntries(xml), [{ site: "real.tv", site_id: "b", lang: "de", xmltv_id: "B.de", name: "B" }]);
  });

  it("reads xmltv_id, not a quoted xmltv_id='...' inside an earlier value", () => {
    const xml = `<channels><channel site="real.tv" site_id="q?xmltv_id='Wrong.uk'" xmltv_id="Right.uk">C</channel></channels>`;
    const [e] = parseEntries(xml);
    assert.equal(e.xmltv_id, "Right.uk");
    assert.equal(e.site_id, "q?xmltv_id='Wrong.uk'");
  });
});
