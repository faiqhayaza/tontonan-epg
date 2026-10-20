# tontonan-epg

Program guide (EPG) data pipeline for [Tontonan](https://tontonan.online).

A scheduled GitHub Actions workflow (every 3 hours) runs `build-epg.mjs`, which
collects now/next programme data for the Tontonan catalog channels that have a
known guide source, and publishes a compact `epg.json`:

```json
{ "v": 1, "generatedAt": 0, "channels": { "<channelId>": [[startMs, endMs, "title"], ...] } }
```

The website fetches `epg.json` and shows the current and next programme where
data exists; channels without a guide source keep the site's "no guide
published" wording.

Sources (guide availability data: [iptv-org](https://github.com/iptv-org/database)):

- `epg.iptvx.one` XMLTV feed
- `i.mjh.nz` XMLTV files (matthuisman)
- `tvguide.myjcom.jp` JSON API (Japanese channels)

`matches.json` maps catalog channel ids to guide sources. Each source is
failure-isolated: if one is down, only its channels are missing from that build.
