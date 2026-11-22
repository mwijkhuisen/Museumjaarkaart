import { NearList } from '@mjk/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, getJson } from '../../lib/api.ts';
import { formatCount, formatDistance } from '../../lib/format.ts';
import { museumName } from '../../lib/names.ts';
import { roundPosition } from '../../lib/near.ts';
import { Link } from '../../lib/router.tsx';
import { apiPath, type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { IconMapPin } from '../ui/icons.tsx';

// Near me (A§15.3). Rendered only after hydration and only when the browser has a Geolocation API.
// Nothing happens until the button is pressed. The position is rounded to 3 decimals before the
// request, kept in no URL, history, storage, log or console, and dropped once the request is sent
// (only the rounded values go to `onLocated`, which centres the map).
//
// DOM contract for the e2e specs:
//   section#near-me               exists only after hydration, and only with navigator.geolocation
//   button#near-me-button         the press that asks for the position
//   div#near-me-status            role="status" aria-live="polite": the progress, the error or the count
//   ol#near-me-results            the answers in the API's order, one `li` each with a link to the
//                                 museum page and the distance in `span.near-me__distance`

const GEO_ERROR = { 1: () => m.near_denied(), 2: () => m.near_unavailable(), 3: () => m.near_timeout() } as const;

type State =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'done'; items: NearList['items'] }
  | { status: 'error'; message: string };

export function NearMe({
  locale,
  onLocated,
}: {
  locale: Locale;
  /** The rounded position, to centre the map on when it is ready. */
  onLocated: (lat: number, lon: number) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<State>({ status: 'idle' });
  const abort = useRef<AbortController | null>(null);
  // The latest callback: the map may become ready after the button was pressed.
  const located = useRef(onLocated);
  located.current = onLocated;

  useEffect(() => {
    setAvailable('geolocation' in navigator);
    return () => abort.current?.abort();
  }, []);

  if (!available) return null;

  const failed = (message: string) => setState({ status: 'error', message });

  const found = async (position: GeolocationPosition, signal: AbortSignal) => {
    try {
      const at = roundPosition(position.coords.latitude, position.coords.longitude);
      const answer = await getJson(apiPath.near(at.lat, at.lon), NearList, (input, init) =>
        fetch(input, { ...init, signal }),
      );
      if (signal.aborted) return;
      setState({ status: 'done', items: answer.items });
      located.current(Number(at.lat), Number(at.lon));
    } catch (err) {
      if (signal.aborted) return;
      // The API's 400 is a position outside the Netherlands (the contract's box).
      failed(err instanceof ApiFailure && err.status === 400 ? m.near_outside() : m.near_failed());
    }
  };

  const press = () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ status: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (position) => void found(position, controller.signal),
      (error) => {
        if (controller.signal.aborted) return;
        failed((GEO_ERROR[error.code as 1 | 2 | 3] ?? GEO_ERROR[2])());
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const message =
    state.status === 'locating'
      ? m.near_locating()
      : state.status === 'error'
        ? state.message
        : state.status === 'done'
          ? state.items.length === 0
            ? m.near_empty()
            : m.near_found({ count: formatCount(state.items.length, locale) })
          : '';

  return (
    <section id="near-me" className="stack" aria-labelledby="near-me-heading">
      <h2 id="near-me-heading" className="visually-hidden">
        {m.near_heading()}
      </h2>
      <p>
        <button
          id="near-me-button"
          type="button"
          className="button"
          disabled={state.status === 'locating'}
          onClick={press}
        >
          <IconMapPin /> {m.near_button()}
        </button>
      </p>
      <div id="near-me-status" role="status" aria-live="polite">
        {message}
      </div>
      {state.status === 'done' && state.items.length > 0 ? (
        <ol id="near-me-results" className="near-me__list">
          {state.items.map((item) => (
            <li key={item.id}>
              <Link href={pathOf({ page: 'museum', locale, slug: item.slug })}>{museumName(item, locale)}</Link>{' '}
              <span className="muted near-me__distance">{formatDistance(item.distance_m, locale)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
