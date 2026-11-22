// The one module that imports maplibre-gl and pmtiles (A§15.3): everything else reaches it only
// through `import('…/createMap.ts')`, so both libraries, MapLibre's worker and its stylesheet are a
// lazy chunk that only /kaart and /en/map load. Everything MapLibre needs comes from our own
// origins: the worker is a same-origin module URL (no blob:, Waterheight ADR-0016), glyphs and
// sprites are under /map/, the tiles come from media.<domain> through the pmtiles protocol.
import { NL_BOX } from '@mjk/contracts';
import { addProtocol, Map as MapLibreMap, type MapOptions, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import type { Locale } from '../routes.ts';
import { MapError } from './errors.ts';
import { prefersReducedMotion } from './museumLayer.ts';
import { acquireProtocol } from './protocol.ts';
import { resolveStyle } from './resolveStyle.ts';
import { loadTilesPointer, mediaOrigin } from './tiles.ts';

type Style = Exclude<MapOptions['style'], string | undefined>;

const styles = {
  nl: () => import('./styles/style-nl.json'),
  en: () => import('./styles/style-en.json'),
};

/** The whole Netherlands (`NL_BOX`) fits any viewport; panning stops a little outside it. */
const NL_BOUNDS: [[number, number], [number, number]] = [
  [NL_BOX.lonMin, NL_BOX.latMin],
  [NL_BOX.lonMax, NL_BOX.latMax],
];
// Wide enough that the whole country still fits a wide desktop canvas (about 2.6:1, where 1° of lat at
// 52° N takes the width of 1.6° of lon) and a tall phone; outside the extract there is only background.
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [NL_BOX.lonMin - 5, NL_BOX.latMin - 1.5],
  [NL_BOX.lonMax + 5, NL_BOX.latMax + 1.5],
];

export interface CreatedMap {
  map: MapLibreMap;
  /** Removes the map and releases its hold on the pmtiles protocol (which stays registered); safe to call twice. */
  dispose(): void;
}

/**
 * A map in `container` with the basemap loaded (the `load` event). `labels` are MapLibre's own UI
 * strings in the page language. Rejects with a `MapError` when `current.json`, the style or the
 * basemap's tiles are unusable, and with an AbortError after `signal` aborts.
 */
export async function createMap(
  container: HTMLElement,
  { lang, labels, signal }: { lang: Locale; labels: Record<string, string>; signal: AbortSignal },
): Promise<CreatedMap> {
  setWorkerUrl(workerUrl);
  const media = mediaOrigin(location.hostname);
  const [pointer, style] = await Promise.all([loadTilesPointer(media, signal), styles[lang]().then((s) => s.default)]);
  signal.throwIfAborted();
  // metadata off, explicitly (it is also pmtiles' default): the archive's own attribution HTML
  // never reaches MapLibre's attribution control; the style's plain-text constant does.
  const release = acquireProtocol({ addProtocol }, () => new Protocol({ metadata: false }).tile);
  let map: MapLibreMap | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    map?.remove();
    release();
  };
  try {
    map = new MapLibreMap({
      container,
      style: resolveStyle(style, pointer.file, location.origin, media) as unknown as Style,
      bounds: NL_BOUNDS,
      fitBoundsOptions: { padding: 16 },
      maxBounds: MAX_BOUNDS,
      maxPitch: 0,
      dragRotate: false,
      attributionControl: { compact: true },
      locale: labels,
      ...(prefersReducedMotion() ? { fadeDuration: 0 } : {}),
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    await loaded(map, signal);
    return { map, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** Resolves on `load`; rejects when the basemap's source fails first, or on abort. */
function loaded(map: MapLibreMap, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fail?: unknown) => {
      map.off('load', onLoad);
      map.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (fail === undefined) resolve();
      else reject(fail);
    };
    const onLoad = () => done();
    const onError = (e: unknown) => {
      if ((e as { sourceId?: string }).sourceId === 'basemap') done(new MapError('tiles_unavailable'));
    };
    const onAbort = () => done(signal.reason);
    map.on('load', onLoad);
    map.on('error', onError);
    signal.addEventListener('abort', onAbort);
  });
}
