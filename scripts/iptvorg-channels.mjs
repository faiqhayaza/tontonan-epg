#!/usr/bin/env node
/**
 * Generate the custom channels file for the iptv-org/epg grabber.
 *
 * The grabber (https://github.com/iptv-org/epg) fetches guides per channel
 * from the channel's own site, using the site's parser in
 * iptvorg/sites/<site>/. It takes a *.channels.xml file listing the
 * channels to grab; this script builds that file from:
 *
 *   - the live Tontonan catalog (A1 mirror, not tontonan.online: the
 *     site's Cloudflare Bot Fight Mode challenges GitHub Actions runners)
 *   - the previous committed epg.json (channels already covered are skipped)
 *   - matches.json (channels with a dedicated adapter are skipped)
 *   - the iptv-org sites' own channels.xml files (the grabbable universe)
 *
 * Matching is layered, like the epgshare adapter in build-epg.mjs:
 *   A. xmltv_id match: the site's xmltv_id, feed suffix stripped
 *      ("BBCOne.uk@ChannelIslandsHD" -> "BBCOne.uk"), equals a catalog
 *      base id. Most sites leave xmltv_id EMPTY for most channels
 *      (149k/181k entries), so this alone only finds ~1,750 channels.
 *   B. display-name match: the site's channel name, normalized with
 *      normalizeName(), equals a catalog channel name, accepted only
 *      when exactly one uncovered catalog channel matches (filtered to
 *      the xmltv_id's country suffix when the site supplies one).
 *      This finds ~3,000 more, mostly FAST channels (Pluto TV, Plex,
 *      Xumo) whose catalog ids are opaque hex/XUMO ids.
 *
 * Sites that already have a dedicated adapter in build-epg.mjs
 * (i.mjh.nz, epg.iptvx.one, tvguide.myjcom.jp, epgshare01.online) are
 * excluded: grabbing their data through the iptv-org wrapper would
 * duplicate the direct adapters.
 *
 * Output:
 *   - iptvorg.channels.xml : the grabber's --channels input. The
 *     xmltv_id written for each channel is the CATALOG base id, so the
 *     grabber's guide.xml programmes are already keyed by catalog id
 *     and build-epg.mjs can extract them by exact match.
 *   - iptvorg.channels.json : { xmltv_id -> catalogId } map + stats,
 *     read by build-epg.mjs's iptvorg adapter (no catalog re-fetch).
 *
 * The list is capped (--max-channels, default 2500): id matches first,
 * then name matches, sites ordered by yield, so a bounded grab still
 * covers the highest-value channels. The grab itself is best-effort:
 * a site that blocks the runner or a parser that breaks only loses
 * that site's channels for one build; the failure gate in build-epg.mjs
 * still guards the overall output.
 *
 * Usage:
 *   node scripts/iptvorg-channels.mjs [--catalog URL|path] [--epg path]
 *     [--matches path] [--sites dir] [--output path] [--map-output path]
 *     [--max-channels N]
 */
import fs from "node:fs";
import { normalizeName } from "../lib/epg-utils.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const CATALOG = opt("--catalog", "https://oracle-relay.faiqhayaza.com/catalog.json");
const EPG_PATH = opt("--epg", "./epg.json");
const MATCHES_PATH = opt("--matches", "./matches.json");
const SITES_DIR = opt("--sites", "./iptvorg/sites");
const OUTPUT = opt("--output", "./iptvorg.channels.xml");
const MAP_OUTPUT = opt("--map-output", "./iptvorg.channels.json");
const MAX_CHANNELS = Number(opt("--max-channels", "2500")) || 2500;

/* Sites with a dedicated adapter in build-epg.mjs — never grab them here. */
const EXCLUDED_SITES = new Set(["i.mjh.nz", "epg.iptvx.one", "tvguide.myjcom.jp", "epgshare01.online"]);

const baseOf = (id) => String(id).split("@")[0];
const ccOf = (s) => /\.([a-z]{2})(@|$)/i.exec(s)?.[1].toLowerCase() ?? null;

async function loadCatalog() {
  if (/^https?:\/\//.test(CATALOG)) {
    const r = await fetch(CATALOG, { headers: { "User-Agent": "tontonan-epg/1.0" } });
    if (!r.ok) throw new Error(`catalog fetch failed: HTTP ${r.status} (${CATALOG})`);
    return r.json();
  }
  return JSON.parse(fs.readFileSync(CATALOG, "utf8"));
}

