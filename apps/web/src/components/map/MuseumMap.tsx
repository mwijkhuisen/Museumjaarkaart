import { MuseumPoints } from '@mjk/contracts';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, getJson } from '../../lib/api.ts';
import { MapError } from '../../lib/map/errors.ts';
import {
  addMuseumLayers,
  type MapView,
  readColours,
  type SelectedMuseum,
  showMarks,
  wireMuseums,
} from '../../lib/map/museumLayer.ts';
import { hasWebGL2 } from '../../lib/map/webgl.ts';
import { useMarks } from '../../lib/member.ts';
import { museumName } from '../../lib/names.ts';
import { Link } from '../../lib/router.tsx';
import { apiPath, pathOf, type Route } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { MuseumkaartStatus } from '../museum/MuseumkaartStatus.tsx';

// The museum map (A§15.3). Client only: MapPage mounts it from an effect after hydration, so the
// server never renders or imports it, and maplibre-gl, pmtiles and the style load as a lazy chunk
// (lib/map/createMap.ts) that only this component reaches, through a dynamic import.
//
// DOM contract for the e2e specs (apps/web/e2e):
//   section#museum-map-region   the map section; it exists only after hydration
//   div#museum-map              the container; `data-map-state` is "loading", "ready" or "error"
//                               (error: also `hidden`). Once "ready", the element property `mjkMap`
//                               is the MapLibre instance (read by the e2e specs; harmless: the CSP
//                               lets only our own scripts run). The basemap has loaded and the
//                               layers `museum-clusters`, `museum-cluster-count` and
//                               `museum-points` (source `museums`) are on it.
//   p#museum-map-status         role="status": the loading or error text, empty when ready
//   aside#museum-map-card        the card of the tapped museum (tabIndex -1, takes focus): an
//                               h3 with the name, the Museumkaart badge, a link to the museum page
//                               and the button#museum-map-card-close
// The list of the same museums is the MuseumResults list below the map (MapPage).

const CODES: Record<string, () => string> = {
  no_webgl: () => m.map_no_webgl(),
};

/** MapLibre's own UI strings in the page language (read when the map is made). */
const mapLabels = (): Record<string, string> => ({
  'Map.Title': m.map_label(),
  'NavigationControl.ZoomIn': m.map_zoom_in(),
  'NavigationControl.ZoomOut': m.map_zoom_out(),
  'AttributionControl.ToggleAttribution': m.map_toggle_attribution(),
});

const codeOf = (err: unknown): string => {
  if (err instanceof MapError) return err.code;
  return err instanceof ApiFailure ? 'points_failed' : 'map_failed';
};

type State = { status: 'loading' } | { status: 'ready' } | { status: 'error'; code: string };

export function MuseumMap({
  route,
  onView,
}: {
  route: Extract<Route, { page: 'map' }>;
  /** The map once it is ready (for near me to centre it), null when it goes away. */
  onView: (view: MapView | null) => void;
}) {
  const { locale } = route;
  // The effect keys on the points path, which ignores the pager's cursor.
  // ponytail: App's Boundary is keyed on the whole path, so a pager step still remounts the page and
  // the map returns to the national view; key the Boundary without `cursor` on the map page if that annoys.
  const pointsPath = apiPath.points(route.query);
  const container = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selected, setSelected] = useState<SelectedMuseum | null>(null);
  const marks = useMarks();
  const drawn = useRef<{ map: MapLibreMap; points: MuseumPoints } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: onView is the page's stable setState
  useEffect(() => {
    // Effects never run on the server; the constant lets the SSR build drop the map chunk too.
    if (import.meta.env.SSR) return;
    const el = container.current as (HTMLDivElement & { mjkMap?: MapLibreMap | undefined }) | null;
    if (el === null) return;
    const abort = new AbortController();
    const { signal } = abort;
    let created: { map: MapLibreMap; dispose(): void } | undefined;
    let unwire: (() => void) | undefined;
    setState({ status: 'loading' });
    setSelected(null);
    const run = async () => {
      if (!hasWebGL2()) throw new MapError('no_webgl');
      const colours = readColours(document.documentElement);
      // The points are fetched with the chunk: never from `mjk-state`, always for this query.
      const points = getJson(pointsPath, MuseumPoints, (input, init) => fetch(input, { ...init, signal }));
      points.catch(() => undefined);
      const { createMap } = await import('../../lib/map/createMap.ts');
      const made = await createMap(el, { lang: locale, labels: mapLabels(), signal });
      created = made;
      if (signal.aborted) return made.dispose();
      const data = await points;
      if (signal.aborted) return;
      // The card and the labels show the page language's name, as the list cards do.
      const named = { items: data.items.map((p) => ({ ...p, name: museumName(p, locale) })) };
      addMuseumLayers(made.map, named, colours);
      drawn.current = { map: made.map, points: named };
      unwire = wireMuseums(made.map, setSelected);
      el.mjkMap = made.map;
      onView(made.map);
      setState({ status: 'ready' });
    };
    run().catch((err: unknown) => {
      if (signal.aborted) return;
      created?.dispose();
      setState({ status: 'error', code: codeOf(err) });
    });
    return () => {
      abort.abort();
      unwire?.();
      el.mjkMap = undefined;
      drawn.current = null;
      onView(null);
      created?.dispose();
    };
  }, [locale, pointsPath]);

  // A member's marks arrive after the map, or before it: either way they are drawn once it is ready.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state.status` re-runs this when the map becomes ready
  useEffect(() => {
    if (marks !== undefined && drawn.current !== null) showMarks(drawn.current.map, drawn.current.points, marks);
  }, [marks, state.status]);

  // The card takes focus when it opens, and the map gets it back when it closes.
  useEffect(() => {
    if (selected !== null) card.current?.focus();
  }, [selected]);
  const close = () => {
    setSelected(null);
    container.current?.querySelector('canvas')?.focus();
  };

  const text =
    state.status === 'loading'
      ? m.map_loading()
      : state.status === 'error'
        ? (CODES[state.code]?.() ?? m.map_unavailable())
        : '';
  return (
    <section id="museum-map-region" className="map-region" aria-labelledby="museum-map-heading">
      <h2 id="museum-map-heading" className="visually-hidden">
        {m.map_label()}
      </h2>
      <p id="museum-map-status" role="status" className="muted">
        {text}
      </p>
      <div
        id="museum-map"
        ref={container}
        className="map-region__canvas"
        data-map-state={state.status}
        hidden={state.status === 'error'}
      />
      {marks === undefined ? null : <p className="muted">{m.marks_legend()}</p>}
      {selected === null ? null : (
        <aside
          id="museum-map-card"
          ref={card}
          tabIndex={-1}
          aria-label={m.map_card_label()}
          className="card stack map-card"
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
        >
          <h3>{selected.name}</h3>
          <p>
            <MuseumkaartStatus status={selected.status} locale={locale} />
          </p>
          <p>
            <Link href={pathOf({ page: 'museum', locale, slug: selected.slug })}>{m.map_card_view()}</Link>
          </p>
          <button id="museum-map-card-close" type="button" className="button" onClick={close}>
            {m.map_card_close()}
          </button>
        </aside>
      )}
    </section>
  );
}
