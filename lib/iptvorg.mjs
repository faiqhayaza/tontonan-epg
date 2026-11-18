/**
 * Pure logic for scripts/iptvorg-channels.mjs: parsing the iptv-org
 * sites' channels.xml files, working out which catalog channels are
 * uncovered, matching site entries to them, and deduping/capping the
 * grab list.
 *
 * Kept in its own module (no I/O, no top-level side effects) so the
 * matching/dedup/cap logic is unit-tested; the script keeps only the
 * CLI parsing, the file reads, and the output writes.
 */
import { baseOf, ccOf } from "./catalog.mjs";
import { normalizeName } from "./epg-utils.mjs";

/* Attribute regexes, hoisted to module level: parseEntries used to
 * build four fresh RegExps per attribute per entry (~700k
 * constructions over ~181k entries). They are also quote-tolerant
 * (single- or double-quoted); the old patterns only matched
 * attr="...", so a single-quoted file silently matched nothing.
 * No /g flag, so the shared regexes carry no lastIndex state.
 * Each name is anchored to an attribute boundary, (?:^|\s), like the
 * XMLTV attribute regexes in lib/epg-utils.mjs: unanchored, `site=`
 * also matched inside another attribute's name (`website=`) or inside
 * an earlier attribute's value (site_id="watch?site=x"), and whichever
 * came first in the tag won. */
const ATTR_RE = {
  site: /(?:^|\s)site=(["'])(.*?)\1/,
  site_id: /(?:^|\s)site_id=(["'])(.*?)\1/,
  lang: /(?:^|\s)lang=(["'])(.*?)\1/,
  xmltv_id: /(?:^|\s)xmltv_id=(["'])(.*?)\1/,
};

/* Parse one <channel ...>name</channel> entry; attributes in any order. */
export function parseEntries(xml) {
  const out = [];
  const re = /<channel\b([^>]*)>([^<]*)<\/channel>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const get = (rx) => rx.exec(attrs)?.[2] ?? "";
    out.push({ site: get(ATTR_RE.site), site_id: get(ATTR_RE.site_id), lang: get(ATTR_RE.lang) || "en", xmltv_id: get(ATTR_RE.xmltv_id), name: m[2].trim() });
  }
  return out;
}

/* Validate --max-channels: an explicit 0 means "grab nothing", a
 * negative number or a non-number is a loud error — the old
 * `Number(...) || 2500` silently turned an explicit 0 into 2500 and
 * let a negative N reach .slice(0, -N) (which drops the last N
 * instead of taking none). */
export function parseMaxChannels(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--max-channels must be a whole number >= 0, got "${raw}"`);
  return n;
}

/* Catalog channels grouped by base id: base -> [{id, name, cc}]. */
export function buildCatByBase(channels) {
  const catByBase = new Map();
  for (const ch of channels ?? []) {
    const b = baseOf(ch.id);
    if (!catByBase.has(b)) catByBase.set(b, []);
    catByBase.get(b).push({ id: ch.id, name: ch.name ?? "", cc: (ch.countryCode || "").toLowerCase() });
  }
  return catByBase;
}

/* Uncovered bases: no feed in the previous epg.json, no dedicated
 * adapter. A base is covered if ANY of its feeds is covered. */
export function buildUncovered(catByBase, covered, matchedIds) {
  const uncovered = new Map();
  for (const [b, chs] of catByBase) {
    if (chs.some((c) => covered.has(c.id))) continue;
    if (chs.some((c) => matchedIds.has(c.id))) continue;
    uncovered.set(b, chs);
  }
  return uncovered;
}

/* Name index over uncovered channels only: normName -> [{base, cc}]. */
export function buildNameIndex(uncovered) {
  const byName = new Map();
  for (const [b, chs] of uncovered) {
    for (const c of chs) {
      const n = normalizeName(c.name);
      if (n.length < 4) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push({ base: b, cc: c.cc });
    }
  }
  return byName;
}

/**
 * Match one site entry against the uncovered catalog. Returns
 * { kind: "id" | "name", xmltv_id } or null:
 *   id   — the site's xmltv_id, feed suffix stripped, equals a
 *          catalog base id. (Most sites leave xmltv_id EMPTY for most
 *          channels, so this alone only finds a minority.)
 *   name — the site's channel name, normalized, equals an uncovered
 *          catalog channel name, accepted only when exactly one
 *          uncovered catalog channel matches (filtered to the
 *          xmltv_id's country suffix when the site supplies one).
 *          Mostly FAST channels whose catalog ids are opaque hex/XUMO
 *          ids. A wrong guide is worse than no guide, so an ambiguous
 *          name matches nothing.
 */
export function matchEntry(e, uncovered, byName) {
  const xidBase = e.xmltv_id ? baseOf(e.xmltv_id) : null;
  if (xidBase && uncovered.has(xidBase)) return { kind: "id", xmltv_id: xidBase };
  const cands = byName.get(normalizeName(e.name)) ?? [];
  const cc = ccOf(e.xmltv_id);
  const hit = cands.filter((c) => !cc || !c.cc || c.cc === cc);
  if (hit.length === 1 && uncovered.has(hit[0].base)) return { kind: "name", xmltv_id: hit[0].base };
  return null;
}

/* Sort order for the dedup: highest-yield site first, then site,
 * xmltv_id, site_id — a total order, so equal keys compare 0. (The
 * inline comparator used to return 1 when the keys were equal, which
 * violates the sort contract: equal elements must compare 0.) */
export function compareEntries(a, b, siteYield) {
  const ya = siteYield.get(a.site) ?? { id: 0, name: 0 };
  const yb = siteYield.get(b.site) ?? { id: 0, name: 0 };
  return (
    yb.id + yb.name - (ya.id + ya.name) ||
    (a.site < b.site ? -1 : a.site > b.site ? 1 : 0) ||
    (a.xmltv_id < b.xmltv_id ? -1 : a.xmltv_id > b.xmltv_id ? 1 : 0) ||
    (a.site_id < b.site_id ? -1 : a.site_id > b.site_id ? 1 : 0)
  );
}

/* Dedup: one entry per catalog base (first wins), one per
 * (site, site_id). Sites ordered by yield so the cap keeps the best. */
export function dedupEntries(list, siteYield) {
  const seenBase = new Set();
  const seenSiteId = new Set();
  const out = [];
  const sorted = [...list].sort((a, b) => compareEntries(a, b, siteYield));
  for (const e of sorted) {
    if (seenBase.has(e.xmltv_id)) continue;
    const k = `${e.site}\0${e.site_id}`;
    if (seenSiteId.has(k)) continue;
    seenBase.add(e.xmltv_id);
    seenSiteId.add(k);
    out.push(e);
  }
  return out;
}

/* Id matches first, then name matches, capped. The per-list dedup
 * above runs separately, so re-dedup across both lists: one entry per
 * catalog base in the final list. */
export function pickChannels(idMatches, nameMatches, siteYield, maxChannels) {
  const picked = [...dedupEntries(idMatches, siteYield), ...dedupEntries(nameMatches, siteYield)].slice(0, maxChannels);
  const finalSeen = new Set();
  return picked.filter((e) => {
    if (finalSeen.has(e.xmltv_id)) return false;
    finalSeen.add(e.xmltv_id);
    return true;
  });
}
