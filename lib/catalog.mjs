/**
 * Catalog loading and guide-id matching, shared by every adapter and
 * script that needs the Tontonan catalog.
 *
 * Before this module, the same work was copy-pasted in three adapters
 * in build-epg.mjs plus scripts/iptvorg-channels.mjs — and the copies
 * had already diverged: ccOf existed in two regexes (the builder's
 * only matched a country code at end-of-string, the script's also
 * before an "@feed" suffix). One copy now, one behaviour, tested.
 */
import { fetchBuf } from "./fetch.mjs";
import { normalizeName } from "./epg-utils.mjs";

/* The catalog's canonical URL. The site's own catalog.json
 * (tontonan.online) 403s from GitHub Actions runners behind
 * Cloudflare Bot Fight Mode, so everything fetches the A1 mirror
 * (Caddy static file, DNS-only, no Cloudflare in the path); the PC
 * catalog build publishes it there on every rebuild. */
export const CATALOG_MIRROR_URL = "https://oracle-relay.faiqhayaza.com/catalog.json";
export const CATALOG_FETCH_TIMEOUT_MS = 60_000;

/* Catalog id minus any "@feed" suffix ("SkyOne.uk@HD" -> "SkyOne.uk"). */
export const baseOf = (id) => String(id).split("@")[0];

/* Country code suffix of an id: ".uk" at the end, or before an
 * "@feed" suffix ("SkyOne.uk@HD" -> "uk"). Null when there is none. */
export const ccOf = (s) => /\.([a-z]{2})(@|$)/i.exec(s)?.[1].toLowerCase() ?? null;

/* Punctuation-stripped lowercase id, for the fuzzy match layer. */
export const stripId = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/* Parse catalog JSON text; throws a readable error instead of a bare
 * SyntaxError, and refuses a document with no channels array. */
export function parseCatalog(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`catalog.json is not valid JSON: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.channels)) throw new Error("catalog.json has no channels array");
  return parsed;
}

/* Fetch the catalog from the mirror and parse it. */
export async function loadCatalog() {
  const buf = await fetchBuf(CATALOG_MIRROR_URL, CATALOG_FETCH_TIMEOUT_MS);
  return parseCatalog(buf.toString("utf8"));
}

/* Indexes over catalog channels, built once and shared by the
 * matchers: base id -> [catalogId], lowercased base -> base,
 * stripped base -> how many catalog bases share it, and stripped
 * base -> base for the bases whose stripped form is unique. */
export function buildCatalogIndexes(channels) {
  const byBase = new Map();
  const byLower = new Map();
  const stripCount = new Map();
  for (const ch of channels ?? []) {
    const b = baseOf(ch.id);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(ch.id);
    byLower.set(b.toLowerCase(), b);
    stripCount.set(stripId(b), (stripCount.get(stripId(b)) ?? 0) + 1);
  }
  const byStrip = new Map();
  for (const b of byBase.keys()) if (stripCount.get(stripId(b)) === 1) byStrip.set(stripId(b), b);
  return { byBase, byLower, stripCount, byStrip };
}

/**
 * Resolve a guide id to a catalog base id, or null. Layers, in order:
 *   1. exact base-id match
 *   2. exact match on the "@feed"-stripped id
 *   3. case-insensitive match (of the id, then of its stripped form)
 *   4. punctuation-stripped match — accepted only when the stripped
 *      form is unique on BOTH sides (guideStripCount, when given,
 *      counts the guide side; the catalog side is unique by
 *      construction of byStrip), is at least 4 chars, and the country
 *      suffix agrees when both ids carry one.
 * epgbest uses only layers 1–3 (allowStripped: false); epgshare uses
 * all four. This is the one implementation of the matcher the
 * epgshare and epgbest adapters used to inline separately (the
 * epgbest copy was a nested ternary — nit N4).
 */
export function resolveGuideId(gid, idx, { allowStripped = true, guideStripCount = null } = {}) {
  const base = baseOf(gid);
  if (idx.byBase.has(gid)) return gid;
  if (base !== gid && idx.byBase.has(base)) return base;
  const lower = idx.byLower.get(String(gid).toLowerCase()) ?? (base !== gid ? idx.byLower.get(base.toLowerCase()) : undefined);
  if (lower) return lower;
  if (!allowStripped) return null;
  const key = stripId(gid);
  if (key.length < 4) return null;
  if (guideStripCount && guideStripCount.get(key) !== 1) return null;
  const b = idx.byStrip.get(key);
  if (!b) return null;
  if (ccOf(b) && ccOf(gid) && ccOf(b) !== ccOf(gid)) return null;
  return b;
}

/* Per-country normalized-name index over catalog channels, for the
 * epg.pw adapter (whose channel ids are opaque numbers, so matching
 * is by display-name). Names shorter than 4 chars are skipped: they
 * collide too easily to ever be a safe unique match. */
export function buildCountryNameIndex(channels) {
  const byCountryName = new Map(); // cc -> normName -> [catalogId]
  for (const ch of channels ?? []) {
    const cc = (ch.countryCode || "").toUpperCase();
    if (!cc) continue;
    const n = normalizeName(ch.name ?? "");
    if (n.length < 4) continue;
    if (!byCountryName.has(cc)) byCountryName.set(cc, new Map());
    const m = byCountryName.get(cc);
    if (!m.has(n)) m.set(n, []);
    m.get(n).push(ch.id);
  }
  return byCountryName;
}

/* Match a guide file's (numeric id -> display-name) channels against
 * one country's name index. Accepted only when exactly one uncovered
 * catalog channel in that country matches: an ambiguous name is a
 * wrong guide, and a wrong guide is worse than no guide. `isCovered`
 * reports channels an earlier adapter already filled, so they cannot
 * steal a unique match from an uncovered channel. */
export function matchEpgpwNames(guideChannels, names, isCovered) {
  const wanted = new Map(); // numeric epg.pw id -> catalogId
  for (const [numId, name] of guideChannels) {
    const cands = (names.get(normalizeName(name)) ?? []).filter((cid) => !isCovered(cid));
    if (cands.length === 1) wanted.set(numId, cands[0]);
  }
  return wanted;
}
