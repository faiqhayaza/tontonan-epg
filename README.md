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
  adapter excluded; capped at 1,500 channels per build in the workflow —
  the script default is 2,500), runs the grab
  for one day, and merges the resulting `iptvorg-guide.xml`. Best
  effort: a grab failure only skips that adapter for one build.
- `epg.pw` per-country XMLTV files (20 countries, daily) — matched to
  the catalog by display-name, since its channel ids are opaque numbers;
  a name is accepted only when it is unique on both sides (one catalog
  channel in the country, and one guide id in the file — "BBC One" and
  "BBC One HD" both normalize to "bbcone", so neither maps)
- `epg.best` personal XMLTV feed — read from the `EPG_BEST_URL`
  environment variable (a repo secret in the workflow). epg.best issues
  the feed URL per (free) account, so there is no public URL to fetch;
  the adapter skips cleanly when the variable is unset. To enable it,
  register at https://epg.best/, copy the personal EPG URL, and set it
  as the `EPG_BEST_URL` repository secret. No account is created by
  this repo. The URL is a secret: its fetch errors are recorded in
  `build-report.json` under the label `epgbest feed (EPG_BEST_URL)`,
  never the URL itself (the full URL goes to the workflow log only).

`matches.json` maps catalog channel ids to guide sources. Each source is
failure-isolated: if one is down, only its channels are missing from that build.
Each catalog channel takes its schedule from ONE upstream guide id: the
generic adapters keep a claimed set, so a second guide id resolving to an
already-claimed channel is skipped, never appended.

## Running locally

Requires Node.js 20 or later. No dependencies to install (zero-dependency
project — only the Node standard library).

```sh
node build-epg.mjs   # writes epg.json + build-report.json
npm test             # unit tests: lib helpers, pipeline (gate/matchers), fetch, scripts
npm run check        # syntax-checks every .mjs file (lib, scripts, tests)
```

A local run skips the `iptvorg` adapter (no `iptvorg-guide.xml` unless
you run the grabber yourself — see `scripts/iptvorg-channels.mjs`) and
the `epgbest` adapter (no `EPG_BEST_URL`); the other adapters run as
in the workflow.

`iptvorg.channels.json` and `iptvorg.channels.xml` are committed: the
workflow commits them on every run as the audit trail of what the
grabber was asked to fetch, and they stay committed (decision of
2026-11-18). Consequences: a CI
checkout always has `iptvorg.channels.json`, so the adapter's
"`iptvorg.channels.json` not present (grab step did not run)" skip is
reachable only locally or in a clone without the file — in CI a failed
clone or grab shows up as "`iptvorg-guide.xml` not present (grab step
did not run or produced nothing)"; and if the generate step fails, the
grab runs on the previous run's committed list.

## Failure gate

The build is gated: it fails (non-zero exit, workflow fails, GitHub
notifies) and does NOT overwrite `epg.json` when it produces zero
channels with data, more than 25% fewer than the last build that
passed the gate, any overlapping programmes on a channel, or any
zero-length/inverted programme. The baseline is
`lastGoodChannelsWithData` from the previous `build-report.json`, which
only advances when the gate passes — so a gated (degraded) build never
becomes the next build's baseline. The flip side: a drop that is real
and permanent (an upstream gone for good) keeps failing the gate until
the baseline is reset by hand — set `lastGoodChannelsWithData` in
`build-report.json` to the new expected count (or to `null`, which
leaves only the zero-channel rule for the next build) and commit it.
`build-report.json` is written on
every run that reaches the end of the build — including a gated build
and one that hits the build's own overall deadline (50 minutes by
default, `EPG_BUILD_DEADLINE_MS` to override: the adapter running at
the deadline is abandoned, the later ones are recorded as not run, and
the gate fails) — so a failed build still leaves its report (with the
failing URL and gate reason) in the repo. The one case with no report
is a run killed from outside: the workflow's 90-minute job timeout
(the deadline keeps the build itself inside it; the timeout only bites
if the clone/grab steps before the build overrun) or a dead runner.
The worst case without the deadline — every fetch timing out and being
retried — is ~385 minutes (the per-leg sum is in `build-epg.mjs`,
`TIMEOUT_MS`). This gate exists because in November 2026
the epgshare outage halved output to ~1,000 channels for two days while
the workflow stayed green and kept committing the degraded file.

## When an adapter fails

Read `build-report.json` — a failed adapter is recorded there with its
error message and, for fetch failures, the URL that failed (each fetch
is tagged with its URL, so a repeat of the November 2026 epgshare
incident is diagnosable from the report alone; the secret epg.best URL
is the one exception, recorded by label). Per-file failures are
also printed to the workflow log (`console.error`). The failure gate
above decides whether a degraded build may overwrite `epg.json`.

