/**
 * Pure pipeline logic for the Tontonan EPG builder: the failure gate
 * and its last-good baseline, the schedule scan (overlaps,
 * zero-length entries), the mjh path/key map, the myjcom response
 * handling, and the guarded matches.json load.
 *
 * Kept in its own module (no I/O, no top-level side effects) so the
 * decisions that shape epg.json — which guide lands, whether a
 * degraded build ships — are unit-tested instead of verified only by
 * watching production builds. build-epg.mjs calls these; it keeps
 * only the fetching and the file writes.
 */
import { jstToMs } from "./epg-utils.mjs";

/**
 * Failure gate: a degraded build must never overwrite the last good
 * epg.json. Rules (unchanged from the original inline code):
 *   - zero channels with data -> fail
 *   - channelsWithData down MORE than 25% vs the baseline -> fail
 * Exactly 25% down passes: the rule is "more than 25%", and the
 * boundary is pinned by tests. The baseline (`prevTotal`, reported as
 * gate.prevChannelsWithData) is the last build that passed the gate —
 * see readGateBaseline — or null when there is none.
 * (Origin: the Nov 2026 epgshare outage halved output to ~1,000 from
 * ~1,900 for 2 days while the workflow stayed green and kept
 * committing the degraded file. Either rule would have stopped it at
 * the first build.)
 */
export function evaluateGate(total, prevTotal) {
  const reasons = [];
  if (total === 0) reasons.push("no channels with data");
  if (prevTotal !== null && total < prevTotal * 0.75)
    reasons.push(`channelsWithData fell ${prevTotal} -> ${total} (more than 25% down vs the last build that passed the gate)`);
  return { prevChannelsWithData: prevTotal, pass: reasons.length === 0, ...(reasons.length ? { reasons } : {}) };
}

/**
 * The gate's baseline from the previous build-report.json text: the
 * channel count of the last build that PASSED the gate (E1).
 *
 * The report is written (and committed, `if: always()`) even when the
 * gate fails, so using its channelsWithData as the next baseline let a
 * degraded build ratchet the bar down: a 3,000 -> 1,000 build is gated,
 * commits channelsWithData 1,000, and the next 1,000-channel build
 * compares 1,000 < 750 -> passes and overwrites epg.json. The report
 * therefore carries lastGoodChannelsWithData, which only advances when
 * the gate passes (nextLastGood).
 *   - report with lastGoodChannelsWithData: that value (null when it is
 *     null/non-numeric — there has never been a known-good build)
 *   - older report without the field: its channelsWithData (reports
 *     from before E1 were only committed with a meaningful count)
 *   - missing/corrupt report: null (the absolute floor still applies)
 */
export function readGateBaseline(text) {
  let prev;
  try {
    prev = JSON.parse(text);
  } catch {
    return null;
  }
  if (!prev || typeof prev !== "object" || Array.isArray(prev)) return null;
  if (Object.hasOwn(prev, "lastGoodChannelsWithData"))
    return Number.isFinite(prev.lastGoodChannelsWithData) ? prev.lastGoodChannelsWithData : null;
  return Number.isFinite(prev.channelsWithData) ? prev.channelsWithData : null;
}

/* The lastGoodChannelsWithData to write into this build's report: this
 * run's total when the (final) gate passed, else the baseline carried
 * forward unchanged, so a gated build never becomes the next baseline. */
export function nextLastGood(gatePass, total, baseline) {
  return gatePass ? total : baseline;
}

/* Overlap threshold for the schedule scan gate (E-new). Starts at 0:
 * any overlapping programme fails the build. */
export const OVERLAP_THRESHOLD = 0;

/**
 * Scan the final channels map (catalogId -> [[startMs, endMs, title]])
 * for schedule defects (E-new). Per channel, programmes are taken in
 * start order (a sorted copy; the input is not mutated) and a
 * programme counts as an overlap when it starts before the latest end
 * seen so far on that channel — so two upstream schedules appended
 * into one list, or a duplicate slot, are caught. Zero-length and
 * inverted programmes (end <= start, or non-finite times) are counted
 * separately; extractXmltv/extractMyjcomProgrammes already skip them,
 * so a non-zero count means a new code path let one through.
 * Returns { overlaps, overlapChannels, zeroLength, perChannel } with
 * perChannel = { catalogId: overlapCount } for channels with overlaps,
 * largest first.
 */
export function scanSchedules(channels) {
  let overlaps = 0;
  let zeroLength = 0;
  const counts = [];
  for (const [cid, list] of Object.entries(channels ?? {})) {
    const sorted = [...(list ?? [])].sort((a, b) => a[0] - b[0]);
    let maxEnd = -Infinity;
    let n = 0;
    for (const [start, end] of sorted) {
      if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) zeroLength++;
      if (start < maxEnd) n++;
      if (end > maxEnd) maxEnd = end;
    }
    if (n) {
      counts.push([cid, n]);
      overlaps += n;
    }
  }
  counts.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { overlaps, overlapChannels: counts.length, zeroLength, perChannel: Object.fromEntries(counts) };
}

