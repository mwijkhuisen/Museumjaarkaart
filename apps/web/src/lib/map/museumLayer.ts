import type { MuseumkaartStatus, MuseumPoints } from '@mjk/contracts';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapError } from './errors.ts';

// The museums as one clustered GeoJSON source (A§15.3): cluster circles with their count, and the
// single museums as symbols. Museumkaart museums differ by shape (a diamond, the others a circle)
// and by colour, never by colour alone. Only types come from maplibre-gl, so this module is in no
// chunk of its own and the tests import it freely. Everything the user can read comes from the
// museum's fields as text; nothing here builds HTML (invariant 5).

export const SOURCE = 'museums';
export const LAYER_CLUSTERS = 'museum-clusters';
export const LAYER_COUNT = 'museum-cluster-count';
export const LAYER_POINTS = 'museum-points';
const IMAGE_MK = 'museum-mk';
const IMAGE_OTHER = 'museum-other';

/** A tap or click finds a marker within this many CSS pixels (a 44 px target). */
const HIT = 22;
const IMAGE_SIZE = 56;
const PIXEL_RATIO = 2;

export type Rgb = readonly [number, number, number];
export type MarkerColours = { mk: string; other: string; cluster: string; outline: string };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rrggbb`, or `#rgb`: the CSS minifier shortens `#ffffff` to `#fff` in the built stylesheet. */
export function parseHex(hex: string): Rgb {
  if (!HEX.test(hex)) throw new MapError('colours_missing');
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  return [1, 3, 5].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** The marker colours are tokens of styles.css (`--color-map-*`); read once at mount. */
export function readColours(el: Element): MarkerColours {
  const style = getComputedStyle(el);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const colours = {
    mk: token('--color-map-mk'),
    other: token('--color-map-other'),
    cluster: token('--color-map-cluster'),
    outline: token('--color-map-outline'),
  };
  for (const value of Object.values(colours)) parseHex(value);
  return colours;
}

/** What near me needs of the map: to move the view. */
export type MapView = Pick<MapLibreMap, 'jumpTo' | 'easeTo'>;

export type MarkerShape = 'circle' | 'diamond';

/**
 * RGBA pixels of a marker: a filled shape with a ring in the outline colour, antialiased by its
 * signed distance. Computed in code, so no image file and no `data:` URL (A§15.6).
 */
export function markerImage(shape: MarkerShape, fill: Rgb, outline: Rgb, size: number, ring = size / 8) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  const r = c - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;
      const d = shape === 'circle' ? Math.hypot(px, py) - r : (Math.abs(px) + Math.abs(py) - r) / Math.SQRT2;
      const alpha = Math.min(1, Math.max(0, 0.5 - d));
      const edge = Math.min(1, Math.max(0, d + ring + 0.5));
      const at = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) data[at + k] = Math.round((fill[k] ?? 0) * (1 - edge) + (outline[k] ?? 0) * edge);
      data[at + 3] = Math.round(alpha * 255);
    }
  }
  return { width: size, height: size, data };
}

/** The points as GeoJSON; the properties are the three fields the card needs, all text. */
export function pointsGeoJson(points: MuseumPoints) {
  return {
    type: 'FeatureCollection' as const,
    features: points.items.map((p) => ({
      type: 'Feature' as const,
      properties: { slug: p.slug, name: p.name, status: p.museumkaart_status },
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
    })),
  };
}

export const prefersReducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Moves the view: a jump under `prefers-reduced-motion`, else an eased move. */
export function moveTo(map: MapView, center: [number, number], zoom: number): void {
  if (prefersReducedMotion()) map.jumpTo({ center, zoom });
  else map.easeTo({ center, zoom });
}

