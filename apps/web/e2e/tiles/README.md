# Fixture tiles (CI only)

Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0). The tiles are
the Protomaps basemap, whose rendering of OpenStreetMap is a Produced Work: the map shows the credit
"© OpenStreetMap contributors · Protomaps" wherever these tiles are displayed. OSM data lives only inside
these tiles, never in our tables (A§7.1).

## `fixture.pmtiles`

The CI e2e stack uploads it to the S3 stand-in as `tiles/nl-20261001.pmtiles` and writes the
`tiles/current.json` that names it. CI never fetches a Protomaps build (P1d Q6).

**Interim file.** The owner's Q6 answer is a few km² of Amsterdam that the owner records with
`scripts/record-fixture-tiles.ts` (it rewrites this file and this README). Until then this is the owner's
earlier recording of the whole world at z0–2 for the Waterheight project (its
`tools/geo/fixtures/planet-z2.pmtiles`), copied byte for byte; MapLibre overzooms it at the national view.

| | |
|---|---|
| Source | Protomaps daily build `20261001`, tiles version 4.15.2 |
| Made | 2026-10-01 with go-pmtiles 1.31.2, 5 HTTP Range requests |
| Command | `pmtiles extract https://build.protomaps.com/20261001.pmtiles planet-z2.pmtiles --maxzoom=2` |
| Header | spec 3, `mvt`, gzip, z0–2, bounds -180,-85.0511287,180,85.0511287, 21 tiles |
| Bytes | 864227 |
| sha256 | `40edeada75d9551a0f29989a950c7d48e17d8633355a9fc7bfec351be63836c2` |