function loadJsonOrEmpty(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/* Parse one <channel ...>name</channel> entry; attributes in any order. */
function parseEntries(xml) {
  const out = [];
  const re = /<channel\b([^>]*)>([^<]*)<\/channel>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const get = (k) => new RegExp(`${k}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    out.push({ site: get("site"), site_id: get("site_id"), lang: get("lang") || "en", xmltv_id: get("xmltv_id"), name: m[2].trim() });
  }
  return out;
}

const catalog = await loadCatalog();
const prevEpg = loadJsonOrEmpty(EPG_PATH);
const covered = new Set(Object.keys(prevEpg?.channels ?? {}));
const matches = loadJsonOrEmpty(MATCHES_PATH) ?? {};
const matchedIds = new Set(Object.keys(matches));

const catByBase = new Map(); // base -> [{id, name, cc}]
for (const ch of catalog.channels ?? []) {
  const b = baseOf(ch.id);
  if (!catByBase.has(b)) catByBase.set(b, []);
  catByBase.get(b).push({ id: ch.id, name: ch.name ?? "", cc: (ch.countryCode || "").toLowerCase() });
}
/* Uncovered bases: no feed in the previous epg.json, no dedicated adapter. */
const uncovered = new Map();
for (const [b, chs] of catByBase) {
  if (chs.some((c) => covered.has(c.id))) continue;
  if (matchedIds.has(chs[0].id) || chs.some((c) => matchedIds.has(c.id))) continue;
  uncovered.set(b, chs);
}
/* Name index over uncovered channels only. */
const byName = new Map(); // normName -> [{base, cc}]
for (const [b, chs] of uncovered) {
  for (const c of chs) {
    const n = normalizeName(c.name);
    if (n.length < 4) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push({ base: b, cc: c.cc });
  }
}

const siteDirs = fs.readdirSync(SITES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const idMatches = []; // {site, site_id, lang, xmltv_id(base), name}
const nameMatches = [];
const siteYield = new Map(); // site -> {id, name}
for (const site of siteDirs) {
  if (EXCLUDED_SITES.has(site)) continue;
  const files = fs.readdirSync(`${SITES_DIR}/${site}`).filter((f) => f.endsWith(".channels.xml"));
  for (const f of files) {
    const xml = fs.readFileSync(`${SITES_DIR}/${site}/${f}`, "utf8");
    for (const e of parseEntries(xml)) {
      if (!e.site || !e.site_id || !e.name) continue;
      const y = siteYield.get(site) ?? { id: 0, name: 0 };
      const xidBase = e.xmltv_id ? baseOf(e.xmltv_id) : null;
      if (xidBase && uncovered.has(xidBase)) {
        idMatches.push({ site: e.site || site, site_id: e.site_id, lang: e.lang, xmltv_id: xidBase, name: e.name });
        y.id++;
      } else {
        const cands = byName.get(normalizeName(e.name)) ?? [];
        const cc = ccOf(e.xmltv_id);
        const hit = cands.filter((c) => !cc || !c.cc || c.cc === cc);
        if (hit.length === 1 && uncovered.has(hit[0].base)) {
          nameMatches.push({ site: e.site || site, site_id: e.site_id, lang: e.lang, xmltv_id: hit[0].base, name: e.name });
          y.name++;
        }
      }
      siteYield.set(site, y);
    }
  }
}

/* Dedup: one entry per catalog base (first wins), one per (site, site_id).
 * Id matches first, sites ordered by yield so the cap keeps the best. */
function dedup(list) {
  const seenBase = new Set();
  const seenSiteId = new Set();
  const out = [];
  const sorted = [...list].sort((a, b) => {
    const ya = siteYield.get(a.site) ?? { id: 0, name: 0 };
    const yb = siteYield.get(b.site) ?? { id: 0, name: 0 };
    return yb.id + yb.name - (ya.id + ya.name) || (a.site < b.site ? -1 : 1) || (a.xmltv_id < b.xmltv_id ? -1 : 1);
  });
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
const picked = [...dedup(idMatches), ...dedup(nameMatches)].slice(0, MAX_CHANNELS);
/* The second dedup pass above runs per-list; re-dedup across both lists. */
const finalSeen = new Set();
const final = picked.filter((e) => {
  if (finalSeen.has(e.xmltv_id)) return false;
  finalSeen.add(e.xmltv_id);
  return true;
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n`;
for (const e of final) {
  xml += `  <channel site="${esc(e.site)}" lang="${esc(e.lang)}" xmltv_id="${esc(e.xmltv_id)}" site_id="${esc(e.site_id)}">${esc(e.name)}</channel>\n`;
}
xml += `</channels>\n`;
fs.writeFileSync(OUTPUT, xml);

const perSite = {};
for (const e of final) perSite[e.site] = (perSite[e.site] ?? 0) + 1;
const map = {
  v: 1,
  generatedAt: Date.now(),
  catalogGeneratedAt: catalog.generatedAt ?? null,
  channels: Object.fromEntries(final.map((e) => [e.xmltv_id, catByBase.get(e.xmltv_id)[0].id])),
  stats: {
    catalogChannels: (catalog.channels ?? []).length,
    uncoveredBases: uncovered.size,
    idMatches: idMatches.length,
    nameMatches: nameMatches.length,
    picked: final.length,
    perSite,
  },
};
fs.writeFileSync(MAP_OUTPUT, JSON.stringify(map, null, 2));
console.log(`iptv-org channel list: ${final.length} channels (${idMatches.length} id matches, ${nameMatches.length} name matches; cap ${MAX_CHANNELS})`);
console.log(`sites: ${Object.keys(perSite).length}, top: ${Object.entries(perSite).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, n]) => `${s}=${n}`).join(", ")}`);
console.log(`wrote ${OUTPUT} + ${MAP_OUTPUT}`);
