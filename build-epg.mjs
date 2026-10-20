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
 *   iptvx   epg.iptvx.one        one gzipped XMLTV file (343 channels)
 *   mjh     i.mjh.nz             per-service XMLTV files on GitHub raw
 *   myjcom  tvguide.myjcom.jp    JSON API (JP channels incl. TBS, Fuji TV)
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

for (const [name, fn] of [["iptvx", adapterIptvx], ["mjh", adapterMjh], ["myjcom", adapterMyjcom]]) {
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
