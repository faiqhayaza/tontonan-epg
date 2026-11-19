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
 *   iptvx    epg.iptvx.one        one gzipped XMLTV file (channels: the
 *                                 epg.iptvx.one rows of matches.json; the
 *                                 live count is report.iptvx.channels)
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
import { buildMjhWanted, evaluateGate, extractMyjcomProgrammes, loadMatches, nextLastGood, readGateBaseline, repairSchedules, scanGateReasons, scanSchedules } from "./lib/pipeline.mjs";

/* matches.json, loaded guarded (lib/pipeline.mjs: loadMatches): a corrupt
 * file used to throw here at import time, before any adapter ran and
 * before build-report.json was written — the process died with a raw
 * stack and no report, contradicting the "report is written on every
 * run that reaches the end" promise below. Now a bad file — corrupt JSON, a non-object, or a
 * malformed entry — yields an empty map plus matchesError; the
 * adapters run with zero rows, the gate fails on zero channels,
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
 * literals) so the worst-case budget is visible in one place.
 *
 * Worst case if every fetch times out and is retried once (each fetch
 * costs timeout + 2 s backoff + timeout; a pool of W workers over N
 * fetches takes ceil(N / W) rounds). The legs run one after another,
 * so their worst cases ADD; the largest leg is epgshare's XML leg, not
 * epgpw:
 *   iptvx              1 x (120+2+120) s                  ~   4 min
 *   mjh                ceil(27 paths / 6) = 5 x 182 s     ~  15 min
 *   myjcom             5 ch x 2 days = 10 x 62 s          ~  10 min
 *   catalog (3 loads)  3 x (60+2+60) s                    ~   6 min
 *   epgshare listings  ceil(101 regions / 6) = 17 x 62 s  ~  18 min
 *   epgshare XML       ceil(101 regions / 3) = 34 x 362 s ~ 205 min
 *   epgpw              20 countries x 362 s               ~ 121 min
 *   epgbest            1 x 362 s                          ~   6 min
 *   total                                                 ~ 385 min
 * (101 = EPGSHARE_REGIONS.length; the XML leg only downloads regions
 * that contribute a channel — 59 on the 2026-11-16 build, i.e. 20
 * rounds, ~121 min — but the bound must use the full list.) No job
 * timeout can cover that, so the build carries its own overall
 * deadline (BUILD_DEADLINE_MS below): when it passes, the running
 * adapter is abandoned, the rest are marked not run, the gate fails,
 * and build-report.json is still written before the process exits —
 * the 90-min job timeout in .github/workflows/epg.yml is then only a
 * backstop for the steps before the build (clone, grab). */
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

/* Overall build deadline (E6/O-E1), measured from NOW. 50 min fits the
 * 90-min job: the steps before the build (clone + npm ci, the channel
 * list, the grab's own `timeout 1500` = 25 min) take at most ~32 min,
 * leaving room for the commit steps after it. EPG_BUILD_DEADLINE_MS
 * overrides it (tests use a few seconds; a manual run can raise it). */
const BUILD_DEADLINE_MS = Number(process.env.EPG_BUILD_DEADLINE_MS) > 0 ? Number(process.env.EPG_BUILD_DEADLINE_MS) : 50 * 60_000;

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
/* Display-safe name for the secret epg.best feed URL in errors and
 * build-report.json (E2); see lib/fetch.mjs fetchError. */
const EPGBEST_LABEL = "epgbest feed (EPG_BEST_URL)";

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
 *
 * Which skip fires in CI (O-E2): iptvorg.channels.json is COMMITTED
 * (the workflow commits it every run as the audit trail of what the
 * grabber was asked for), so a CI checkout always has one and the
 * "channels.json not present" skip is reachable only in a local run
 * or a fresh clone without it. In CI, a failed clone/generate/grab
 * shows up as the iptvorg-guide.xml skip below instead.
 * ------------------------------------------------------------------ */
