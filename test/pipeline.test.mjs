/**
 * Unit tests for lib/pipeline.mjs: the failure gate, the mjh path/key
 * map, the myjcom response handling, and the guarded matches load —
 * the pipeline decisions that used to be verified only by watching
 * production builds.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMjhWanted, evaluateGate, extractMyjcomProgrammes, loadMatches, nextLastGood, OVERLAP_THRESHOLD, readGateBaseline, scanGateReasons, scanSchedules } from "../lib/pipeline.mjs";

describe("evaluateGate", () => {
  it("fails on zero channels even with no baseline", () => {
    const g = evaluateGate(0, null);
    assert.equal(g.pass, false);
    assert.deepEqual(g.reasons, ["no channels with data"]);
  });

  it("passes a healthy build", () => {
    assert.equal(evaluateGate(3025, 3030).pass, true);
    assert.equal(evaluateGate(100, null).pass, true);
  });

  it("fails on more than 25% down, passes on exactly 25% down", () => {
    // Boundary pinned: the rule is "more than 25%", so 2250 of 3000 passes.
    assert.equal(evaluateGate(2250, 3000).pass, true);
    const g = evaluateGate(2249, 3000);
    assert.equal(g.pass, false);
    // The baseline is the last build that passed the gate (E1), which is
    // not necessarily the previous build; the reason says so.
    assert.deepEqual(g.reasons, ["channelsWithData fell 3000 -> 2249 (more than 25% down vs the last build that passed the gate)"]);
    assert.equal(evaluateGate(1500, 3000).pass, false);
  });
});

describe("readGateBaseline / nextLastGood (E1)", () => {
  it("prefers lastGoodChannelsWithData, falls back to channelsWithData for old reports", () => {
    // A gated report: channelsWithData is the degraded count, the
    // baseline is the last good one.
    assert.equal(readGateBaseline('{"channelsWithData": 1000, "lastGoodChannelsWithData": 3000}'), 3000);
    // Pre-E1 report (no field): its channelsWithData.
    assert.equal(readGateBaseline('{"channelsWithData": 3067}'), 3067);
    // Field present but null/non-numeric: no known-good build yet; do
    // NOT fall back to the (possibly gated) channelsWithData.
    assert.equal(readGateBaseline('{"channelsWithData": 1000, "lastGoodChannelsWithData": null}'), null);
    assert.equal(readGateBaseline('{"channelsWithData": 1000, "lastGoodChannelsWithData": "3000"}'), null);
    // No count at all, missing / corrupt / non-object: null.
    assert.equal(readGateBaseline('{"gate": {}}'), null);
    assert.equal(readGateBaseline(""), null);
    assert.equal(readGateBaseline("{corrupt"), null);
    assert.equal(readGateBaseline("null"), null);
    assert.equal(readGateBaseline("[3000]"), null);
    assert.equal(readGateBaseline('{"channelsWithData": "3030"}'), null);
  });

  it("advances only on a passing gate, else carries the baseline forward", () => {
    assert.equal(nextLastGood(true, 2500, 3000), 2500);
    assert.equal(nextLastGood(false, 1000, 3000), 3000);
    assert.equal(nextLastGood(false, 1000, null), null);
    assert.equal(nextLastGood(true, 100, null), 100);
  });

  it("pure two-run sequence: 3000 -> 1000 gated, then 1000 again still gated", () => {
    let report = JSON.stringify({ channelsWithData: 3000 });
    for (const run of [1, 2]) {
      const baseline = readGateBaseline(report);
      const gate = evaluateGate(1000, baseline);
      assert.equal(gate.pass, false, `run ${run}`);
      report = JSON.stringify({ channelsWithData: 1000, lastGoodChannelsWithData: nextLastGood(gate.pass, 1000, baseline), gate });
    }
    assert.equal(JSON.parse(report).lastGoodChannelsWithData, 3000);
  });
});

describe("scanSchedules / scanGateReasons (E-new)", () => {
  const H = 3600_000;

  it("counts overlaps per channel, largest first; back-to-back is not an overlap", () => {
    const scan = scanSchedules({
      ok: [[0, H, "a"], [H, 2 * H, "b"]],
      one: [[0, 2 * H, "a"], [H, 3 * H, "b"]],
      // Two schedules appended into one list (unsorted input): every
      // programme of the second starts before the running max end.
      merged: [[0, H, "a1"], [H, 2 * H, "a2"], [H / 2, 3 * H / 2, "b1"], [3 * H / 2, 5 * H / 2, "b2"]],
    });
    // merged, in start order: a1 [0,1h], b1 [0.5h,1.5h], a2 [1h,2h],
    // b2 [1.5h,2.5h] — b1, a2 and b2 each start before the running max end.
    assert.equal(scan.overlaps, 4);
    assert.equal(scan.overlapChannels, 2);
    assert.equal(scan.zeroLength, 0);
    assert.deepEqual(Object.entries(scan.perChannel), [["merged", 3], ["one", 1]]);
    assert.deepEqual(scanGateReasons(scan), [`4 overlapping programmes across 2 channels (threshold ${OVERLAP_THRESHOLD})`]);
  });

  it("counts a duplicate slot as an overlap", () => {
    assert.equal(scanSchedules({ d: [[0, H, "x"], [0, H, "x"]] }).overlaps, 1);
  });

  it("counts zero-length, inverted and non-finite entries, and fails the gate on them", () => {
    const scan = scanSchedules({ z: [[0, 0, "zero"], [2 * H, H, "inverted"], [NaN, H, "nan"]], ok: [[0, H, "a"]] });
    assert.equal(scan.zeroLength, 3);
    assert.ok(scanGateReasons(scan).includes("3 zero-length or inverted programmes"));
  });

  it("a clean map yields no reasons, and the input is not mutated", () => {
    const list = [[H, 2 * H, "b"], [0, H, "a"]];
    const scan = scanSchedules({ c: list });
    assert.deepEqual(scan, { overlaps: 0, overlapChannels: 0, zeroLength: 0, perChannel: {} });
    assert.deepEqual(scanGateReasons(scan), []);
    assert.deepEqual(list[0], [H, 2 * H, "b"]);
    assert.deepEqual(scanSchedules({}), { overlaps: 0, overlapChannels: 0, zeroLength: 0, perChannel: {} });
  });
});

describe("loadMatches", () => {
  it("parses a valid file and reports a corrupt one instead of throwing", () => {
    const { matches, error } = loadMatches('{"A.uk": {"site": "i.mjh.nz", "site_id": "x", "xmltv_id": "A"}}');
    assert.equal(error, null);
    assert.deepEqual(Object.keys(matches), ["A.uk"]);
    assert.match(loadMatches("{corrupt").error, /not valid JSON/);
    assert.match(loadMatches("null").error, /not an object/);
    assert.match(loadMatches("[1, 2]").error, /not an object/);
    assert.deepEqual(loadMatches("{corrupt").matches, {});
  });

  it("rejects a file with a malformed entry instead of crashing the builder (R1)", () => {
    // A null entry used to crash build-epg.mjs at module top level
    // (unguarded `m.site` in the bySite index) before any report was
    // written. Now it yields the same written failing report as a
    // corrupt file — and one bad entry fails the file, so no channel
    // silently loses its guide.
    assert.match(loadMatches('{"A.uk": null}').error, /malformed/);
    assert.match(loadMatches('{"A.uk": "not-an-object"}').error, /malformed/);
    assert.match(loadMatches('{"A.uk": ["x"]}').error, /malformed/);
    assert.match(loadMatches('{"A.uk": {"site": 123, "site_id": "x", "xmltv_id": "A"}}').error, /malformed/);
    assert.match(loadMatches('{"A.uk": {"site": "i.mjh.nz", "site_id": "x"}}').error, /malformed/);
    assert.match(loadMatches('{"A.uk": null}').error, /"A\.uk"/);
    assert.deepEqual(loadMatches('{"A.uk": null}').matches, {});
    assert.equal(loadMatches('{"A.uk": {"site": "i.mjh.nz", "site_id": "x", "xmltv_id": "A"}}').error, null);
  });
});

describe("buildMjhWanted", () => {
  it("groups by path, keys by the part after # or by xmltv_id", () => {
    const rows = [
      ["A.uk", { site_id: "UK/all#bbc", xmltv_id: "A.uk" }],
      ["B.uk", { site_id: "UK/all#cnn", xmltv_id: "B.uk" }],
      ["C.us", { site_id: "US/epg", xmltv_id: "C.us" }],
    ];
    const { byPath, duplicates } = buildMjhWanted(rows);
    assert.deepEqual(duplicates, []);
    assert.deepEqual([...byPath.get("UK/all")], [["bbc", "A.uk"], ["cnn", "B.uk"]]);
    assert.deepEqual([...byPath.get("US/epg")], [["C.us", "C.us"]]);
  });

  it("keeps the first row on a duplicate (path, key) and reports it (S3)", () => {
    const rows = [
      ["A.uk", { site_id: "UK/all#bbc", xmltv_id: "A.uk" }],
      ["B.uk", { site_id: "UK/all#bbc", xmltv_id: "B.uk" }],
      ["C.uk", { site_id: "UK/all", xmltv_id: "dup" }],
      ["D.uk", { site_id: "UK/all", xmltv_id: "dup" }],
    ];
    const { byPath, duplicates } = buildMjhWanted(rows);
    assert.deepEqual([...byPath.get("UK/all")], [["bbc", "A.uk"], ["dup", "C.uk"]]);
    assert.deepEqual(duplicates, [
      { path: "UK/all", key: "bbc", kept: "A.uk", dropped: "B.uk" },
      { path: "UK/all", key: "dup", kept: "C.uk", dropped: "D.uk" },
    ]);
  });
});

describe("extractMyjcomProgrammes", () => {
  // JST is UTC+9: 01:00 JST Nov 12 is 16:00 UTC Nov 11.
  const WIN_START = Date.UTC(2026, 10, 11, 12, 0, 0);
  const WIN_END = Date.UTC(2026, 10, 12, 0, 0, 0);
  const good = {
    ch1: [
      { programStart: "20261112010000", programEnd: "20261112020000", title: "Morning News" },
      { programStart: "20261112020000", programEnd: "20261112030000", title: "  Fish  " },
    ],
  };

  it("extracts programmes from a well-formed response", () => {
    const { programmes, errors } = extractMyjcomProgrammes(good, { winStart: WIN_START, winEnd: WIN_END });
    assert.deepEqual(errors, []);
    assert.equal(programmes.length, 2);
    assert.deepEqual(programmes[0], [Date.UTC(2026, 10, 11, 16, 0, 0), Date.UTC(2026, 10, 11, 17, 0, 0), "Morning News"]);
    assert.equal(programmes[1][2], "Fish"); // title trimmed
  });

  it("reports an error-shaped response instead of silent zero programmes (S2)", () => {
    for (const bad of [{ error: "upstream down" }, { status: "error" }, "oops", 42, null, [{ programStart: "20261112010000" }]]) {
      const { programmes, errors } = extractMyjcomProgrammes(bad, { winStart: WIN_START, winEnd: WIN_END });
      assert.deepEqual(programmes, []);
      assert.equal(errors.length, 1, JSON.stringify(bad));
      assert.match(errors[0], /unexpected myjcom response shape|is not a list/);
    }
  });

  it("reports a non-list group but still processes the good groups", () => {
    const data = { ch1: "not-a-list", ch2: [{ programStart: "20261112010000", programEnd: "20261112020000", title: "OK" }] };
    const { programmes, errors } = extractMyjcomProgrammes(data, { winStart: WIN_START, winEnd: WIN_END });
    assert.equal(programmes.length, 1);
    assert.deepEqual(errors, ['myjcom group "ch1" is not a list (string)']);
  });

  it("skips malformed times, zero-length entries, empty titles and duplicates", () => {
    const seen = new Set();
    const data = {
      ch1: [
        { programStart: "20261332999999", programEnd: "20261112020000", title: "Rolled" },
        { programStart: "20261112010000", programEnd: "20261112010000", title: "Zero" },
        { programStart: "20261112010000", programEnd: "20261112020000", title: "" },
        { programStart: "20261112010000", programEnd: "20261112020000", title: "Good" },
        { programStart: "20261112010000", programEnd: "20261112020000", title: "Dup" },
        null,
        "not-an-object",
      ],
    };
    const { programmes, errors, skipped } = extractMyjcomProgrammes(data, { winStart: WIN_START, winEnd: WIN_END, seen });
    assert.deepEqual(errors, []);
    assert.deepEqual(programmes.map((p) => p[2]), ["Good"]);
    assert.deepEqual(skipped, { malformed: 4, emptyTitle: 1, duplicate: 1 });
  });

  it("trims to the window", () => {
    const data = {
      ch1: [
        { programStart: "20261111010000", programEnd: "20261111020000", title: "Too Early" },
        { programStart: "20261112130000", programEnd: "20261112140000", title: "Too Late" },
      ],
    };
    const { programmes } = extractMyjcomProgrammes(data, { winStart: WIN_START, winEnd: WIN_END });
    assert.deepEqual(programmes, []);
  });
});
