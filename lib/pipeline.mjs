/**
 * Pure pipeline logic for the Tontonan EPG builder: the failure gate,
 * the mjh path/key map, the myjcom response handling, and the guarded
 * matches.json load.
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
 *   - channelsWithData down MORE than 25% vs the previous build -> fail
 * Exactly 25% down passes: the rule is "more than 25%", and the
 * boundary is pinned by tests.
 * (Origin: the Nov 2026 epgshare outage halved output to ~1,000 from
 * ~1,900 for 2 days while the workflow stayed green and kept
 * committing the degraded file. Either rule would have stopped it at
 * the first build.)
 */
export function evaluateGate(total, prevTotal) {
  const reasons = [];
  if (total === 0) reasons.push("no channels with data");
  if (prevTotal !== null && total < prevTotal * 0.75)
    reasons.push(`channelsWithData fell ${prevTotal} -> ${total} (more than 25% down vs previous build)`);
  return { prevChannelsWithData: prevTotal, pass: reasons.length === 0, ...(reasons.length ? { reasons } : {}) };
}

/* Read the previous build's channelsWithData from a build-report.json
 * text, or null when there is no usable baseline (first build, or a
 * missing/corrupt report — the absolute floor still applies). */
export function readPrevTotal(text) {
  try {
    const prev = JSON.parse(text);
    return Number.isFinite(prev.channelsWithData) ? prev.channelsWithData : null;
  } catch {
    return null;
  }
}

/**
 * Parse matches.json text. Returns { matches, error }: a corrupt file
 * (or a JSON value that is not an object) yields an error instead of
 * throwing, so the builder can write a build report about it and exit
 * non-zero instead of dying at import time with a raw stack and no
 * report (the "report is ALWAYS written" promise).
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
