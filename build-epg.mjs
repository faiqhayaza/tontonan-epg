#!/usr/bin/env node
/**
 * Tontonan EPG builder.
 *
 * For every catalog channel that has a known guide source (matches.json,
 * derived from iptv-org's guides database), fetch programme data from a
 * small set of low-fragility sources and emit epg.json:
 *
 *   { "v": 1, "generatedAt": <epoch ms>,
 *     "channels": { "<catalogId>": [[startMs, endMs, "title"], ...] } }
 *
 * Programme lists are window-trimmed (now-3h .. now+16h); the client picks
 * now/next at view time, so a 3-hour build cadence stays accurate.
 * Every adapter is failure-isolated: if a source is down, its channels are
 * simply absent from epg.json and the site keeps its "no guide" wording.
 *
 * Adapters:
 *   iptvx    epg.iptvx.one        one gzipped XMLTV file (343 channels)
 *   mjh      i.mjh.nz             per-service XMLTV files on GitHub raw
 *   myjcom   tvguide.myjcom.jp    JSON API (JP channels incl. TBS, Fuji TV)
 *   epgshare epgshare01.online    per-region XMLTV files; generic adapter
 *                                 keyed by catalog tvg-id (see adapterEpgshare)
 *   iptvorg  iptv-org/epg grabber guide.xml produced by the workflow's
 *                                 grab step (see scripts/iptvorg-channels.mjs);
 *                                 programmes are keyed by catalog base id
 *   epgpw    epg.pw               per-country XMLTV files, matched to the
 *                                 catalog by display-name (numeric ids)
 *   epgbest  epg.best             personal XMLTV URL from EPG_BEST_URL
 *                                 (secret); skipped when unset
 */
import fs from "node:fs";
import { extractXmltv, parseXmltvChannels } from "./lib/epg-utils.mjs";
import { fetchBuf, gunzipCapped } from "./lib/fetch.mjs";
import { buildCatalogIndexes, buildCountryNameIndex, loadCatalog, matchEpgpwNames, resolveGuideId, stripId } from "./lib/catalog.mjs";
import { buildMjhWanted, evaluateGate, extractMyjcomProgrammes, loadMatches, readPrevTotal } from "./lib/pipeline.mjs";

/* matches.json, loaded guarded (lib/pipeline.mjs: loadMatches): a corrupt
 * file used to throw here at import time, before any adapter ran and
 * before build-report.json was written — the process died with a raw
 * stack and no report, contradicting the "report is ALWAYS written"
 * promise below. Now a bad file yields an empty map plus matchesError;
 * the adapters run with zero rows, the gate fails on zero channels,
 * and the report names the cause. */
let MATCHES = {};
let matchesError = null;
try {
  const loaded = loadMatches(fs.readFileSync(new URL("./matches.json", import.meta.url), "utf8"));
  MATCHES = loaded.matches;
  matchesError = loaded.error;
} catch (e) {
  matchesError = `matches.json could not be read: ${e.message}`;
}
const NOW = Date.now();
const WIN_START = NOW - 3 * 3600_000;
const WIN_END = NOW + 16 * 3600_000;

/* Per-adapter fetch timeouts and worker counts, named (not inline
 * literals) so the worst-case budget is visible in one place. Worst
 * case per build: epgpw is sequential, 20 countries x 180 s = 60 min
 * if every fetch times out — the epgpw leg is the binding constraint
 * on the job timeout in .github/workflows/epg.yml. */
const TIMEOUT_MS = {
  IPTVX: 120_000,
  MJH: 90_000,
  MYJCOM: 30_000,
  EPGSHARE_LIST: 30_000,
  EPGSHARE_XML: 180_000,
  EPW: 180_000,
  EPGBEST: 180_000,
};
const WORKERS = { MJH: 6, EPGSHARE_LIST: 6, EPGSHARE_DL: 3 };

const bySite = new Map();
for (const [cid, m] of Object.entries(MATCHES)) {
  if (!bySite.has(m.site)) bySite.set(m.site, []);
  bySite.get(m.site).push([cid, m]);
}

/* Fetching (fetchBuf: streaming byte cap + one transient retry) and
 * gunzipping (gunzipCapped) live in lib/fetch.mjs (unit-tested). */

/* Size caps. The iptvx feed is fetched whole and gunzipped into memory:
 * its uncompressed XML grew 210 MB (Nov 9) -> 312 MB (Nov 12), so the caps
 * below refuse absurd growth instead of OOMing the runner. A capped fetch
 * or gunzip fails the adapter (recorded in the report with its URL) and
 * the failure gate decides whether the build may proceed. */
