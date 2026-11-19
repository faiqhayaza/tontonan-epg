/**
 * Unit tests for repairSchedules (lib/pipeline.mjs): the
 * clip-to-next-start overlap repair. The repair runs after the
 * adapters and before the scan in build-epg.mjs; the scan itself
 * still detects overlaps — that is pinned by the scanSchedules tests
 * in test/pipeline.test.mjs, which run the scan on unrepaired input —
 * so the gate stays an independent verifier.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairSchedules, scanSchedules } from "../lib/pipeline.mjs";

const H = 3600_000;

describe("repairSchedules", () => {
  it("clips the earlier programme to the next start; both programmes survive", () => {
    const r = repairSchedules({ c: [[0, 2 * H, "A"], [H, 3 * H, "B"]] });
    assert.deepEqual(r.channels, { c: [[0, H, "A"], [H, 3 * H, "B"]] });
    assert.equal(r.clipped, 1);
    assert.equal(r.dropped, 0);
    assert.deepEqual(r.perChannel, { c: 1 });
    assert.equal(scanSchedules(r.channels).overlaps, 0);
  });

  it("repairs two interleaved schedules (unsorted input) and sorts the output", () => {
    const r = repairSchedules({
      merged: [[0, H, "a1"], [H, 2 * H, "a2"], [H / 2, (3 * H) / 2, "b1"], [(3 * H) / 2, (5 * H) / 2, "b2"]],
    });
    // a1 [0,1h] clipped to [0,0.5h]; b1 [0.5h,1.5h] clipped to [0.5h,1h];
    // a2 [1h,2h] clipped to [1h,1.5h]; b2 [1.5h,2.5h] intact.
    assert.deepEqual(r.channels, {
      merged: [[0, H / 2, "a1"], [H / 2, H, "b1"], [H, (3 * H) / 2, "a2"], [(3 * H) / 2, (5 * H) / 2, "b2"]],
    });
    assert.equal(r.clipped, 3);
    assert.equal(r.dropped, 0);
    assert.equal(scanSchedules(r.channels).overlaps, 0);
  });

  it("a 24h container is clipped to the first short programme; the shorts are intact", () => {
    const r = repairSchedules({ c: [[0, 24 * H, "Day"], [2 * H, 3 * H, "S1"], [3 * H, 4 * H, "S2"]] });
    assert.deepEqual(r.channels, { c: [[0, 2 * H, "Day"], [2 * H, 3 * H, "S1"], [3 * H, 4 * H, "S2"]] });
    assert.equal(r.clipped, 1);
    assert.equal(r.dropped, 0);
    assert.equal(scanSchedules(r.channels).overlaps, 0);
  });

  it("same-start pair: the longer programme wins, whichever order the input lists them", () => {
    const longFirst = repairSchedules({ c: [[0, 2 * H, "Long"], [0, H, "Short"]] });
    const shortFirst = repairSchedules({ c: [[0, H, "Short"], [0, 2 * H, "Long"]] });
    for (const r of [longFirst, shortFirst]) {
      assert.deepEqual(r.channels, { c: [[0, 2 * H, "Long"]] });
      assert.equal(r.clipped, 0);
      assert.equal(r.dropped, 1);
    }
  });

  it("an exact duplicate leaves one copy", () => {
    const r = repairSchedules({ c: [[0, H, "x"], [0, H, "x"]] });
    assert.deepEqual(r.channels, { c: [[0, H, "x"]] });
    assert.equal(r.dropped, 1);
    assert.equal(r.clipped, 0);
  });

  it("drops zero-length, inverted and non-finite entries and counts them", () => {
    const r = repairSchedules({ c: [[0, 0, "zero"], [2 * H, H, "inverted"], [NaN, H, "nan"], [0, H, "ok"]] });
    assert.deepEqual(r.channels, { c: [[0, H, "ok"]] });
    assert.equal(r.dropped, 3);
    assert.equal(r.clipped, 0);
    assert.deepEqual(r.perChannel, { c: 3 });
  });

  it("back-to-back programmes are untouched", () => {
    const r = repairSchedules({ c: [[0, H, "A"], [H, 2 * H, "B"]] });
    assert.deepEqual(r, { channels: { c: [[0, H, "A"], [H, 2 * H, "B"]] }, clipped: 0, dropped: 0, perChannel: {} });
  });

  it("is idempotent: repairing the repaired output changes nothing", () => {
    const once = repairSchedules({ c: [[0, 2 * H, "A"], [H, 3 * H, "B"], [0, H, "x"], [0, H, "x"]] });
    assert.equal(once.clipped, 1);
    assert.equal(once.dropped, 2);
    const twice = repairSchedules(once.channels);
    assert.deepEqual(twice.channels, once.channels);
    assert.equal(twice.clipped, 0);
    assert.equal(twice.dropped, 0);
    assert.deepEqual(twice.perChannel, {});
  });

  it("does not mutate its input", () => {
    const input = { c: [[0, 2 * H, "A"], [H, 3 * H, "B"]] };
    const snapshot = JSON.parse(JSON.stringify(input));
    repairSchedules(input);
    assert.deepEqual(input, snapshot);
  });

  it("counts per channel, largest first, and handles an empty map", () => {
    const r = repairSchedules({
      small: [[0, 2 * H, "a"], [H, 3 * H, "b"]],
      big: [[0, 2 * H, "a"], [H, 3 * H, "b"], [2 * H, 4 * H, "c"], [3 * H, 5 * H, "d"]],
      clean: [[0, H, "a"]],
    });
    assert.deepEqual(Object.entries(r.perChannel), [["big", 3], ["small", 1]]);
    assert.equal(r.clipped, 4);
    assert.equal(r.dropped, 0);
    assert.deepEqual(repairSchedules({}), { channels: {}, clipped: 0, dropped: 0, perChannel: {} });
  });
});
