// The Wikidata query as a module, so `tsc -b` emits it into `dist` (the image runs every role from
// there and holds no `.sparql` file). It is byte-identical to `wikidata.sparql`, the readable copy that
// the runbook's curl sends; a unit test compares the two, and the fixtures' meta files pin its sha256.
// `String.raw` keeps every backslash as written (`"\u001F"` is SPARQL's escape, not JavaScript's).

export const WIKIDATA_QUERY = String.raw`# mjk museum sync (P1a plan 2.2): every museum in the European Netherlands, one row per item.
# Changing this file changes its sha256, which test/museums/sources/wikidata.test.ts pins to
# test/fixtures/museums/wikidata/*.meta.json: re-record the fixtures (scripts/record-fixture.ts) with it.
#
# Truthy (wdt:) values only. Multi-values come back through GROUP_CONCAT, split in TypeScript
# before any cleaning: records are separated by U+001F; the fields of the municipality record by U+001E.
# Dissolved items (P576) are included on purpose: closures need them; the parser takes the earliest date.
#
# The rows of an item come from a UNION, so each row leaves most variables unbound. Under SPARQL 1.1
# one error makes a whole aggregate an error, so no aggregated expression may fail: each one is
# COALESCE'd to "", which the parser reads as absent (an empty record is dropped, an empty label is
# no label). MAX picks the one value over "" (one label and one description per language).
#
# WDQS runs Blazegraph, and the query leans on two of its behaviours (the owner's probes, 2026-11-02):
# - The item set is a named subquery (WITH ... AS %items, a Blazegraph extension), computed once, and
#   every UNION branch starts with INCLUDE %items. A sub-select joined to the UNION timed out (HTTP 504)
#   even for three items: the branches were evaluated over all of Wikidata.
# - No P131? or P131* path: unbound at both ends it matches every node, and bound at both ends it
#   was walked from the far end. The municipality takes one and two hops as two branches, the
#   Caribbean filter one to three hops, all written from the bound item.
# - hint:Query hint:optimizer "None" keeps the join order as written. With 1,430 items the planner
#   could start a branch from a pattern it thought smaller (all municipalities with a CBS code)
#   instead of the items: the full run took 42 s once and timed out (HTTP 504) the next time, while
#   60 items took 1.4 s. So every group below is written in the order it must run.
PREFIX hint: <http://www.bigdata.com/queryHints#>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT ?item
  (MAX(COALESCE(STR(?lNl), "")) AS ?labelNl)
  (MAX(COALESCE(STR(?lEn), "")) AS ?labelEn)
  (MAX(COALESCE(STR(?dNl), "")) AS ?descNl)
  (MAX(COALESCE(STR(?dEn), "")) AS ?descEn)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?alias), ""); SEPARATOR="\u001F") AS ?aliases)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?coord), ""); SEPARATOR="\u001F") AS ?coords)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?site), ""); SEPARATOR="\u001F") AS ?websites)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?addr), ""); SEPARATOR="\u001F") AS ?addresses)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?pc), ""); SEPARATOR="\u001F") AS ?postcodes)
  (GROUP_CONCAT(DISTINCT COALESCE(?muniRec, ""); SEPARATOR="\u001F") AS ?municipalities)
  (MAX(COALESCE(?reg, "false")) AS ?registered)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?mnl), ""); SEPARATOR="\u001F") AS ?museumnl)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?image), ""); SEPARATOR="\u001F") AS ?images)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?class), ""); SEPARATOR="\u001F") AS ?classes)
  (GROUP_CONCAT(DISTINCT COALESCE(STR(?end), ""); SEPARATOR="\u001F") AS ?dissolved)
WITH {
  # The items, once each (an item with two museum classes would otherwise be multiplied):
  # 1,437 items, 1,430 after the Caribbean filter (the owner's probes, 2026-11-02).
  SELECT DISTINCT ?item WHERE {
    # The museum classes first (1.6 s in this order, the owner's probe), then their Dutch items.
    ?class wdt:P279* wd:Q33506 .
    ?item wdt:P31 ?class ;
          wdt:P17 wd:Q55 .
    # A restricted recording's VALUES goes here, after the selection, so the order above holds.
    # @@MJK_VALUES@@
    # Not the Caribbean Netherlands (owner decision Q3): Q27561 and, in case the chain is incomplete,
    # its three public bodies Bonaire, Sint Eustatius and Saba [U QIDs], one to three P131 hops up
    # from the item (the island, a place on it, a part of that place). The parser also drops
    # coordinates outside the NL box. Each hop starts from the bound item: a P131* path to the four
    # was walked down from them for every item, 15 s of the run with the join order pinned.
    OPTIONAL { ?item wdt:P131 ?up1 . FILTER(?up1 IN (wd:Q27561, wd:Q25396, wd:Q26180, wd:Q25528)) }
    OPTIONAL { ?item wdt:P131 ?a2 . ?a2 wdt:P131 ?up2 . FILTER(?up2 IN (wd:Q27561, wd:Q25396, wd:Q26180, wd:Q25528)) }
    OPTIONAL {
      ?item wdt:P131 ?a3 . ?a3 wdt:P131 ?b3 . ?b3 wdt:P131 ?up3 .
      FILTER(?up3 IN (wd:Q27561, wd:Q25396, wd:Q26180, wd:Q25528))
    }
    FILTER(!BOUND(?up1) && !BOUND(?up2) && !BOUND(?up3))
  }
} AS %items
WHERE {
  hint:Query hint:optimizer "None" .
  # One UNION branch per kind of value, so an item's rows add up (one row per value) instead of
  # multiplying. A join of these as OPTIONALs makes every combination of aliases, links, images and
  # classes, and ran past the WDQS 60 s limit (HTTP 504, 2026-11-02).
  {
    # Every selected item has one (the selection goes through it), so no item loses its row.
    INCLUDE %items . ?item wdt:P31 ?class .
  } UNION {
    INCLUDE %items . ?item rdfs:label ?lNl FILTER(LANG(?lNl) = "nl")
  } UNION {
    INCLUDE %items . ?item rdfs:label ?lEn FILTER(LANG(?lEn) = "en")
  } UNION {
    INCLUDE %items . ?item schema:description ?dNl FILTER(LANG(?dNl) = "nl")
  } UNION {
    INCLUDE %items . ?item schema:description ?dEn FILTER(LANG(?dEn) = "en")
  } UNION {
    INCLUDE %items . ?item skos:altLabel ?alias FILTER(LANG(?alias) IN ("nl", "en"))
  } UNION {
    INCLUDE %items . ?item wdt:P625 ?coord .
  } UNION {
    INCLUDE %items . ?item wdt:P856 ?site .
  } UNION {
    INCLUDE %items . ?item wdt:P6375 ?addr .
  } UNION {
    INCLUDE %items . ?item wdt:P281 ?pc .
  } UNION {
    # The municipality, one P131 hop away: a live item with a CBS code, its Dutch label and its province's ISO code.
    INCLUDE %items . ?item wdt:P131 ?muni .
    ?muni wdt:P382 ?cbs .
    OPTIONAL { ?muni wdt:P576 ?muniEnd }
    FILTER(!BOUND(?muniEnd))
    OPTIONAL { ?muni rdfs:label ?muniLabel FILTER(LANG(?muniLabel) = "nl") }
    OPTIONAL { ?muni wdt:P131 ?prov . ?prov wdt:P300 ?provIso }
    BIND(CONCAT(STR(?cbs), "\u001E", COALESCE(STR(?muniLabel), ""), "\u001E", COALESCE(STR(?provIso), "")) AS ?muniRec)
  } UNION {
    # The same, two P131 hops away (a museum in a village or a neighbourhood).
    INCLUDE %items . ?item wdt:P131 ?part . ?part wdt:P131 ?muni .
    ?muni wdt:P382 ?cbs .
    OPTIONAL { ?muni wdt:P576 ?muniEnd }
    FILTER(!BOUND(?muniEnd))
    OPTIONAL { ?muni rdfs:label ?muniLabel FILTER(LANG(?muniLabel) = "nl") }
    OPTIONAL { ?muni wdt:P131 ?prov . ?prov wdt:P300 ?provIso }
    BIND(CONCAT(STR(?cbs), "\u001E", COALESCE(STR(?muniLabel), ""), "\u001E", COALESCE(STR(?provIso), "")) AS ?muniRec)
  } UNION {
    INCLUDE %items . ?item wdt:P166 wd:Q110989587 . BIND("true" AS ?reg)
  } UNION {
    INCLUDE %items . ?item wdt:P973 ?mnl .
  } UNION {
    INCLUDE %items . ?item wdt:P18 ?image .
  } UNION {
    INCLUDE %items . ?item wdt:P576 ?end .
  }
}
GROUP BY ?item
`;
