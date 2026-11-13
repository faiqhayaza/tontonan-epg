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
- `iptv-org/epg` grabber — the workflow clones the grabber, generates a
  channel list from the live catalog with `scripts/iptvorg-channels.mjs`
  (id match, then unique display-name match; sites with a dedicated
  adapter excluded; capped at 1,500 channels per build), runs the grab
  for one day, and merges the resulting `iptvorg-guide.xml`. Best
  effort: a grab failure only skips that adapter for one build.
- `epg.pw` per-country XMLTV files (21 countries, daily) — matched to
  the catalog by display-name, since its channel ids are opaque numbers;
  only unique in-country name matches are accepted
- `epg.best` personal XMLTV feed — read from the `EPG_BEST_URL`
  environment variable (a repo secret in the workflow). epg.best issues
  the feed URL per (free) account, so there is no public URL to fetch;
  the adapter skips cleanly when the variable is unset. To enable it,
  register at https://epg.best/, copy the personal EPG URL, and set it
  as the `EPG_BEST_URL` repository secret. No account is created by
  this repo.

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

A local run skips the `iptvorg` adapter (no `iptvorg-guide.xml` unless
you run the grabber yourself — see `scripts/iptvorg-channels.mjs`) and
the `epgbest` adapter (no `EPG_BEST_URL`); the other adapters run as
in the workflow.

## Failure gate

The build is gated: it fails (non-zero exit, workflow fails, GitHub
notifies) and does NOT overwrite `epg.json` when it produces zero
channels with data, or more than 25% fewer than the previous build.
`build-report.json` is always written, so a gated build still leaves
its report (with the failing URL and gate reason) in the repo. This
gate exists because in November 2026 the epgshare outage halved output
to ~1,000 channels for two days while the workflow stayed green and
kept committing the degraded file.

## When an adapter fails

Read `build-report.json` — a failed adapter is recorded there with its
error message and, for fetch failures, the URL that failed (each fetch
is tagged with its URL, so a repeat of the November 2026 epgshare
incident is diagnosable from the report alone). Per-file failures are
also printed to the workflow log (`console.error`). The failure gate
above decides whether a degraded build may overwrite `epg.json`.

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
maintains the file from its current content plus live checks. The
2,232 pruned entries are not lost work: the iptv-org grabber path
(`scripts/iptvorg-channels.mjs`) re-derives the same channel→site
mapping from the live sites data on every build, so those ~137 sites
are covered again without entries in `matches.json`.

## build-report.json

Per-build adapter stats, committed alongside `epg.json`:

```json
{ "generatedAt": 0,
  "adapters": { "iptvx":   { "channels": 343, "withData": 331, "xmlMB": 312 },
                "mjh":     { "channels": 787, "files": 26, "paths": 27, "withData": 680 },
                "myjcom":  { "channels": 5, "withData": 5 },
                "epgshare":{ "channels": 1031, "files": 58, "regions": 58, "withData": 916 },
                "iptvorg": { "channels": 1500, "guideKB": 42000, "withData": 1100 },
                "epgpw":   { "channels": 420, "files": 21, "withData": 380 },
                "epgbest": { "skipped": "EPG_BEST_URL not set (see README)" } },
  "channelsWithData": 1916
```

## License

MIT — see [LICENSE](LICENSE).
