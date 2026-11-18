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
 * Matching/dedup/cap logic lives in lib/iptvorg.mjs (unit-tested);
 * this file keeps only the CLI parsing, the file reads, and the
 * output writes.
 *
 * Usage:
 *   node scripts/iptvorg-channels.mjs [--catalog URL|path] [--epg path]
 *     [--matches path] [--sites dir] [--output path] [--map-output path]
 *     [--max-channels N]
 */
import fs from "node:fs";
import { CATALOG_MIRROR_URL, loadCatalog, parseCatalog } from "../lib/catalog.mjs";
import {
  buildCatByBase,
  buildNameIndex,
  buildUncovered,
  matchEntry,
  parseEntries,
  parseMaxChannels,
  pickChannels,
} from "../lib/iptvorg.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const CATALOG = opt("--catalog", CATALOG_MIRROR_URL);
const EPG_PATH = opt("--epg", "./epg.json");
const MATCHES_PATH = opt("--matches", "./matches.json");
const SITES_DIR = opt("--sites", "./iptvorg/sites");
const OUTPUT = opt("--output", "./iptvorg.channels.xml");
const MAP_OUTPUT = opt("--map-output", "./iptvorg.channels.json");
const MAX_CHANNELS = parseMaxChannels(opt("--max-channels", "2500"));

/* Sites with a dedicated adapter in build-epg.mjs — never grab them here. */
const EXCLUDED_SITES = new Set(["i.mjh.nz", "epg.iptvx.one", "tvguide.myjcom.jp", "epgshare01.online"]);

/* The catalog, through the shared path in lib/catalog.mjs (E4): a URL
 * goes through loadCatalog (fetchBuf's timeout, transient retry and
 * User-Agent), a local path through parseCatalog — and both refuse a
 * document with no channels array. The inline fetch() + r.json() this
 * replaces accepted a 200 with `{}` and wrote an EMPTY grab list
 * without a word. */
async function readCatalog() {
  if (/^https?:\/\//.test(CATALOG)) return loadCatalog(CATALOG);
  return parseCatalog(fs.readFileSync(CATALOG, "utf8"));
}

/* Missing file (first run) -> null. A file that exists but is corrupt
 * must fail loudly: silently treating it as empty would mark every
 * channel uncovered and fill the grab list with already-covered
 * channels (and, for matches.json, re-grab channels that already have
 * a dedicated adapter). */
function loadJsonOrEmpty(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

const catalog = await readCatalog();
const prevEpg = loadJsonOrEmpty(EPG_PATH);
const covered = new Set(Object.keys(prevEpg?.channels ?? {}));
const matches = loadJsonOrEmpty(MATCHES_PATH) ?? {};
const matchedIds = new Set(Object.keys(matches));

const catByBase = buildCatByBase(catalog.channels);
const uncovered = buildUncovered(catByBase, covered, matchedIds);
const byName = buildNameIndex(uncovered);

const siteDirs = fs.readdirSync(SITES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const idMatches = []; // {site, site_id, lang, xmltv_id(base), name}
const nameMatches = [];
/* Yield per SITE ATTRIBUTE (O-E4), not per directory name: the entries
 * written to the grab list carry e.site, and compareEntries looks the
 * yield up by entry.site — keying this map by the directory name made
 * every lookup miss whenever the two differ (latent in iptv-org data,
 * where they normally agree), silently dropping the yield ordering. */
const siteYield = new Map(); // site attribute -> {id, name}
for (const dir of siteDirs) {
  if (EXCLUDED_SITES.has(dir)) continue;
  const files = fs.readdirSync(`${SITES_DIR}/${dir}`).filter((f) => f.endsWith(".channels.xml"));
  for (const f of files) {
    const xml = fs.readFileSync(`${SITES_DIR}/${dir}/${f}`, "utf8");
    for (const e of parseEntries(xml)) {
      // e.site is required here, so it is the entry's site — there is
      // no directory-name fallback to fall back to.
      if (!e.site || !e.site_id || !e.name) continue;
      if (EXCLUDED_SITES.has(e.site)) continue;
      const y = siteYield.get(e.site) ?? { id: 0, name: 0 };
      const hit = matchEntry(e, uncovered, byName);
      if (hit) {
        const entry = { site: e.site, site_id: e.site_id, lang: e.lang, xmltv_id: hit.xmltv_id, name: e.name };
        (hit.kind === "id" ? idMatches : nameMatches).push(entry);
        y[hit.kind]++;
      }
      siteYield.set(e.site, y);
    }
  }
}

const final = pickChannels(idMatches, nameMatches, siteYield, MAX_CHANNELS);

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
    catalogChannels: catalog.channels.length,
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
