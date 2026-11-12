# tontonan-epg

Program guide (EPG) data pipeline for [Tontonan](https://tontonan.online).

A scheduled GitHub Actions workflow (every 3 hours) runs `build-epg.mjs`, which
collects now/next programme data for the Tontonan catalog channels that have a
known guide source, and publishes a compact `epg.json`:

```json
{ "v": 1, "generatedAt": 0, "channels": { "<channelId>": [[startMs, endMs, "title"], ...] } }
```

The website fetches `epg.json` from this repo
(`https://raw.githubusercontent.com/faiqhayaza/tontonan-epg/main/epg.json`,
overridable with `NEXT_PUBLIC_EPG_URL` at site build time) and shows the current and next programme where
data exists; channels without a guide source keep the site's "no guide
published" wording.

Sources (guide availability data: [iptv-org](https://github.com/iptv-org/database)):

- `epg.iptvx.one` XMLTV feed
- `i.mjh.nz` XMLTV files (matthuisman)
- `tvguide.myjcom.jp` JSON API (Japanese channels)
- `epgshare01.online` per-region XMLTV files (EPGShare) — generic adapter
  matching catalog channels by tvg-id (exact / case-insensitive /
  punctuation-stripped); only downloads regions that add new channels

`matches.json` maps catalog channel ids to guide sources. Each source is
failure-isolated: if one is down, only its channels are missing from that build.

## Running locally

Requires Node.js 20 or later. No dependencies to install (zero-dependency
project — only the Node standard library).

```sh
node build-epg.mjs   # writes epg.json + build-report.json
npm test             # unit tests for the helpers in lib/epg-utils.mjs
npm run check        # syntax-checks the scripts
```

## Failure gate (planned, not yet live)

There is currently **no failure gate**: a build that produces zero
channels, or far fewer than the previous build, still exits 0 and the
workflow still commits whatever `epg.json` it produced. That is what
happened in November 2026 (see below). A gate is prepared — fail the
build if it produces 0 channels or more than 25% fewer channels with
data than the previous build, keep the last good `epg.json`, and record
the failing URL in the report — and lands once the Cloudflare
`/catalog.json` exclusion is fixed and the feed is healthy again, so
the gate's baseline is a good build rather than the degraded one.

## When an adapter fails

Read `build-report.json` — a failed adapter is recorded there as
`{ "error": "<message>" }` only, with no URL (that changes when the
failure gate lands). Per-file failures are printed to the workflow log
(`console.error`), not the report, so check the Actions run log for the
detail. Note the epgshare adapter's first fetch is the **live catalog**
(`tontonan.online/catalog.json`), not an epgshare URL — if that fetch
403s, the adapter reports just `HTTP 403` and never reaches epgshare.
That is what happened in November 2026: the catalog fetch from GitHub
Actions runners returned 403 (the site's Cloudflare bot protection,
shipped the same day, was blocking Actions egress despite the
`/catalog.json` exclusion), halving output for two days while the
workflow stayed green. The fix was on the Cloudflare side (exclusion
for `/catalog.json`); the planned failure gate exists so a repeat can
never silently ship a degraded `epg.json` again.

Known smaller gap: the mjh path `Flash/epg` 404s upstream, so the 9
channels mapped to it (CNN, MSNBC, NBC News NOW, …) have no guide data
until matthuisman's repo restores it or the entries are remapped.

## matches.json

`matches.json` has 1,135 entries, all for the three sites with adapters
(`epg.iptvx.one`, `i.mjh.nz`, `tvguide.myjcom.jp`). It used to carry
3,367 entries; the other 2,232 entries across ~137 sites had no adapter
and could never produce data, so they were pruned on 2026-11-12
(verified: full builds before and after the prune produce the same
channels — the remaining run-to-run differences are upstream feed churn,
not the prune). To audit the file:

```sh
node scripts/regenerate-matches.mjs                       # audit report
node scripts/regenerate-matches.mjs --verify-sources      # live-check mjh paths
node scripts/regenerate-matches.mjs --prune-orphans --dry-run
node scripts/regenerate-matches.mjs --prune-orphans       # drops orphans, backs up to matches.json.bak
node scripts/regenerate-matches.mjs --prune-stale         # drops channels no longer in the live catalog
```

Review the git diff before committing a prune. There is no way to
re-derive `matches.json` from a single upstream index any more (iptv-org
restructured its database to CSVs and per-site configs), so the script
maintains the file from its current content plus live checks.

## build-report.json

Per-build adapter stats, committed alongside `epg.json`:

```json
{ "generatedAt": 0,
  "adapters": { "iptvx":   { "channels": 343, "withData": 331, "xmlMB": 312 },
                "mjh":     { "channels": 787, "files": 26, "paths": 27, "withData": 680 },
                "myjcom":  { "channels": 5, "withData": 5 },
                "epgshare":{ "channels": 1031, "files": 58, "regions": 58, "withData": 916 } },
  "channelsWithData": 1916
```

## License

MIT — see [LICENSE](LICENSE).
