/**
 * Pure helpers for the Tontonan EPG builder.
 *
 * Kept in their own module (zero dependencies, no I/O, no top-level side
 * effects) so they can be unit-tested with node:test without running the
 * whole pipeline. build-epg.mjs imports from here.
 */

/* Numeric character references outside the valid range (1..0x10FFFF)
 * make String.fromCodePoint throw — one poisoned title would abort the
 * whole adapter's extractXmltv run (and with it, that adapter's
 * channels for the build). Leave such an entity literal instead of
 * decoding it. 0 is out of range too: it decodes to a literal NUL,
 * which is JSON-legal but garbage in a programme title. */
const safeCodePoint = (n) =>
  Number.isInteger(n) && n >= 1 && n <= 0x10ffff ? String.fromCodePoint(n) : null;

/** Decode the XML entities that appear in guide titles.
 *
 * One pass over the string (O-E5): each entity is decoded exactly once,
 * and the text a decode produces is never re-scanned. The old chain of
 * .replace() calls ran the &amp; step LAST, over the output of the
 * numeric step, so "&#38;amp;" (an escaped "&amp;") decoded to "&#38;"
 * -> "&amp;" -> "&" — decoded twice. */
const NAMED_ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const ENTITY_RE = /&(?:(lt|gt|quot|apos|amp)|#(\d+)|#x([0-9a-fA-F]+));/g;
export const unescapeXml = (s) =>
  s
    .replace(ENTITY_RE, (m, name, dec, hex) =>
      name ? NAMED_ENTITIES[name] : (safeCodePoint(dec !== undefined ? +dec : parseInt(hex, 16)) ?? m),
    )
    .trim();

/* Date-part validation: Date.UTC silently rolls over out-of-range
 * fields (month 13 becomes next January, day 32 becomes the 2nd), so
 * an upstream typo would become a plausible-looking wrong programme
 * time instead of the null/NaN the callers already handle. Reject
 * anything that is not a real calendar date and time. */
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate(); // mo 1-based
const validParts = (y, mo, d, h, mi, se) =>
  mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && se >= 0 && se <= 59;

/* Attribute values, double- or single-quoted. Feeds use double quotes
 * today, but a single-quoted feed would otherwise silently match
 * nothing — the failure mode is invisible (channels just never match),
 * so the parsers below accept both. Hoisted to module level (no /g
 * flag, so they carry no lastIndex state): these run once per programme
 * over tens of thousands of programmes, and rebuilding them per call
 * would be the same wart S11 fixed in the iptvorg script.
 * Each name is anchored to an attribute boundary, (?:^|\s) (E7):
 * unanchored, `start=` also matched inside the XMLTV DTD's
 * `pdc-start=` / `vps-start=` (and `id=` inside any `*-id=`), so a
 * programme listing vps-start before start read the VPS time as its
 * start. */
const ATTR_RES = {
  id: /(?:^|\s)id=(["'])(.*?)\1/,
  channel: /(?:^|\s)channel=(["'])(.*?)\1/,
  start: /(?:^|\s)start=(["'])(.*?)\1/,
  stop: /(?:^|\s)stop=(["'])(.*?)\1/,
};
const attrValue = (attrs, name) => ATTR_RES[name].exec(attrs)?.[2] ?? null;
const DISPLAY_NAME_RE = /<display-name[^>]*>([^<]*)<\/display-name>/;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/;

/* XMLTV timestamp "20261020093000 +0900" (offset optional) -> epoch ms.
 * The pattern is end-anchored (trailing whitespace only): a malformed
 * offset ("+09", "+0900XYZ") matches nothing and returns null, instead
 * of silently dropping the offset or parsing the valid prefix. */
export function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?\s*$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, off] = m;
  if (!validParts(+y, +mo, +d, +h, +mi, +se)) return null;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (off) {
    const offH = +off.slice(1, 3);
    const offM = +off.slice(3, 5);
    if (offH > 23 || offM > 59) return null;
    const sign = off[0] === "-" ? -1 : 1;
    ms -= sign * (offH * 3600_000 + offM * 60_000);
  }
  return ms;
}

/* myjcom: programStart/programEnd are JST wall-clock "YYYYMMDDHHmmss". */
export function jstToMs(v) {
  const s = String(v);
  // Not a 14-digit JST wall clock: NaN, so the caller skips the entry.
  // (O-E3: a very short string like "2026" would be rejected anyway —
  // its empty month slices to 0, which validParts refuses. What this
  // check really catches is a 13-digit value such as "2026111812300":
  // every slice is still a valid part (seconds "0"), so without the
  // check it would parse as a plausible-looking time; an over-long
  // value would likewise have its tail silently ignored.)
  if (!/^\d{14}$/.test(s)) return NaN;
  const [y, mo, d, h, mi, se] = [+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)];
  if (!validParts(y, mo, d, h, mi, se)) return NaN;
  return Date.UTC(y, mo - 1, d, h, mi, se) - 9 * 3600_000;
}

/**
 * Normalize a channel display name for matching.
 *
 * Lowercases, drops parenthetical/quality suffixes ("(1080p)", "HD", "SD",
 * "+1") and strips punctuation — but KEEPS non-Latin letters (CJK,
 * Cyrillic, Arabic), so e.g. NHK's general and educational channels
 * ("NHK東京総合" vs "NHK東京教育") stay distinct instead of both
 * collapsing to "nhk". Used to match epg.pw's numeric-id channels (whose
 * only human key is the display-name) against catalog channel names.
 */
export function normalizeName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\b(1080p|720p|576p|480p|360p|4k|uhd|fhd|hd|sd)\b/g, "")
    .replace(/\+1(?![0-9])/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Parse the <channel> section of an XMLTV document into a Map of
 * channel id -> display-name (first <display-name> wins per channel).
 * Sources like epg.pw key programmes by opaque numeric ids, so the
 * display-name is the only way to tell which catalog channel a feed is.
 */
export function parseXmltvChannels(xml) {
  const out = new Map();
  // Match the whole <channel ...> tag first, then read id="..." out of
  // it: the id is not always the first attribute, and requiring it first
  // silently dropped every channel whose feed lists another attribute
  // before id — no error recorded anywhere, the adapter just matched
  // nothing for that country.
  const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = attrValue(m[1], "id");
    if (!id || out.has(id)) continue;
    const nameM = DISPLAY_NAME_RE.exec(m[2]);
    if (nameM) out.set(id, unescapeXml(nameM[1]));
  }
  return out;
}

/**
 * Extract window-trimmed programmes for `wanted` (Map xmltv_id -> catalogId)
 * from an XMLTV document into `out` (catalogId -> [[startMs, endMs, title]]).
 *
 * Hand-rolled regex parsing, deliberately: the repo is zero-dependency and
 * the feeds are known-shape XMLTV. Known limitation, pinned by tests: a
 * <title> containing nested markup yields only the text before the first
 * "<", and a programme with no <title> is skipped. Zero-length or
 * inverted programmes (stop <= start) are skipped too: upstream feeds
 * publish start == stop placeholder slots (51 of them in the 2026-11-16
 * build's epg.json), and a zero-length entry is not something the client
 * can show as now/next.
 */
export function extractXmltv(xml, wanted, out, winStart, winEnd) {
  const tagRe = /<programme\s([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = m[1];
    const ch = attrValue(attrs, "channel");
    if (!ch) continue;
    const cid = wanted.get(ch);
    if (!cid) continue;
    const s = attrValue(attrs, "start");
    const e = attrValue(attrs, "stop");
    if (!s || !e) continue;
    const start = xmltvTime(s);
    const end = xmltvTime(e);
    if (start === null || end === null || end <= start || end <= winStart || start >= winEnd) continue;
    const tM = TITLE_RE.exec(m[2]);
    if (!tM) continue;
    (out[cid] ??= []).push([start, end, unescapeXml(tM[1])]);
  }
}
