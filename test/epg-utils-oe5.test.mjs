/**
 * O-E5: unescapeXml decodes each entity exactly once. The old chain of
 * .replace() calls ran &amp; last, over the numeric step's output, so
 * an escaped "&amp;" ("&#38;amp;") came out as "&".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unescapeXml } from "../lib/epg-utils.mjs";

describe("O-E5: unescapeXml does not double-decode", () => {
  it("decodes a numeric & followed by amp; once", () => {
    assert.equal(unescapeXml("&#38;amp;"), "&amp;");
    assert.equal(unescapeXml("&#x26;amp;"), "&amp;");
    assert.equal(unescapeXml("&#38;lt;"), "&lt;");
  });

  it("decodes &amp;amp; and &amp;lt; once", () => {
    assert.equal(unescapeXml("&amp;amp;"), "&amp;");
    assert.equal(unescapeXml("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
  });

  it("still decodes every single entity and leaves invalid code points literal", () => {
    assert.equal(unescapeXml(" Tom &amp; Jerry &lt;3 &quot;x&quot; &apos;y&apos; &#233;&#xE9; "), `Tom & Jerry <3 "x" 'y' éé`);
    assert.equal(unescapeXml("&#0;&#x110000;"), "&#0;&#x110000;");
  });
});
