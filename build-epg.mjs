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

async function fetchBuf(url, timeoutMs = 60_000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": UA }, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .trim();

/* XMLTV timestamp "20261020093000 +0900" (offset optional) -> epoch ms. */
function xmltvTime(s) {
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

/** Extract window-trimmed programmes for `wanted` (Map xmltv_id -> catalogId). */
function extractXmltv(xml, wanted, out) {
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
    if (start === null || end === null || end <= WIN_START || start >= WIN_END) continue;
    const tM = /<title[^>]*>([^<]*)<\/title>/.exec(m[2]);
    if (!tM) continue;
    (out[cid] ??= []).push([start, end, unescapeXml(tM[1])]);
  }
}

const results = {};
const report = {};

async function adapterIptvx() {
  const rows = bySite.get("epg.iptvx.one") ?? [];
  // iptvx keys programmes by the guides' site_id (e.g. "13-strt"), not xmltv_id.
  const wanted = new Map(rows.map(([cid, m]) => [String(m.site_id), cid]));
  const gz = await fetchBuf("https://iptvx.one/epg/epg_noarch.xml.gz", 120_000);
  const xml = zlib.gunzipSync(gz).toString("utf8");
  extractXmltv(xml, wanted, results);
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
  const queue = [...byPath.entries()];
  async function worker() {
    while (queue.length) {
      const [path, wanted] = queue.shift();
      try {
        const buf = await fetchBuf(`https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/${path}.xml`, 90_000);
        extractXmltv(buf.toString("utf8"), wanted, results);
        files++;
      } catch (e) {
        console.error(`mjh ${path}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  report.mjh = { channels: rows.length, files, paths: byPath.size, withData: rows.filter(([cid]) => results[cid]?.length).length };
}

/* myjcom: programStart/programEnd are JST wall-clock "YYYYMMDDHHmmss". */
function jstToMs(v) {
  const s = String(v);
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) - 9 * 3600_000;
}

async function adapterMyjcom() {
  const rows = bySite.get("tvguide.myjcom.jp") ?? [];
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
            (results[cid] ??= []).push([start, end, String(it.title ?? "").trim()]);
          }
        }
      } catch (e) {
        console.error(`myjcom ${cid} ${day}: ${e.message}`);
      }
    }
  }
  report.myjcom = { channels: rows.length, withData: rows.filter(([cid]) => results[cid]?.length).length };
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
  const catBuf = await fetchBuf("https://tontonan.online/catalog.json", 60_000);
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
  for (const wanted of wantedByRegion.values()) matched += wanted.size;
  const dlQueue = [...wantedByRegion.entries()];
  async function dlWorker() {
    while (dlQueue.length) {
      const [region, wanted] = dlQueue.shift();
      try {
        const gz = await fetchBuf(`https://epgshare01.online/epgshare01/epg_ripper_${region}.xml.gz`, 180_000);
        extractXmltv(zlib.gunzipSync(gz).toString("utf8"), wanted, results);
        files++;
      } catch (e) {
        console.error(`epgshare ${region}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, dlWorker));
  report.epgshare = {
    channels: matched,
    files,
    regions: wantedByRegion.size,
    withData: [...claimed].filter((cid) => results[cid]?.length).length,
  };
}

for (const [name, fn] of [["iptvx", adapterIptvx], ["mjh", adapterMjh], ["myjcom", adapterMyjcom], ["epgshare", adapterEpgshare]]) {
  try {
    await fn();
    console.log(name, JSON.stringify(report[name]));
  } catch (e) {
    console.error(`${name} adapter failed: ${e.message}`);
    report[name] = { error: e.message };
  }
}

for (const list of Object.values(results)) list.sort((a, b) => a[0] - b[0]);
const out = { v: 1, generatedAt: NOW, channels: results };
fs.writeFileSync(new URL("./epg.json", import.meta.url), JSON.stringify(out));
const total = Object.keys(results).length;
console.log(`epg.json written: ${total} channels with data, ${(JSON.stringify(out).length / 1024).toFixed(0)} KiB`);
fs.writeFileSync(new URL("./build-report.json", import.meta.url), JSON.stringify({ generatedAt: NOW, adapters: report, channelsWithData: total }, null, 2));