export function addMuseumLayers(map: MapLibreMap, points: MuseumPoints, colours: MarkerColours): void {
  const outline = parseHex(colours.outline);
  map.addImage(IMAGE_MK, markerImage('diamond', parseHex(colours.mk), outline, IMAGE_SIZE), {
    pixelRatio: PIXEL_RATIO,
  });
  map.addImage(IMAGE_OTHER, markerImage('circle', parseHex(colours.other), outline, IMAGE_SIZE), {
    pixelRatio: PIXEL_RATIO,
  });
  map.addSource(SOURCE, {
    type: 'geojson',
    data: pointsGeoJson(points),
    cluster: true,
    clusterRadius: 50,
    clusterMaxZoom: 12,
  });
  map.addLayer({
    id: LAYER_CLUSTERS,
    type: 'circle',
    source: SOURCE,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': colours.cluster,
      'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 50, 25, 200, 30],
      'circle-stroke-color': colours.outline,
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: LAYER_COUNT,
    type: 'symbol',
    source: SOURCE,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Medium'],
      'text-size': 14,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': colours.outline },
  });
  map.addLayer({
    id: LAYER_POINTS,
    type: 'symbol',
    source: SOURCE,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': ['case', ['==', ['get', 'status'], 'participating'], IMAGE_MK, IMAGE_OTHER],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

export type SelectedMuseum = { slug: string; name: string; status: MuseumkaartStatus };

const STATUSES: readonly string[] = ['participating', 'left', 'unknown'];

/** The card's data from a feature's properties; null for anything that is not one of our points. */
export function selectedOf(properties: Record<string, unknown> | null | undefined): SelectedMuseum | null {
  const { slug, name, status } = properties ?? {};
  if (typeof slug !== 'string' || typeof name !== 'string' || typeof status !== 'string') return null;
  if (!STATUSES.includes(status)) return null;
  return { slug, name, status: status as MuseumkaartStatus };
}

/**
 * Click and pointer behaviour. A tap on a cluster zooms to where it breaks up; a tap on a museum
 * calls `onSelect` (the page's React card). Returns the cleanup.
 */
export function wireMuseums(map: MapLibreMap, onSelect: (museum: SelectedMuseum) => void): () => void {
  const canvas = map.getCanvas();
  const pointer = () => {
    canvas.style.cursor = 'pointer';
  };
  const plain = () => {
    canvas.style.cursor = '';
  };
  const click = (e: { point: { x: number; y: number } }) => {
    const { x, y } = e.point;
    const hits = map.queryRenderedFeatures(
      [
        [x - HIT, y - HIT],
        [x + HIT, y + HIT],
      ],
      { layers: [LAYER_CLUSTERS, LAYER_POINTS] },
    );
    let best: (typeof hits)[number] | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const hit of hits) {
      if (hit.geometry.type !== 'Point') continue;
      const [lon = 0, lat = 0] = hit.geometry.coordinates;
      const at = map.project([lon, lat]);
      const distance = Math.hypot(at.x - x, at.y - y);
      if (distance < bestDistance) {
        best = hit;
        bestDistance = distance;
      }
    }
    if (best === undefined || best.geometry.type !== 'Point') return;
    const [lon = 0, lat = 0] = best.geometry.coordinates;
    const clusterId = best.properties?.cluster_id;
    if (typeof clusterId === 'number') {
      const source = map.getSource(SOURCE);
      if (source !== undefined && 'getClusterExpansionZoom' in source) {
        void (source as unknown as { getClusterExpansionZoom(id: number): Promise<number> })
          .getClusterExpansionZoom(clusterId)
          // At a fractional zoom the expansion zoom of a cluster can be at or below the current one
          // (clusters are made per integer zoom): a tap on a cluster always zooms in at least one level.
          .then((zoom) => moveTo(map, [lon, lat], Math.max(zoom, map.getZoom() + 1)))
          .catch(() => undefined);
      }
      return;
    }
    const museum = selectedOf(best.properties);
    if (museum !== null) onSelect(museum);
  };
  map.on('click', click);
  for (const layer of [LAYER_CLUSTERS, LAYER_POINTS]) {
    map.on('mouseenter', layer, pointer);
    map.on('mouseleave', layer, plain);
  }
  return () => {
    map.off('click', click);
    for (const layer of [LAYER_CLUSTERS, LAYER_POINTS]) {
      map.off('mouseenter', layer, pointer);
      map.off('mouseleave', layer, plain);
    }
  };
}