const IPTVX_MAX_GZ_BYTES = 100 * 1024 * 1024; // compressed; ~15-30 MB today
const IPTVX_MAX_XML_BYTES = 600 * 1024 * 1024; // uncompressed; 312 MB on Nov 12
const EPGSHARE_MAX_GZ_BYTES = 50 * 1024 * 1024; // per region; US2 is ~7 MB
const EPGSHARE_MAX_XML_BYTES = 200 * 1024 * 1024;
const MJH_MAX_XML_BYTES = 20 * 1024 * 1024; // per file; files are KBs to a few MB
const IPTVORG_MAX_XML_BYTES = 500 * 1024 * 1024; // grabber guide.xml; ~2,500 ch x 1 day
const EPW_MAX_GZ_BYTES = 50 * 1024 * 1024; // per country; US is ~21 MB gz
const EPW_MAX_XML_BYTES = 300 * 1024 * 1024; // per country; US unzips to ~164 MB
const EPGBEST_MAX_BYTES = 100 * 1024 * 1024; // personal feed, gz or plain
const EPGBEST_MAX_XML_BYTES = 300 * 1024 * 1024;

/* Pure XML/time helpers live in lib/epg-utils.mjs (unit-tested). */

/* What "channels" means in every adapter's report entry (S7): the
 * number of channels this adapter ATTEMPTED — rows in matches.json for
 * the site adapters (iptvx/mjh/myjcom); matched catalog channels for
 * the generic adapters (epgshare/epgpw/epgbest); the guide's wanted
 * channels for iptvorg. One definition everywhere, so the numbers are
 * comparable across adapters and a future gate rule can read them. */
const results = {};
const report = {};

async function adapterIptvx() {
  const rows = bySite.get("epg.iptvx.one") ?? [];
  // iptvx keys programmes by the guides' site_id (e.g. "13-strt"), not xmltv_id.
  const wanted = new Map(rows.map(([cid, m]) => [String(m.site_id), cid]));
  const gz = await fetchBuf("https://iptvx.one/epg/epg_noarch.xml.gz", TIMEOUT_MS.IPTVX, { maxBytes: IPTVX_MAX_GZ_BYTES });
  const xml = gunzipCapped(gz, IPTVX_MAX_XML_BYTES, "https://iptvx.one/epg/epg_noarch.xml.gz").toString("utf8");
  extractXmltv(xml, wanted, results, WIN_START, WIN_END);
  report.iptvx = { channels: rows.length, withData: rows.filter(([cid]) => results[cid]?.length).length, xmlMB: +(Buffer.byteLength(xml, "utf8") / 1e6).toFixed(1) };
}

async function adapterMjh() {
  const rows = bySite.get("i.mjh.nz") ?? [];
  // Inside each file, programmes are keyed by the part after '#' when
  // present, else by xmltv_id (see lib/pipeline.mjs: buildMjhWanted).
  const { byPath, duplicates } = buildMjhWanted(rows);
  let files = 0;
  const failedPaths = [];
  const queue = [...byPath.entries()];
  async function worker() {
    while (queue.length) {
      const [path, wanted] = queue.shift();
      try {
        const buf = await fetchBuf(`https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/${path}.xml`, TIMEOUT_MS.MJH, { maxBytes: MJH_MAX_XML_BYTES });
        extractXmltv(buf.toString("utf8"), wanted, results, WIN_START, WIN_END);
        files++;
      } catch (e) {
        console.error(`mjh ${path}: ${e.message}`);
        failedPaths.push({ path, error: e.message, url: e.url ?? null });
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS.MJH }, worker));
  report.mjh = { channels: rows.length, files, paths: byPath.size, withData: rows.filter(([cid]) => results[cid]?.length).length, ...(failedPaths.length ? { failedPaths } : {}), ...(duplicates.length ? { duplicateKeys: duplicates } : {}) };
}

/* myjcom: programStart/programEnd are JST wall-clock "YYYYMMDDHHmmss" (see jstToMs). */

