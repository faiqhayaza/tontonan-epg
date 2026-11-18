/**
 * O-E6: code and docs name no person (decisions are attributed to a
 * role — "the repo owner" — not a name), and build-epg.mjs's header
 * carries no hardcoded iptvx channel count that goes stale (the live
 * count is report.iptvx.channels). LICENSE is excluded: a copyright
 * line names its holder by design. Source text on purpose: the claim
 * under test is about the text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const files = [
  "build-epg.mjs",
  "README.md",
  ...fs.readdirSync(path.join(repoRoot, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`),
  ...fs.readdirSync(path.join(repoRoot, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => `scripts/${f}`),
];

describe("O-E6: no personal names, no stale hardcoded count", () => {
  it("no file names a person", () => {
    // "faiqhayaza" in URLs/hosts is an account name, not prose; the
    // word-bounded, capitalised name is what O-E6 removed.
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, f), "utf8"), /\bFaiq\b/, f);
  });

  it("the build header carries no hardcoded iptvx channel count", () => {
    const header = fs.readFileSync(path.join(repoRoot, "build-epg.mjs"), "utf8").split("*/")[0];
    assert.doesNotMatch(header, /\(\d[\d,]* channels\)/);
  });
});
