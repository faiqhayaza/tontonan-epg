/**
 * O-E3: what jstToMs's 14-digit check actually catches. The fix is a
 * comment correction (behaviour unchanged): these pin the behaviour the
 * corrected comment describes — the 13-digit (and over-long) value is
 * the case only the digit-count check rejects; a very short value is
 * already rejected by validParts (month 0).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jstToMs } from "../lib/epg-utils.mjs";

describe("O-E3: jstToMs length check", () => {
  it("rejects a 13-digit value whose slices are all valid parts", () => {
    assert.ok(Number.isNaN(jstToMs("2026111812300")));
  });

  it("rejects an over-long value instead of ignoring its tail", () => {
    assert.ok(Number.isNaN(jstToMs("202611181230000")));
  });

  it("rejects a short value, and parses a real 14-digit JST time", () => {
    assert.ok(Number.isNaN(jstToMs("2026")));
    assert.equal(jstToMs("20261118123000"), Date.UTC(2026, 10, 18, 12, 30, 0) - 9 * 3600_000);
  });
});