async function adapterIptvorg() {
  // Missing, unreadable and corrupt are three different failures and
  // must not share one message (R3, E8): missing means the grab step
  // did not run (best-effort, skip quietly); unreadable (EACCES,
  // EISDIR, ...) and corrupt are errors worth naming — and a read
  // error is not a parse error.
  let mapText;
  try {
    mapText = fs.readFileSync(new URL("./iptvorg.channels.json", import.meta.url), "utf8");
  } catch (e) {
    report.iptvorg =
      e.code === "ENOENT"
        ? { skipped: "iptvorg.channels.json not present (grab step did not run)" }
        : { error: `iptvorg.channels.json could not be read: ${e.message}` };
    return;
  }
  let map;
  try {
    map = JSON.parse(mapText);
  } catch (e) {
    report.iptvorg = { error: `iptvorg.channels.json could not be parsed: ${e.message}` };
    return;
  }
  let guide;
  try {
    guide = fs.readFileSync(new URL("./iptvorg-guide.xml", import.meta.url), "utf8");
  } catch (e) {
    report.iptvorg =
      e.code === "ENOENT"
        ? { skipped: "iptvorg-guide.xml not present (grab step did not run or produced nothing)" }
        : { error: `iptvorg-guide.xml could not be read: ${e.message}` };
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
 * in that country matches AND exactly one guide id in the file carries
 * the name (E3: "BBC One" / "BBC One HD" both normalize to "bbcone"
 * and used to merge two schedules into one channel). Abbreviated names ("SkySp Golf HD" vs
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
  // Catalog channels already given a guide id by this adapter (E3, the
  // epgshare pattern): once a cid is claimed, a later guide id that
  // resolves to the same cid is skipped, never appended — two upstream
  // schedules merged into one list are overlapping garbage. (Guide-side
  // name uniqueness in matchEpgpwNames is the first line; this set is
  // the second, and also covers a cid claimed in an earlier country
  // file whose extract produced nothing.)
  const claimed = new Set();
  const failed = [];
  for (const cc of EPW_COUNTRIES) {
    const url = `https://epg.pw/xmltv/epg_${cc}.xml.gz`;
    try {
      const gz = await fetchBuf(url, TIMEOUT_MS.EPW, { maxBytes: EPW_MAX_GZ_BYTES });
      const xml = gunzipCapped(gz, EPW_MAX_XML_BYTES, url).toString("utf8");
      const guideChannels = parseXmltvChannels(xml);
      const names = byCountryName.get(cc) ?? new Map();
      const matched = matchEpgpwNames(guideChannels, names, (cid) => claimed.has(cid) || results[cid]?.length);
      const wanted = new Map();
      for (const [gid, cid] of matched) {
        if (claimed.has(cid)) continue;
        claimed.add(cid);
        wanted.set(gid, cid);
      }
      extractXmltv(xml, wanted, results, WIN_START, WIN_END);
      files++;
    } catch (e) {
      console.error(`epgpw ${cc}: ${e.message}`);
      failed.push({ country: cc, error: e.message, url: e.url ?? null });
    }
  }
  report.epgpw = {
    channels: claimed.size,
    files,
    withData: [...claimed].filter((cid) => results[cid]?.length).length,
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
 * No account is ever created by this repo; to enable epg.best data,
 * the repo owner pastes a personal feed URL into the repo secret.
 * ------------------------------------------------------------------ */
async function adapterEpgbest() {
  const url = process.env.EPG_BEST_URL;
  if (!url) {
    report.epgbest = { skipped: "EPG_BEST_URL not set (see README)" };
    return;
  }
  // The URL is a SECRET (personal token): every fetch/gunzip error is
  // labelled, so build-report.json (committed to a public repo — Actions
  // masks secrets in logs only) carries EPGBEST_LABEL, never the URL
  // (E2). The raw URL stays on e.fullUrl for the console log only.
  const buf = await fetchBuf(url, TIMEOUT_MS.EPGBEST, { maxBytes: EPGBEST_MAX_BYTES, label: EPGBEST_LABEL });
  const xml =
    buf[0] === 0x1f && buf[1] === 0x8b
      ? gunzipCapped(buf, EPGBEST_MAX_XML_BYTES, url, { label: EPGBEST_LABEL }).toString("utf8")
      : buf.toString("utf8");
  const catalog = await loadCatalog();
  const idx = buildCatalogIndexes(catalog.channels);
  const guideChannels = parseXmltvChannels(xml);
  const wanted = new Map();
  // Claimed catalog channels (E3, the epgshare pattern): "BBCOne.uk"
  // and "BBCOne.uk@HD" (or "bbcone.uk") all resolve to the same base;
  // without this set each later guide id re-picked the same cid and
  // extractXmltv appended its schedule onto the first one's.
  const claimed = new Set();
  for (const gid of guideChannels.keys()) {
    // First two match layers only (exact / case-insensitive); the
    // punctuation-stripped layer is epgshare's, not epgbest's.
    const base = resolveGuideId(gid, idx, { allowStripped: false });
    if (!base) continue;
    for (const cid of idx.byBase.get(base)) {
      if (claimed.has(cid) || results[cid]?.length) continue;
      claimed.add(cid);
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

/* The adapters, raced against the overall deadline (BUILD_DEADLINE_MS).
 * On expiry the running adapter is abandoned (its in-flight fetches are
 * killed by the process.exit after the report is written) and every
 * later adapter is recorded as not run. Everything after the loop up to
 * the report write is synchronous, so an abandoned adapter cannot touch
 * results/report in between. A timer cannot interrupt synchronous work,
 * so an adapter that is parsing when the deadline passes finishes that
 * parse first; and when an adapter finishes just past the deadline, no
 * adapter is abandoned — the later ones are simply not run. */
const DEADLINE = Symbol("deadline");
const deadlineAt = NOW + BUILD_DEADLINE_MS;
const deadlineMin = +(BUILD_DEADLINE_MS / 60_000).toFixed(2);
let abandoned = null; // the adapter running when the deadline fired, if any
const notRun = []; // adapters never started because the deadline had passed
for (const [name, fn] of [["iptvx", adapterIptvx], ["mjh", adapterMjh], ["myjcom", adapterMyjcom], ["epgshare", adapterEpgshare], ["iptvorg", adapterIptvorg], ["epgpw", adapterEpgpw], ["epgbest", adapterEpgbest]]) {
  const remaining = deadlineAt - Date.now();
  if (abandoned || notRun.length || remaining <= 0) {
    notRun.push(name);
    report[name] = { error: `not run: build deadline (${deadlineMin} min) exceeded`, at: new Date(NOW).toISOString() };
    continue;
  }
  let timer;
  try {
    const outcome = await Promise.race([fn(), new Promise((resolve) => (timer = setTimeout(resolve, remaining, DEADLINE)))]);
    if (outcome === DEADLINE) {
      abandoned = name;
      console.error(`${name} adapter abandoned: build deadline (${deadlineMin} min) exceeded`);
      report[name] = { error: `abandoned: build deadline (${deadlineMin} min) exceeded while running`, at: new Date(NOW).toISOString() };
      continue;
    }
    console.log(name, JSON.stringify(report[name]));
  } catch (e) {
    // e.fullUrl is set only for a labelled (secret) URL — see
    // lib/fetch.mjs fetchError. It goes to the console (Actions masks
    // registered secrets in logs) and NEVER into the report, which is
    // committed: the report gets the label in both error and url (E2).
    console.error(`${name} adapter failed: ${e.message}${e.fullUrl ? ` [full URL: ${e.fullUrl}]` : ""}`);
    report[name] = { error: e.message, url: e.url ?? null, at: new Date(NOW).toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

/* Overlap repair (lib/pipeline.mjs: repairSchedules): the source
 * guide data itself overlaps (see the repair's comment), so each
 * channel's list is normalized here — clip-to-next-start — after the
 * adapters and before the scan. The repair owns the sort (one sort,
 * one place); the scan below then independently verifies the final
 * map still has 0 overlaps, so the gate stays the verifier. The
 * repair's counts go in the report (repair) so nothing is dropped
 * silently. */
const repair = repairSchedules(results);
for (const [cid, list] of Object.entries(repair.channels)) results[cid] = list;
const total = Object.keys(results).length;
const out = { v: 1, generatedAt: NOW, channels: results };

/* Schedule scan (E-new, lib/pipeline.mjs: scanSchedules): overlapping
 * programmes per channel and zero-length/inverted entries, over the
 * FINAL map — after the repair above, so a passing scan means the
 * repair left 0 overlaps (and a repair bug that left any would still
 * fail the gate). The 2026-11-18 epg.json carried 4,597 overlapping
 * programmes across 130 channels (two upstream schedules appended
 * into one list) and nothing anywhere checked for it. */
const scan = scanSchedules(results);

/* Failure gate (rules + boundary tests in lib/pipeline.mjs): a
 * degraded build must never overwrite the last good epg.json. The
 * baseline is the last build that PASSED the gate, read from the
 * previous build-report.json's lastGoodChannelsWithData (E1) — not its
 * channelsWithData, which a gated (degraded) build also records. The
 * report is written on every run that gets this far — a gated build
 * and a build that hit BUILD_DEADLINE_MS included — so a failure is
 * visible in the repo; epg.json is written only when the gate passes,
 * and a failing build exits non-zero so the workflow fails and GitHub
 * notifies. (Only a run killed from outside — the job timeout, a dead
 * runner — leaves no report.) */
let baseline = null;
try {
  baseline = readGateBaseline(fs.readFileSync(new URL("./build-report.json", import.meta.url), "utf8"));
} catch {
  // First build, or a missing/corrupt report: no baseline, but the
  // absolute floor (total === 0) still applies.
}
const gate = evaluateGate(total, baseline);
const scanReasons = scanGateReasons(scan);
if (scanReasons.length) {
  // Overlapping or zero-length programmes fail the build on their own
  // (threshold OVERLAP_THRESHOLD = 0): a merged double schedule shows
  // the wrong now/next even when the channel counts look healthy.
  gate.reasons = [...(gate.reasons ?? []), ...scanReasons];
  gate.pass = false;
}
if (matchesError) {
  // A corrupt matches.json fails the build on its own: the site
  // adapters lose their whole map (~1,400 channels), so the output
  // would be silently degraded even if the generic adapters still
  // produced enough channels for the gate's numbers to pass.
  // matchesError already names the file and the cause ("matches.json
  // is not valid JSON: ...", "matches.json could not be read: ..."),
  // so it is the reason as-is — no second "matches.json ..." prefix
  // (O-E8).
  gate.reasons = [...(gate.reasons ?? []), matchesError];
  gate.pass = false;
}
if (abandoned || notRun.length) {
  // An incomplete build never ships, even when the adapters that did
  // finish produced enough channels for the count rules to pass. The
  // reason names only what is known: an adapter is called abandoned
  // only when the deadline fired while it ran.
  const what = [...(abandoned ? [`${abandoned} abandoned while running`] : []), ...(notRun.length ? [`not run: ${notRun.join(", ")}`] : [])];
  gate.reasons = [...(gate.reasons ?? []), `build deadline (${deadlineMin} min) exceeded (${what.join("; ")})`];
  gate.pass = false;
}
const gateReasons = gate.reasons ?? [];
// Advances only when the FINAL gate (counts, scan, matches, deadline) passed;
// a gated build carries the previous last-good value forward (E1).
const lastGoodChannelsWithData = nextLastGood(gate.pass, total, baseline);

fs.writeFileSync(
  new URL("./build-report.json", import.meta.url),
  JSON.stringify({ generatedAt: NOW, adapters: report, channelsWithData: total, lastGoodChannelsWithData, gate, scan, repair: { clipped: repair.clipped, dropped: repair.dropped, perChannel: repair.perChannel }, ...(matchesError ? { matchesError } : {}) }, null, 2),
);
if (!gate.pass) {
  console.error(`GATE FAILED (${gateReasons.join("; ")}): epg.json NOT overwritten, keeping last good build`);
  process.exitCode = 1;
  // An abandoned adapter may still hold open fetches that would keep
  // the process alive; the report is on disk, so stop.
  if (abandoned) process.exit(1);
} else {
  // Serialize once: the string is both the file and the size log.
  const outJson = JSON.stringify(out);
  fs.writeFileSync(new URL("./epg.json", import.meta.url), outJson);
  console.log(`epg.json written: ${total} channels with data, ${(outJson.length / 1024).toFixed(0)} KiB`);
}
