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
 *       (fetches the A1 mirror of catalog.json — the site's own
 *       catalog.json 403s from automation, see build-epg.mjs)
 *
 *   node scripts/regenerate-matches.mjs --help
 *       print this usage and exit
 *
 * Orphan entries are entries across guide sites that no adapter reads —
 * only epg.iptvx.one, i.mjh.nz and tvguide.myjcom.jp have adapters. The
 * 2,232 orphans present in Nov 2026 were pruned on 2026-11-12
 * (matches.json 3,367 -> 1,135 entries, ~423 KB -> ~160 KB); the audit
 * now reports 0 orphans. --prune-orphans stays as the guard for any
 * future drift. Review the git diff before committing a prune.
 */
import fs from "node:fs";
import { USER_AGENT } from "../lib/fetch.mjs";

const MATCHES_PATH = new URL("../matches.json", import.meta.url);

/* Sites with an adapter in build-epg.mjs. Everything else is an orphan. */
const ADAPTER_SITES = new Set(["epg.iptvx.one", "i.mjh.nz", "tvguide.myjcom.jp"]);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const pruneOrphans = args.has("--prune-orphans");
const pruneStale = args.has("--prune-stale");
const verifySources = args.has("--verify-sources");

if (args.has("--help")) {
  console.log(`Usage: node scripts/regenerate-matches.mjs [options]
  (no options)            audit only, prints a report
  --verify-sources        audit + live-check every mjh path
  --prune-orphans [--dry-run]
                          drop entries whose site has no adapter
  --prune-stale           drop entries whose channel id is no longer
                          in the live catalog (A1 mirror)`);
  process.exit(0);
}

const matches = JSON.parse(fs.readFileSync(MATCHES_PATH, "utf8"));
const entries = Object.entries(matches);

/* Malformed FIRST: every pass below dereferences m.site, so a null
 * entry used to crash this tool (TypeError at the bySite loop) before
 * the malformed check it exists to report could run. Malformed
 * entries are excluded from all later passes, not just reported. */
const malformed = entries.filter(([, m]) => !m || typeof m.site !== "string" || typeof m.site_id !== "string" || typeof m.xmltv_id !== "string");
const malformedCids = new Set(malformed.map(([cid]) => cid));
const validEntries = entries.filter(([cid]) => !malformedCids.has(cid));

const bySite = new Map();
for (const [cid, m] of validEntries) bySite.set(m.site, (bySite.get(m.site) ?? 0) + 1);

const orphans = validEntries.filter(([, m]) => !ADAPTER_SITES.has(m.site));

console.log(`matches.json: ${entries.length} entries across ${bySite.size} sites`);
for (const [site, n] of [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
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
  // The A1 mirror, NOT tontonan.online: Cloudflare Bot Fight Mode
  // challenges GitHub Actions runners, so the site's own catalog.json
  // 403s from automation — the same reason every catalog fetch in
  // build-epg.mjs uses the mirror. (This used to fetch tontonan.online
  // and so only ever worked from a local run.)
  // Unified behind lib/catalog.mjs's CATALOG_MIRROR_URL by the B2 change.
  const catRes = await fetch("https://oracle-relay.faiqhayaza.com/catalog.json", {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!catRes.ok) throw new Error(`catalog fetch failed: HTTP ${catRes.status}`);
  const catalog = await catRes.json();
  const live = new Set((catalog.channels ?? []).map((ch) => ch.id));
  let stale = 0;
  for (const [cid] of validEntries) if (!live.has(cid)) { dropped.add(cid); stale++; }
  console.log(`stale entries (channel not in live catalog): ${stale}`);
}

if (verifySources) {
  const paths = [...new Set(validEntries.filter(([, m]) => m.site === "i.mjh.nz").map(([, m]) => String(m.site_id).split("#")[0]))];
  console.log(`checking ${paths.length} mjh paths...`);
  for (const path of paths) {
    const r = await fetch(`https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/${path}.xml`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const affected = validEntries.filter(([, m]) => m.site === "i.mjh.nz" && String(m.site_id).split("#")[0] === path).map(([cid]) => cid);
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
