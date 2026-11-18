/**
 * O-E1: the README must not promise that build-report.json is "always
 * written" — a run killed by the job timeout writes nothing. It must
 * describe what actually holds: the report is written on every run that
 * reaches the end, a deadline build included, and name the deadline's
 * override (EPG_BUILD_DEADLINE_MS) — whose behaviour is pinned by
 * test/timeout-budget-e6.test.mjs. The README wording is checked
 * against the builder's actual default, read from build-epg.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("O-E1: README matches the report-writing behaviour", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const build = fs.readFileSync(path.join(repoRoot, "build-epg.mjs"), "utf8");

  it("does not claim the report is always written", () => {
    assert.doesNotMatch(readme.replace(/\s+/g, " "), /always written/i);
  });

  it("names the deadline, its override, and the one no-report case", () => {
    const flat = readme.replace(/\s+/g, " ");
    const m = /const BUILD_DEADLINE_MS = .*: (\d+) \* 60_000;/.exec(build);
    assert.ok(m, "build-epg.mjs defines BUILD_DEADLINE_MS");
    assert.ok(build.includes("process.env.EPG_BUILD_DEADLINE_MS"), "the override is read by the builder");
    assert.ok(flat.includes(`(${m[1]} minutes by default, \`EPG_BUILD_DEADLINE_MS\` to override`), "README states the real default + override");
    assert.match(flat, /written on every run that reaches the end of the build/);
    assert.match(flat, /The one case with no report is a run killed from outside/);
  });
});