/* Gate reasons from a scanSchedules result: overlaps above
 * OVERLAP_THRESHOLD, or any zero-length/inverted programme. Kept
 * separate from evaluateGate so the channel-count rules and their
 * pinned boundary are untouched. */
export function scanGateReasons(scan) {
  const reasons = [];
  if (scan.overlaps > OVERLAP_THRESHOLD)
    reasons.push(`${scan.overlaps} overlapping programmes across ${scan.overlapChannels} channels (threshold ${OVERLAP_THRESHOLD})`);
  if (scan.zeroLength > 0) reasons.push(`${scan.zeroLength} zero-length or inverted programmes`);
  return reasons;
}

/**
 * Parse matches.json text. Returns { matches, error }: a corrupt file
 * (or a JSON value that is not an object) yields an error instead of
 * throwing, so the builder can write a build report about it and exit
 * non-zero instead of dying at import time with a raw stack and no
 * report (the "report is written on every run that reaches the end"
 * promise).
 *
 * Entry shape is validated too, with the same "malformed" definition
 * scripts/regenerate-matches.mjs uses: an entry must be an object
 * whose site, site_id and xmltv_id are all strings. A single null
 * entry used to crash the builder at module top level (build-epg.mjs
 * builds the bySite index with an unguarded `m.site` dereference)
 * before any report was written; now it yields the same written
 * failing report as a corrupt file.
 */
export function loadMatches(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { matches: {}, error: `matches.json is not valid JSON: ${e.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { matches: {}, error: "matches.json is not an object of channel entries" };
  const malformed = Object.entries(parsed)
    .filter(([, m]) => !m || typeof m !== "object" || Array.isArray(m) || typeof m.site !== "string" || typeof m.site_id !== "string" || typeof m.xmltv_id !== "string")
    .map(([cid]) => cid);
  if (malformed.length) {
    const shown = malformed.slice(0, 10).map((cid) => `"${cid}"`).join(", ");
    const more = malformed.length > 10 ? `, ... (${malformed.length - 10} more)` : "";
    return { matches: {}, error: `matches.json has ${malformed.length} malformed ${malformed.length === 1 ? "entry" : "entries"} (not objects with string site/site_id/xmltv_id): ${shown}${more}` };
  }
  return { matches: parsed, error: null };
}

/**
 * Group mjh matches.json rows by file path: path -> Map(key -> catalogId).
 * Inside a file, programmes are keyed by the part after '#' when
 * present, else by xmltv_id.
 *
 * A duplicate (path, key) used to silently overwrite the earlier row
 * in the map — one channel lost its guide with no warning anywhere.
 * First row now wins, and every duplicate is returned so the adapter
 * can record it in the report.
 */
export function buildMjhWanted(rows) {
  const byPath = new Map();
  const duplicates = [];
  for (const [cid, m] of rows) {
    const [path, key] = String(m.site_id).split("#");
    const k = key ?? m.xmltv_id;
    if (!byPath.has(path)) byPath.set(path, new Map());
    const wanted = byPath.get(path);
    if (wanted.has(k)) {
      duplicates.push({ path, key: k, kept: wanted.get(k), dropped: cid });
      continue;
    }
    wanted.set(k, cid);
  }
  return { byPath, duplicates };
}

/**
 * Extract one day's programmes from a myjcom API response.
 * programStart/programEnd are JST wall-clock "YYYYMMDDHHmmss".
 *
 * The response must be an object whose values are lists of programme
 * objects. An error-shaped response (e.g. {error: "..."}) used to be
 * silently treated as zero programmes: Object.values yields strings,
 * the inner loop iterates their characters, every entry is skipped as
 * malformed, and the adapter reported success with withData 0. Now
 * the shape is validated and every violation is returned in `errors`,
 * so the adapter records it as a failure for that channel/day.
 *
 * Returns { programmes, errors, skipped }: programmes are
 * [startMs, endMs, title] within (winStart, winEnd); `seen` dedupes
 * start times across days for one channel (pass one Set per channel).
 * Zero-length/inverted entries, malformed times, empty titles and
 * duplicate starts are skipped, like extractXmltv.
 */
export function extractMyjcomProgrammes(data, { winStart, winEnd, seen = new Set() } = {}) {
  const programmes = [];
  const errors = [];
  const skipped = { malformed: 0, emptyTitle: 0, duplicate: 0 };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push(`unexpected myjcom response shape: ${Array.isArray(data) ? "array" : typeof data}`);
    return { programmes, errors, skipped };
  }
  for (const [group, items] of Object.entries(data)) {
    if (!Array.isArray(items)) {
      errors.push(`myjcom group "${group}" is not a list (${typeof items})`);
      continue;
    }
    for (const it of items) {
      if (!it || typeof it !== "object") {
        skipped.malformed++;
        continue;
      }
      const start = jstToMs(it.programStart);
      const end = jstToMs(it.programEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= winStart || start >= winEnd) {
        skipped.malformed++;
        continue;
      }
      if (seen.has(start)) {
        skipped.duplicate++;
        continue;
      }
      const title = String(it.title ?? "").trim();
      if (!title) {
        skipped.emptyTitle++;
        continue;
      }
      seen.add(start);
      programmes.push([start, end, title]);
    }
  }
  return { programmes, errors, skipped };
}
