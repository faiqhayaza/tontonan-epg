/**
 * Pure helpers for the Tontonan EPG builder.
 *
 * Kept in their own module (zero dependencies, no I/O, no top-level side
 * effects) so they can be unit-tested with node:test without running the
 * whole pipeline. build-epg.mjs imports from here.
 */

/* Numeric character references outside the valid range (0..0x10FFFF) make
 * String.fromCodePoint throw — one poisoned title would abort the whole
 * adapter's extractXmltv run (and with it, that adapter's channels for
 * the build). Leave such an entity literal instead of decoding it. */
const safeCodePoint = (n) =>
  Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;

/** Decode the XML entities that appear in guide titles. */
export const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(+n) ?? `&#${n};`)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeCodePoint(parseInt(n, 16)) ?? `&#x${n};`)
    .replace(/&amp;/g, "&")
    .trim();

/* XMLTV timestamp "20261020093000 +0900" (offset optional) -> epoch ms. */
export function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, off] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (off) {
    const sign = off[0] === "-" ? -1 : 1;
    ms -= sign * (+off.slice(1, 3) * 3600_000 + +off.slice(3, 5) * 60_000);
  }
  return ms;
}

/* myjcom: programStart/programEnd are JST wall-clock "YYYYMMDDHHmmss". */
export function jstToMs(v) {
  const s = String(v);
  // Not a 14-digit JST wall clock: NaN, so the caller skips the entry.
  // (Without this, a short string like "2026" slices into empty fields
  // and Date.UTC silently rolls over into a plausible-looking time.)
  if (!/^\d{14}$/.test(s)) return NaN;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) - 9 * 3600_000;
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
    const idM = /id="([^"]+)"/.exec(m[1]);
    if (!idM || out.has(idM[1])) continue;
    const nameM = /<display-name[^>]*>([^<]*)<\/display-name>/.exec(m[2]);
    if (nameM) out.set(idM[1], unescapeXml(nameM[1]));
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
    const chM = /channel="([^"]+)"/.exec(attrs);
    if (!chM) continue;
    const cid = wanted.get(chM[1]);
    if (!cid) continue;
    const sM = /start="([^"]+)"/.exec(attrs);
    const eM = /stop="([^"]+)"/.exec(attrs);
    if (!sM || !eM) continue;
    const start = xmltvTime(sM[1]);
    const end = xmltvTime(eM[1]);
    if (start === null || end === null || end <= start || end <= winStart || start >= winEnd) continue;
    const tM = /<title[^>]*>([^<]*)<\/title>/.exec(m[2]);
    if (!tM) continue;
    (out[cid] ??= []).push([start, end, unescapeXml(tM[1])]);
  }
}
