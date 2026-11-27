import type { SavingsYear, VisitMuseum } from '@mjk/contracts';
import { formatCount, formatMoney } from '../../lib/format.ts';
import { museumName } from '../../lib/names.ts';
import { Link } from '../../lib/router.tsx';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';

/** A museum of the member's own lists: a link while it is public, else the name alone. */
export function MuseumRef({ museum, locale }: { museum: VisitMuseum; locale: Locale }) {
  const name = museumName(museum, locale);
  return museum.slug === null ? (
    <span>{name}</span>
  ) : (
    <Link href={pathOf({ page: 'museum', locale, slug: museum.slug })}>{name}</Link>
  );
}

// € saved per calendar year (A§10, Q8, Q9): the adult price counts for everyone, so the figure is
// an estimate. A museum without a usable price is named, a stale one marked.

export function Savings({ savings, locale }: { savings: readonly SavingsYear[]; locale: Locale }) {
  return (
    <section className="stack" aria-labelledby="passport-savings">
      <h2 id="passport-savings">{m.passport_h_savings()}</h2>
      <p className="muted">{m.passport_savings_note()}</p>
      {savings.length === 0 ? <p>{m.passport_savings_none()}</p> : null}
      {[...savings]
        .sort((a, b) => b.year - a.year)
        .map((y) => (
          <div key={`${y.year}-${y.card_type}`} className="card stack">
            <h3>{y.year}</h3>
            <dl className="facts">
              <div>
                <dt>{m.passport_saved()}</dt>
                <dd>
                  {formatMoney(y.saved_cents, locale)}{' '}
                  <span className="muted">({m.passport_counted({ n: formatCount(y.counted, locale) })})</span>
                </dd>
              </div>
              {y.card_price_cents === null ? null : (
                <div>
                  <dt>{m.passport_card_price()}</dt>
                  <dd>{formatMoney(y.card_price_cents, locale)}</dd>
                </div>
              )}
              <div>
                <dt>{m.passport_net()}</dt>
                <dd>
                  {y.reason === 'no_card_price' || y.net_cents === null
                    ? m.passport_no_card_price()
                    : formatMoney(y.net_cents, locale)}
                </dd>
              </div>
            </dl>
            {y.unpriced.length === 0 ? null : (
              <>
                <p>{m.passport_unpriced()}</p>
                <ul>
                  {y.unpriced.map((u) => (
                    <li key={u.museum.id}>
                      <MuseumRef museum={u.museum} locale={locale} />
                      {u.stale ? <span className="muted"> ({m.passport_price_stale()})</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))}
    </section>
  );
}
