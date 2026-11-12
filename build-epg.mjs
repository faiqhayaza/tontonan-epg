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
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { extractXmltv, jstToMs } from "./lib/epg-utils.mjs";

const MATCHES = JSON.parse(fs.readFileSync(new URL("./matches.json", import.meta.url), "utf8"));
const NOW = Date.now();
const WIN_START = NOW - 3 * 3600_000;
const WIN_END = NOW + 16 * 3600_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const bySite = new Map();
for (const [cid, m] of Object.entries(MATCHES)) {
  if (!bySite.has(m.site)) bySite.set(m.site, []);
  bySite.get(m.site).push([cid, m]);
}

async function fetchBuf(url, timeoutMs = 60_000, { maxBytes = Infinity } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": UA }, redirect: "follow" });
    if (!r.ok) throw fetchError(url, `HTTP ${r.status}`);
    const declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw fetchError(url, `content-length ${declared} exceeds cap ${maxBytes}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw fetchError(url, `downloaded ${buf.length} bytes, exceeds cap ${maxBytes}`);
    return buf;
  } catch (e) {
    // Tag every fetch failure with the URL, so build-report.json can name
    // the failing fetch. (The Nov 2026 epgshare incident was undiagnosable
    // for 2 days precisely because the report recorded only "HTTP 403".)
    if (!e.url) e.url = url;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* Error carrying the URL that failed, for the build report. */
function fetchError(url, message) {
  const e = new Error(`${message} (${url})`);
  e.url = url;
  return e;
}

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

/* Gunzip with an output cap; tags errors with the source URL like fetchBuf. */
function gunzipCapped(gz, maxBytes, url) {
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (e) {
    if (!e.url) e.url = url;
    throw e;
  }
}

/* Pure XML/time helpers live in lib/epg-utils.mjs (unit-tested). */

const results = {};
const report = {};

async function adapterIptvx() {
  const rows = bySite.get("epg.iptvx.one") ?? [];
  // iptvx keys programmes by the guides' site_id (e.g. "13-strt"), not xmltv_id.
  const wanted = new Map(rows.map(([cid, m]) => [String(m.site_id), cid]));
  const gz = await fetchBuf("https://iptvx.one/epg/epg_noarch.xml.gz", 120_000, { maxBytes: IPTVX_MAX_GZ_BYTES });
  const xml = gunzipCapped(gz, IPTVX_MAX_XML_BYTES, "https://iptvx.one/epg/epg_noarch.xml.gz").toString("utf8");
  extractXmltv(xml, wanted, results, WIN_START, WIN_END);
  report.iptvx = { channels: rows.length, withData: rows.filter(([cid]) => results[cid]?.length).length, xmlMB: +(xml.length / 1e6).toFixed(1) };
}

async function adapterMjh() {
  const rows = bySite.get("i.mjh.nz") ?? [];
  const byPath = new Map();
  for (const [cid, m] of rows) {
    const [path, key] = String(m.site_id).split("#");
    if (!byPath.has(path)) byPath.set(path, new Map());
    // Inside the file, programmes are keyed by the part after '#' when present.
    byPath.get(path).set(key ?? m.xmltv_id, cid);
  }
  let files = 0;
  const failedPaths = [];
  const queue = [...byPath.entries()];
  async function worker() {
    while (queue.length) {
      const [path, wanted] = queue.shift();
      try {
        const buf = await fetchBuf(`https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/${path}.xml`, 90_000, { maxBytes: MJH_MAX_XML_BYTES });
        extractXmltv(buf.toString("utf8"), wanted, results, WIN_START, WIN_END);
        files++;
      } catch (e) {
        console.error(`mjh ${path}: ${e.message}`);
        failedPaths.push({ path, error: e.message, url: e.url ?? null });
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  report.mjh = { channels: rows.length, files, paths: byPath.size, withData: rows.filter(([cid]) => results[cid]?.length).length, ...(failedPaths.length ? { failedPaths } : {}) };
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
        const buf = await fetchBuf(`https://tvguide.myjcom.jp/api/getEpgInfo/?channels=${m.site_id}_${day}&rectime=&rec4k=`, 30_000);
        const data = JSON.parse(buf.toString("utf8"));
        for (const items of Object.values(data)) {
          for (const it of items) {
            const start = jstToMs(it.programStart);
            const end = jstToMs(it.programEnd);
            if (end <= WIN_START || start >= WIN_END || seen.has(start)) continue;
            seen.add(start);
            const title = String(it.title ?? "").trim();
            if (!title) continue; // don't publish empty-title programme entries
            (results[cid] ??= []).push([start, end, title]);
          }
        }
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
  // Fetch the catalog from the Oracle A1 mirror, NOT tontonan.online:
  // Cloudflare Bot Fight Mode challenges GitHub Actions runners, so the
  // site's own catalog.json 403s from the workflow (Nov 2026, feed halved
  // to ~1,000 channels for 2 days). The A1 serves the same file at
  // https://oracle-relay.faiqhayaza.com/catalog.json (Caddy static file,
  // DNS-only, no Cloudflare in the path); the PC catalog build publishes
  // it there on every rebuild (scripts/gen-catalog-json.mjs in tontonan).
  const catBuf = await fetchBuf("https://oracle-relay.faiqhayaza.com/catalog.json", 60_000);
  const catalog = JSON.parse(catBuf.toString("utf8"));
  const baseOf = (id) => String(id).split("@")[0];
  const ccOf = (s) => /\.([a-z]{2})$/i.exec(s)?.[1].toLowerCase() ?? null;
  const strip = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const byBase = new Map(); // base id -> [catalogId]
  const byLower = new Map(); // lowercased base -> base
  const stripCount = new Map(); // stripped base -> how many catalog bases share it
  for (const ch of catalog.channels ?? []) {
    const b = baseOf(ch.id);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(ch.id);
    byLower.set(b.toLowerCase(), b);
    stripCount.set(strip(b), (stripCount.get(strip(b)) ?? 0) + 1);
  }

  // Fetch all region listings first (small); collect esId -> regions.
  const esRegions = new Map();
  const failedLists = [];
  const listQueue = [...EPGSHARE_REGIONS];
  async function listWorker() {
    while (listQueue.length) {
      const region = listQueue.shift();
      try {
        const txt = (await fetchBuf(`https://epgshare01.online/epgshare01/epg_ripper_${region}.txt`, 30_000)).toString("utf8");
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
  await Promise.all(Array.from({ length: 6 }, listWorker));

  const esStripCount = new Map();
  for (const id of esRegions.keys()) esStripCount.set(strip(id), (esStripCount.get(strip(id)) ?? 0) + 1);
  const byStrip = new Map(); // stripped base -> base, unique catalog bases only
  for (const b of byBase.keys()) if (stripCount.get(strip(b)) === 1) byStrip.set(strip(b), b);

  // Resolve each EPGShare id to at most one catalog channel; an id is
  // claimed by the first region (in EPGSHARE_REGIONS order) listing it.
  // Channels already covered by earlier adapters are left to them.
  const wantedByRegion = new Map(); // region -> Map(esId -> catalogId)
  const claimed = new Set();
  for (const region of EPGSHARE_REGIONS) {
    for (const [esId, regions] of esRegions) {
      if (regions[0] !== region) continue;
      let base = null;
      if (byBase.has(esId)) base = esId;
      else if (byLower.has(esId.toLowerCase())) base = byLower.get(esId.toLowerCase());
      else {
        const key = strip(esId);
        if (key.length >= 4 && esStripCount.get(key) === 1) {
          const b = byStrip.get(key);
          if (b && (!ccOf(b) || !ccOf(esId) || ccOf(b) === ccOf(esId))) base = b;
        }
      }
      if (!base) continue;
      for (const cid of byBase.get(base)) {
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
        const gz = await fetchBuf(`https://epgshare01.online/epgshare01/epg_ripper_${region}.xml.gz`, 180_000, { maxBytes: EPGSHARE_MAX_GZ_BYTES });
        extractXmltv(gunzipCapped(gz, EPGSHARE_MAX_XML_BYTES, `https://epgshare01.online/epgshare01/epg_ripper_${region}.xml.gz`).toString("utf8"), wanted, results, WIN_START, WIN_END);
        files++;
      } catch (e) {
        console.error(`epgshare ${region}: ${e.message}`);
        failedRegions.push({ region, error: e.message, url: e.url ?? null });
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, dlWorker));
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

for (const [name, fn] of [["iptvx", adapterIptvx], ["mjh", adapterMjh], ["myjcom", adapterMyjcom], ["epgshare", adapterEpgshare]]) {
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

/* Failure gate: a degraded build must never overwrite the last good
 * epg.json. The previous committed build-report.json is the baseline.
 * The report is ALWAYS written (so a failure is visible in the repo);
 * epg.json is written only when the gate passes, and the process exits
 * non-zero so the workflow fails and GitHub notifies. Rules:
 *   - zero channels with data -> fail
 *   - channelsWithData down >25% vs the previous build -> fail
 * (The Nov 2026 epgshare outage halved output to ~1,000 from ~1,900
 * for 2 days while the workflow stayed green and kept committing the
 * degraded file. Either rule would have stopped it at the first build.) */
let prevTotal = null;
try {
  const prev = JSON.parse(fs.readFileSync(new URL("./build-report.json", import.meta.url), "utf8"));
  if (Number.isFinite(prev.channelsWithData)) prevTotal = prev.channelsWithData;
} catch {
  // First build, or a missing/corrupt report: no baseline, but the
  // absolute floor (total === 0) still applies.
}
const gateReasons = [];
if (total === 0) gateReasons.push("no channels with data");
if (prevTotal !== null && total < prevTotal * 0.75)
  gateReasons.push(`channelsWithData fell ${prevTotal} -> ${total} (more than 25% down vs previous build)`);
const gate = { prevChannelsWithData: prevTotal, pass: gateReasons.length === 0, ...(gateReasons.length ? { reasons: gateReasons } : {}) };

fs.writeFileSync(
  new URL("./build-report.json", import.meta.url),
  JSON.stringify({ generatedAt: NOW, adapters: report, channelsWithData: total, gate }, null, 2),
);
if (!gate.pass) {
  console.error(`GATE FAILED (${gateReasons.join("; ")}): epg.json NOT overwritten, keeping last good build`);
  process.exitCode = 1;
} else {
  fs.writeFileSync(new URL("./epg.json", import.meta.url), JSON.stringify(out));
  console.log(`epg.json written: ${total} channels with data, ${(JSON.stringify(out).length / 1024).toFixed(0)} KiB`);
}
