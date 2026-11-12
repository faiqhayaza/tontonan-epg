#!/usr/bin/env node
/**
 * matches.json maintenance tool.
 *
 * matches.json maps Tontonan catalog channel ids to guide sources. It was
 * originally derived from iptv-org's guides database, but iptv-org has
 * since restructured (the database repo is now CSVs, guides live per-site
 * in iptv-org/epg) and there is no single upstream index to re-derive it
 * from — so this script maintains the file from its current content plus
 * the live catalog and live source checks, instead of pretending to
 * regenerate it from scratch.
 *
 * Usage (run from the repo root, Node >= 20, no dependencies):
 *   node scripts/regenerate-matches.mjs                  audit only, prints a report
 *   node scripts/regenerate-matches.mjs --verify-sources audit + live-check every mjh path
 *   node scripts/regenerate-matches.mjs --prune-orphans --dry-run
 *       show which entries would be dropped (sites with no adapter)
 *   node scripts/regenerate-matches.mjs --prune-orphans
 *       drop orphan entries (backs up to matches.json.bak first)
 *   node scripts/regenerate-matches.mjs --prune-stale
 *       drop entries whose channel id is no longer in the live catalog
 *       (fetches https://tontonan.online/catalog.json)
 *
 * Orphan entries are the 2,232 entries (Nov 2026) across ~137 guide sites
 * that no adapter reads — only epg.iptvx.one, i.mjh.nz and
 * tvguide.myjcom.jp have adapters. Pruning them shrinks matches.json from
 * ~423 KB to ~160 KB and stops the file implying coverage that does not
 * exist. Review the git diff before committing a prune.
 */
import fs from "node:fs";

const MATCHES_PATH = new URL("../matches.json", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* Sites with an adapter in build-epg.mjs. Everything else is an orphan. */
const ADAPTER_SITES = new Set(["epg.iptvx.one", "i.mjh.nz", "tvguide.myjcom.jp"]);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const pruneOrphans = args.has("--prune-orphans");
const pruneStale = args.has("--prune-stale");
const verifySources = args.has("--verify-sources");

const matches = JSON.parse(fs.readFileSync(MATCHES_PATH, "utf8"));
const entries = Object.entries(matches);

const bySite = new Map();
for (const [cid, m] of entries) bySite.set(m.site, (bySite.get(m.site) ?? 0) + 1);

const malformed = entries.filter(([, m]) => !m || typeof m.site !== "string" || typeof m.site_id !== "string" || typeof m.xmltv_id !== "string");
const orphans = entries.filter(([, m]) => !ADAPTER_SITES.has(m.site));

console.log(`matches.json: ${entries.length} entries across ${bySite.size} sites`);
for (const [site, n] of [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  ${String(n).padStart(5)}  ${site}${ADAPTER_SITES.has(site) ? "  (has adapter)" : ""}`);
console.log(`malformed entries (missing site/site_id/xmltv_id): ${malformed.length}`);
if (malformed.length) for (const [cid] of malformed.slice(0, 10)) console.log(`  ${cid}`);
console.log(`orphan entries (site has no adapter): ${orphans.length}`);
if (orphans.length) {
  const orphanSites = new Map();
  for (const [, m] of orphans) orphanSites.set(m.site, (orphanSites.get(m.site) ?? 0) + 1);
  for (const [site, n] of [...orphanSites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(`  ${String(n).padStart(5)}  ${site}`);
}

let dropped = new Set();
if (pruneOrphans) for (const [cid] of orphans) dropped.add(cid);

if (pruneStale) {
  const catRes = await fetch("https://tontonan.online/catalog.json", { headers: { "User-Agent": UA } });
  if (!catRes.ok) throw new Error(`catalog fetch failed: HTTP ${catRes.status}`);
  const catalog = await catRes.json();
  const live = new Set((catalog.channels ?? []).map((ch) => ch.id));
  let stale = 0;
  for (const [cid] of entries) if (!live.has(cid)) { dropped.add(cid); stale++; }
  console.log(`stale entries (channel not in live catalog): ${stale}`);
}

if (verifySources) {
  const paths = [...new Set(entries.filter(([, m]) => m.site === "i.mjh.nz").map(([, m]) => String(m.site_id).split("#")[0]))];
  console.log(`checking ${paths.length} mjh paths...`);
  for (const path of paths) {
    const r = await fetch(`https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/${path}.xml`, { headers: { "User-Agent": UA } });
    if (!r.ok) {
      const affected = entries.filter(([, m]) => m.site === "i.mjh.nz" && String(m.site_id).split("#")[0] === path).map(([cid]) => cid);
      console.log(`  ${r.status} ${path} (${affected.length} channels: ${affected.join(", ")})`);
    }
  }
}

if (dropped.size) {
  console.log(`${dryRun ? "would drop" : "dropping"} ${dropped.size} entries (${entries.length} -> ${entries.length - dropped.size})`);
  if (!dryRun) {
    fs.copyFileSync(MATCHES_PATH, new URL("../matches.json.bak", import.meta.url));
    const kept = Object.fromEntries(entries.filter(([cid]) => !dropped.has(cid)));
    // Preserve the file's existing format: 2-space JSON with all leading
    // indentation stripped, no trailing newline (verified byte-identical
    // on a re-serialise of the unpruned file), so the prune diff shows
    // only the dropped entries.
    fs.writeFileSync(MATCHES_PATH, JSON.stringify(kept, null, 2).replace(/^ +/gm, ""));
    console.log("wrote matches.json (backup: matches.json.bak). Review the git diff before committing.");
  }
} else if (pruneOrphans || pruneStale) {
  console.log("nothing to drop.");
}
