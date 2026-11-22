# Fixture tiles (CI only)

Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0,
https://www.openstreetmap.org/copyright). The tiles are the Protomaps basemap (https://protomaps.com),
whose rendering of OpenStreetMap is a Produced Work: the map shows the credit "© OpenStreetMap
contributors · Protomaps" wherever these tiles are displayed. OSM data lives only inside these tiles,
never in our tables (A§7.1).

## `planet-z2.pmtiles`

The whole world at z0–2: the e2e stack's stand-in for the production `nl-<build>.pmtiles`. The CI e2e
stack uploads it to the S3 stand-in as `tiles/nl-20261001.pmtiles` and writes the `tiles/current.json`
that names it; MapLibre overzooms it at the national view. CI never fetches a Protomaps build (P1d Q6).

It is the owner's recording for the Waterheight project (its `tools/geo/fixtures/planet-z2.pmtiles`),
copied byte for byte:

| | |
|---|---|
| Source | Protomaps daily build `20261001`, tiles version 4.15.2 |
| Made | 2026-10-01 with go-pmtiles 1.31.2, 5 HTTP Range requests |
| Command | `pmtiles extract https://build.protomaps.com/20261001.pmtiles planet-z2.pmtiles --maxzoom=2` |
| Header | spec 3, `mvt`, gzip, z0–2, bounds -180,-85.0511287,180,85.0511287, 21 tiles |
| Bytes | 864,227 |
| sha256 | `40edeada75d9551a0f29989a950c7d48e17d8633355a9fc7bfec351be63836c2` |