async function adapterMyjcom() {
  const rows = bySite.get("tvguide.myjcom.jp") ?? [];
  const failed = [];
  const jstNow = new Date(NOW + 9 * 3600_000);
  const days = [0, 1].map((k) => {
    const d = new Date(jstNow.getTime() + k * 86400_000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  });
  for (const [cid, m] of rows) {
    const seen = new Set();
    for (const day of days) {
      try {
        const buf = await fetchBuf(`https://tvguide.myjcom.jp/api/getEpgInfo/?channels=${m.site_id}_${day}&rectime=&rec4k=`, TIMEOUT_MS.MYJCOM);
        const data = JSON.parse(buf.toString("utf8"));
        // Shape-validated extraction (lib/pipeline.mjs): an error-shaped
        // API response is recorded as a failure, not silently read as
        // zero programmes.
        const { programmes, errors } = extractMyjcomProgrammes(data, { winStart: WIN_START, winEnd: WIN_END, seen });
        if (errors.length) failed.push({ channel: cid, day, error: errors.join("; ") });
        if (programmes.length) (results[cid] ??= []).push(...programmes);
      } catch (e) {
        console.error(`myjcom ${cid} ${day}: ${e.message}`);
        failed.push({ channel: cid, day, error: e.message, url: e.url ?? null });
      }
    }
  }
  report.myjcom = { channels: rows.length, withData: rows.filter(([cid]) => results[cid]?.length).length, ...(failed.length ? { failed } : {}) };
}

/* ------------------------------------------------------------------ *
 * epgshare: generic XMLTV adapter over EPGShare's per-region files.
 *
 * EPGShare (epgshare01.online) republishes ready-made XMLTV guides,
 * one .xml.gz per region (US2, IN1, FR1, ...), refreshed daily. Its
 * channel ids are name-derived ("Sky.HistoryHD.uk") rather than
 * iptv-org ids ("SkyHistoryHD.uk"), so matching is layered:
 *   1. exact base-id match (catalog id minus any "@feed" suffix)
 *   2. case-insensitive base-id match
 *   3. punctuation-stripped match ("MBC.1.ae" -> "MBC1.ae"), accepted
 *      only when the stripped form is unique on BOTH sides, is at
 *      least 4 chars, and the country suffix agrees when both ids
 *      carry one.
 * Each region also publishes a .txt channel listing; those are tiny,
 * so we fetch listings first and only download a region's XML when it
 * can actually contribute a channel the earlier adapters missed.
 * ------------------------------------------------------------------ */
/* EPGShare region list, frozen snapshot. EPGShare publishes no region
 * index (checked 2026-11-17: the homepage links no region files), so
 * this list is hand-maintained: last re-derived from the per-region
 * .txt listings on 2026-11-17 (101 regions). If EPGShare adds a region
 * its channels are silently never fetched; if one is removed its
 * listing 404s into failedLists on every build, which is the signal to
 * drop it from this list. Re-derive by fetching each region's .txt
 * listing and keeping the ones that answer 200. */
const EPGSHARE_REGIONS = (
  "AE1 AL1 ALJAZEERA1 AR1 ASIANTELEVISION1 AT1 AU1 AUDACY1 BA1 BB1 BE2 BEIN1 BG1 BR1 BR2 " +
  "CA2 CH1 CL1 CO1 CR1 CY1 CZ1 DE1 DELUXEMUSIC1 DIRECTVSPORTS1 DISTROTV1 DK1 DO1 DRAFTKINGS1 " +
  "EC1 EG1 ES1 FANDUEL1 FI1 FR1 GR1 HK1 HR1 HU1 ID1 IE1 IL1 IN1 IN2 IN4 IT1 JM1 JP1 JP2 KE1 " +
  "KR1 KZ1 LT1 LU1 LV1 MN1 MT1 MUSICBOX1 MX1 MY1 NG1 NL1 NO1 NZ1 PA1 PE1 PEACOCK1 PH1 PH2 PK1 " +
  "PL1 PLEX1 PT1 RAKUTEN1 RALLY_TV1 RO1 RO2 RS1 SA1 SA2 SE1 SG1 SK1 SPORTKLUB1 SSPORTPLUS1 " +
  "SV1 TBNPLUS1 TH1 THESPORTPLUS1 TR1 TR3 UA1 UK1 US2 US_LOCALS1 US_SPORTS1 UY1 VN1 VOA1 " +
  "WHALETVPLUS1 ZA1"
).split(" ");

async function adapterEpgshare() {
  // Catalog via loadCatalog() (lib/catalog.mjs): the A1 mirror, NOT
  // tontonan.online — the site's own catalog.json 403s from GitHub
  // Actions runners behind Cloudflare Bot Fight Mode.
  const catalog = await loadCatalog();
  const idx = buildCatalogIndexes(catalog.channels);

  // Fetch all region listings first (small); collect esId -> regions.
  const esRegions = new Map();
  const failedLists = [];
  const listQueue = [...EPGSHARE_REGIONS];
  async function listWorker() {
    while (listQueue.length) {
      const region = listQueue.shift();
      try {
        const txt = (await fetchBuf(`https://epgshare01.online/epgshare01/epg_ripper_${region}.txt`, TIMEOUT_MS.EPGSHARE_LIST)).toString("utf8");
        for (let line of txt.split(/\r?\n/)) {
          line = line.trim();
          if (!line || /^\d+$/.test(line) || line.startsWith("--")) continue;
          if (!esRegions.has(line)) esRegions.set(line, []);
          esRegions.get(line).push(region);
        }
      } catch (e) {
        console.error(`epgshare list ${region}: ${e.message}`);
        failedLists.push({ region, error: e.message, url: e.url ?? null });
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS.EPGSHARE_LIST }, listWorker));

  // Stripped-id counts on the GUIDE side, for the fuzzy match layer:
  // a stripped match is accepted only when unique on both sides.
  const esStripCount = new Map();
  for (const id of esRegions.keys()) esStripCount.set(stripId(id), (esStripCount.get(stripId(id)) ?? 0) + 1);

  // Resolve each EPGShare id to at most one catalog channel; an id is
  // claimed by the first region (in EPGSHARE_REGIONS order) listing it.
  // Channels already covered by earlier adapters are left to them.
  const wantedByRegion = new Map(); // region -> Map(esId -> catalogId)
  const claimed = new Set();
  for (const region of EPGSHARE_REGIONS) {
    for (const [esId, regions] of esRegions) {
      if (regions[0] !== region) continue;
      const base = resolveGuideId(esId, idx, { guideStripCount: esStripCount });
      if (!base) continue;
      for (const cid of idx.byBase.get(base)) {
        if (claimed.has(cid) || results[cid]?.length) continue;
        claimed.add(cid);
        if (!wantedByRegion.has(region)) wantedByRegion.set(region, new Map());
        wantedByRegion.get(region).set(esId, cid);
        break; // one catalog id (feed variant) per base id is enough
      }
    }
  }

  let files = 0;
  let matched = 0;
  const failedRegions = [];
  for (const wanted of wantedByRegion.values()) matched += wanted.size;
  const dlQueue = [...wantedByRegion.entries()];
  async function dlWorker() {
    while (dlQueue.length) {
      const [region, wanted] = dlQueue.shift();
      try {
        const gz = await fetchBuf(`https://epgshare01.online/epgshare01/epg_ripper_${region}.xml.gz`, TIMEOUT_MS.EPGSHARE_XML, { maxBytes: EPGSHARE_MAX_GZ_BYTES });
        extractXmltv(gunzipCapped(gz, EPGSHARE_MAX_XML_BYTES, `https://epgshare01.online/epgshare01/epg_ripper_${region}.xml.gz`).toString("utf8"), wanted, results, WIN_START, WIN_END);
        files++;
      } catch (e) {
        console.error(`epgshare ${region}: ${e.message}`);
        failedRegions.push({ region, error: e.message, url: e.url ?? null });
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS.EPGSHARE_DL }, dlWorker));
  report.epgshare = {
    channels: matched,
    files,
    regions: wantedByRegion.size,
    withData: [...claimed].filter((cid) => results[cid]?.length).length,
    ...(failedLists.length ? { failedLists } : {}),
    ...(failedRegions.length ? { failedRegions } : {}),
    // The catalog's own timestamp: makes a stale mirror visible in the
    // report (the A1 file must track the live catalog's generatedAt).
    catalogGeneratedAt: catalog.generatedAt ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * iptvorg: the iptv-org/epg grabber's output, produced by the workflow.
 *
 * The workflow clones iptv-org/epg, runs scripts/iptvorg-channels.mjs
 * (which picks uncovered catalog channels the grabber's sites can serve
 * and writes iptvorg.channels.xml + iptvorg.channels.json), then runs
 * the grabber with --days=1 to produce iptvorg-guide.xml. The generator
 * already wrote each channel's xmltv_id as its CATALOG base id, so the
 * guide's programmes are keyed by catalog id; this adapter only has to
 * resolve each base id to one catalog feed id (first feed without data
 * yet, like epgshare) and extract.
 * If the grab step did not run or produced nothing, the adapter skips
 * quietly: the grabber is best-effort, the other adapters still build.
 * ------------------------------------------------------------------ */
async function adapterIptvorg() {
  let map;
  try {
    map = JSON.parse(fs.readFileSync(new URL("./iptvorg.channels.json", import.meta.url), "utf8"));
  } catch {
    report.iptvorg = { skipped: "iptvorg.channels.json not present (grab step did not run)" };
    return;
  }
  let guide;
  try {
    guide = fs.readFileSync(new URL("./iptvorg-guide.xml", import.meta.url), "utf8");
  } catch {
    report.iptvorg = { skipped: "iptvorg-guide.xml not present (grab produced nothing)" };
    return;
  }
  // Byte length, not string length: guide.length counts UTF-16 code
  // units, which under-enforces the byte cap for multibyte titles.
  const guideBytes = Buffer.byteLength(guide, "utf8");
  if (guideBytes > IPTVORG_MAX_XML_BYTES) {
    report.iptvorg = { error: `guide.xml ${guideBytes} bytes exceeds cap ${IPTVORG_MAX_XML_BYTES}` };
    return;
  }
  const wanted = new Map();
  for (const [xmltvId, catalogId] of Object.entries(map.channels ?? {})) {
    if (results[catalogId]?.length) continue; // earlier adapter already filled it
    wanted.set(xmltvId, catalogId);
  }
  extractXmltv(guide, wanted, results, WIN_START, WIN_END);
  report.iptvorg = {
    channels: wanted.size,
    withData: [...wanted.values()].filter((cid) => results[cid]?.length).length,
    guideKB: +(guideBytes / 1024).toFixed(0),
  };
}

/* ------------------------------------------------------------------ *
 * epgpw: epg.pw per-country XMLTV files (https://epg.pw/xmltv.html).
 *
 * Free, no account, auto-updated daily. 20 country files
 * (epg_<CC>.xml.gz); the US file is the big one (~21 MB gz, ~164 MB
 * XML, ~5,500 channels). Channel ids are opaque NUMBERS, so matching
 * is by display-name: the file's <channel> names, normalized with
 * normalizeName(), matched against catalog channel names in the same
 * country — accepted only when exactly one uncovered catalog channel
 * in that country matches. Abbreviated names ("SkySp Golf HD" vs
 * "Sky Sports Golf HD") do not match; that is accepted loss — a wrong
 * guide is worse than no guide. Files are processed sequentially
 * (the US file alone is ~330 MB as a JS string) and each is
 * failure-isolated.
 * ------------------------------------------------------------------ */
const EPW_COUNTRIES = (
  "AU BR CA CN DE FR GB HK ID IN JP MY NZ PH RU SG TW US VN ZA"
).split(" ");

async function adapterEpgpw() {
  const catalog = await loadCatalog();
  // Per-country name index over catalog channels (all of them; the
  // already-covered ones are filtered out at match time so they cannot
  // steal a unique match from an uncovered channel).
  const byCountryName = buildCountryNameIndex(catalog.channels);

  let files = 0;
  let matchedCids = new Set();
  const failed = [];
  for (const cc of EPW_COUNTRIES) {
    const url = `https://epg.pw/xmltv/epg_${cc}.xml.gz`;
    try {
      const gz = await fetchBuf(url, TIMEOUT_MS.EPW, { maxBytes: EPW_MAX_GZ_BYTES });
      const xml = gunzipCapped(gz, EPW_MAX_XML_BYTES, url).toString("utf8");
      const guideChannels = parseXmltvChannels(xml);
      const names = byCountryName.get(cc) ?? new Map();
      const wanted = matchEpgpwNames(guideChannels, names, (cid) => results[cid]?.length);
      extractXmltv(xml, wanted, results, WIN_START, WIN_END);
      for (const cid of wanted.values()) matchedCids.add(cid);
      files++;
    } catch (e) {
      console.error(`epgpw ${cc}: ${e.message}`);
      failed.push({ country: cc, error: e.message, url: e.url ?? null });
    }
  }
  report.epgpw = {
    channels: matchedCids.size,
    files,
    withData: [...matchedCids].filter((cid) => results[cid]?.length).length,
    ...(failed.length ? { failed } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * epgbest: epg.best personal XMLTV feed.
 *
 * epg.best has NO public unauthenticated feed: the XMLTV URL is
 * personal to a (free) account, issued after registration on
 * https://epg.best/. So this adapter reads its URL from the
 * EPG_BEST_URL environment variable (a GitHub Actions secret in the
 * workflow; unset locally) and SKIPS cleanly when it is not set — the
 * build must stay green without an account. When set, the feed is
 * fetched (gzipped or plain XMLTV) and matched by exact / case-
 * insensitive channel id, like epgshare's first two match layers.
 * No account is ever created by this repo; if Faiq wants epg.best
 * data, he pastes his personal feed URL into the repo secret.
 * ------------------------------------------------------------------ */
async function adapterEpgbest() {
  const url = process.env.EPG_BEST_URL;
  if (!url) {
    report.epgbest = { skipped: "EPG_BEST_URL not set (see README)" };
    return;
  }
  const buf = await fetchBuf(url, TIMEOUT_MS.EPGBEST, { maxBytes: EPGBEST_MAX_BYTES });
  const xml =
    buf[0] === 0x1f && buf[1] === 0x8b
      ? gunzipCapped(buf, EPGBEST_MAX_XML_BYTES, url).toString("utf8")
      : buf.toString("utf8");
  const catalog = await loadCatalog();
  const idx = buildCatalogIndexes(catalog.channels);
  const guideChannels = parseXmltvChannels(xml);
  const wanted = new Map();
  for (const gid of guideChannels.keys()) {
    // First two match layers only (exact / case-insensitive); the
    // punctuation-stripped layer is epgshare's, not epgbest's.
    const base = resolveGuideId(gid, idx, { allowStripped: false });
    if (!base) continue;
    for (const cid of idx.byBase.get(base)) {
      if (results[cid]?.length) continue;
      wanted.set(gid, cid);
      break;
    }
  }
  extractXmltv(xml, wanted, results, WIN_START, WIN_END);
  report.epgbest = {
    channels: wanted.size,
    withData: [...wanted.values()].filter((cid) => results[cid]?.length).length,
  };
}

for (const [name, fn] of [["iptvx", adapterIptvx], ["mjh", adapterMjh], ["myjcom", adapterMyjcom], ["epgshare", adapterEpgshare], ["iptvorg", adapterIptvorg], ["epgpw", adapterEpgpw], ["epgbest", adapterEpgbest]]) {
  try {
    await fn();
    console.log(name, JSON.stringify(report[name]));
  } catch (e) {
    console.error(`${name} adapter failed: ${e.message}`);
    report[name] = { error: e.message, url: e.url ?? null, at: new Date(NOW).toISOString() };
  }
}

for (const list of Object.values(results)) list.sort((a, b) => a[0] - b[0]);
const total = Object.keys(results).length;
const out = { v: 1, generatedAt: NOW, channels: results };

/* Failure gate (rules + boundary tests in lib/pipeline.mjs): a
 * degraded build must never overwrite the last good epg.json. The
 * previous committed build-report.json is the baseline. The report is
 * ALWAYS written (so a failure is visible in the repo); epg.json is
 * written only when the gate passes, and the process exits non-zero so
 * the workflow fails and GitHub notifies. */
let prevTotal = null;
try {
  prevTotal = readPrevTotal(fs.readFileSync(new URL("./build-report.json", import.meta.url), "utf8"));
} catch {
  // First build, or a missing/corrupt report: no baseline, but the
  // absolute floor (total === 0) still applies.
}
const gate = evaluateGate(total, prevTotal);
if (matchesError) {
  // A corrupt matches.json fails the build on its own: the site
  // adapters lose their whole map (~1,400 channels), so the output
  // would be silently degraded even if the generic adapters still
  // produced enough channels for the gate's numbers to pass.
  gate.reasons = [...(gate.reasons ?? []), `matches.json could not be loaded: ${matchesError}`];
  gate.pass = false;
}
const gateReasons = gate.reasons ?? [];

fs.writeFileSync(
  new URL("./build-report.json", import.meta.url),
  JSON.stringify({ generatedAt: NOW, adapters: report, channelsWithData: total, gate, ...(matchesError ? { matchesError } : {}) }, null, 2),
);
if (!gate.pass) {
  console.error(`GATE FAILED (${gateReasons.join("; ")}): epg.json NOT overwritten, keeping last good build`);
  process.exitCode = 1;
} else {
  // Serialize once: the string is both the file and the size log.
  const outJson = JSON.stringify(out);
  fs.writeFileSync(new URL("./epg.json", import.meta.url), outJson);
  console.log(`epg.json written: ${total} channels with data, ${(outJson.length / 1024).toFixed(0)} KiB`);
}