Known smaller gaps (mjh, verified 2026-11-16): three `i.mjh.nz` paths fail
every build. `Flash/epg` 404s upstream, so the 9 channels mapped to it
(CNN, MSNBC, NBC News NOW, …) have no guide data until matthuisman's repo
restores it or the entries are remapped. `Roku/all` (~37 MB) and
`SkyGo/epg` (~69 MB) exceed the 20 MB per-file cap, so their 38 channels
have no guide data; raising the cap is a repo-owner decision, so this
stays as documented loss rather than a fix.

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

`--prune-stale` (and `scripts/iptvorg-channels.mjs`) load the catalog
through `lib/catalog.mjs`, which refuses a catalog with no `channels`
array, and `--prune-stale` refuses to drop more than half of the
entries unless `--force` is given — a broken catalog cannot empty
`matches.json`.

Review the git diff before committing a prune. There is no way to
re-derive `matches.json` from a single upstream index any more (iptv-org
restructured its database to CSVs and per-site configs), so the script
maintains the file from its current content plus live checks. The
2,232 pruned entries are not lost work: the iptv-org grabber path
(`scripts/iptvorg-channels.mjs`) re-derives the same channel→site
mapping from the live sites data on every build, so those ~137 sites
are covered again without entries in `matches.json`.

## build-report.json

Per-build adapter stats, committed alongside `epg.json`. `channels` is
the number of channels the adapter attempted (matches.json rows for
iptvx/mjh/myjcom; matched catalog channels for epgshare/epgpw/epgbest;
the guide's wanted channels for iptvorg) — one definition everywhere,
so the per-adapter numbers are comparable; the per-adapter `withData`
figures sum to `channelsWithData`.

Example, in the current report shape. The `generatedAt`, `adapters`,
`channelsWithData` and `gate` values are the real committed report of
the 2026-11-16 build (`generatedAt` 1794858367826), excerpted: two of
mjh's three `failedPaths` entries (`Flash/epg` 404, `SkyGo/epg` over
the cap) are left out for length. That build predates
`lastGoodChannelsWithData`, `scan` and `repair`, so those three fields
are shown as a build that passes today's gate records them — the gate
passed, so the last-good count is this run's count, and a passing
build's scan is necessarily all zero (any overlap fails the gate).
The `repair` figures are the counts from repairing the shipped guide
(5,118 overlaps across 104 channels; 1,002 clipped, 1,172 dropped),
with the top three `perChannel` entries shown:

```json
{
  "generatedAt": 1794858367826,
  "adapters": {
    "iptvx": { "channels": 343, "withData": 334, "xmlMB": 262.7 },
    "mjh": {
      "channels": 787, "files": 24, "paths": 27, "withData": 649,
      "failedPaths": [
        {
          "path": "Roku/all",
          "error": "downloaded 37521702 bytes, exceeds cap 20971520 (https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/Roku/all.xml)",
          "url": "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/Roku/all.xml"
        }
      ]
    },
    "myjcom": { "channels": 5, "withData": 5 },
    "epgshare": { "channels": 1037, "files": 59, "regions": 59, "withData": 910, "catalogGeneratedAt": "2026-11-12T02:03:21.745Z" },
    "iptvorg": { "channels": 1378, "withData": 752, "guideKB": 9672 },
    "epgpw": { "channels": 433, "files": 20, "withData": 417 },
    "epgbest": { "skipped": "EPG_BEST_URL not set (see README)" }
  },
  "channelsWithData": 3067,
  "lastGoodChannelsWithData": 3067,
  "gate": { "prevChannelsWithData": 3025, "pass": true },
  "scan": { "overlaps": 0, "overlapChannels": 0, "zeroLength": 0, "perChannel": {} },
  "repair": { "clipped": 1002, "dropped": 1172, "perChannel": { "Channel5.uk": 112, "64305451fc3be5947773c339-678fe7959407a53556d3e8eb": 111, "France4.fr@SD": 106 } }
}
```

- `lastGoodChannelsWithData` — the gate's baseline for the next build:
  this run's count when the gate passed, else carried forward from the
  previous report.
- `gate` — `{ prevChannelsWithData, pass }` plus `reasons` (a list of
  strings) when it failed. `prevChannelsWithData` is the baseline the
  gate compared against: the previous report's
  `lastGoodChannelsWithData`, not necessarily the previous build's count.
- `scan` — `{ overlaps, overlapChannels, zeroLength, perChannel }`, the
  schedule scan of the final `epg.json` map (`perChannel` lists overlap
  counts per channel, largest first).
- `repair` — `{ clipped, dropped, perChannel }`, the overlap repair of
  the final `epg.json` map before the scan (`perChannel` counts clipped
  + dropped per channel, largest first). `clipped` is the number of
  programmes whose end was shortened to the next programme's start;
  `dropped` is the number removed (same-start duplicate, or invalid).
  Always present, even when 0.
- `matchesError` — present only when `matches.json` could not be
  loaded (its text is also one of the gate's `reasons`).

## License

MIT — see [LICENSE](LICENSE).
