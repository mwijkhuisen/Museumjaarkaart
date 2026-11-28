import { MuseumDetail } from '@mjk/contracts';
import type { ReactNode } from 'react';
import { Loading } from '../components/layout/Layout.tsx';
import { ClosureNote } from '../components/museum/ClosureNote.tsx';
import { CATEGORY_LABEL } from '../components/museum/categories.ts';
import { MuseumImage } from '../components/museum/MuseumImage.tsx';
import { MuseumkaartStatus } from '../components/museum/MuseumkaartStatus.tsx';
import { MarkSlot, VisitForm } from '../components/museum/MuseumMarks.tsx';
import { PROVINCE_NAME, provinceSlugOf } from '../components/museum/provinces.ts';
import { MyReviewSlot } from '../components/reviews/MyReviewSlot.tsx';
import { ScoreSummary } from '../components/reviews/ScoreSummary.tsx';
import { IconCheck, IconExternal, IconMapPin } from '../components/ui/icons.tsx';
import { useApi } from '../lib/api.ts';
import { museumName } from '../lib/names.ts';
import { Link } from '../lib/router.tsx';
import { apiPath, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

/** "—" with the reason: an unknown value is never silently blank (A§2, principle 4). */
function Unknown() {
  return (
    <>
      — <span className="muted">{m.fact_unknown()}</span>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A link-out: the host as its text (data, not UI text), an icon and a hidden note for screen readers. */
function External({ href }: { href: string }) {
  return (
    <a href={href} rel="noopener noreferrer">
      {hostOf(href)} <IconExternal /> <span className="visually-hidden">{m.link_external()}</span>
    </a>
  );
}

export function Museum({ route }: { route: Extract<Route, { page: 'museum' }> }) {
  const museum = useApi(apiPath.museum(route.slug), MuseumDetail);
  if (museum === undefined) return <Loading />;
  const { locale } = route;
  const description = locale === 'en' ? (museum.description_en ?? museum.description_nl) : museum.description_nl;
  const street = [museum.street, museum.house_number].filter((s) => s !== null).join(' ');
  const town = [museum.postcode, museum.place].filter((s) => s !== null).join(' ');
  const address = [street, town].filter((s) => s !== '');
  const provinceSlug = museum.province_code === null ? undefined : provinceSlugOf(museum.province_code);
  return (
    <article className="stack">
      <h1>{museumName(museum, locale)}</h1>
      {museum.place === null ? null : (
        <p className="muted">
          <IconMapPin /> {museum.place}
        </p>
      )}
      <p className="cluster">
        <span>
          <MuseumkaartStatus
            status={museum.museumkaart_status}
            listDate={museum.mk_list?.published_on}
            locale={locale}
          />
        </span>
        {museum.registered ? (
          <span className="badge">
            <IconCheck /> {m.museum_registered()}
          </span>
        ) : null}
      </p>
      <MarkSlot museumId={museum.id} name={museumName(museum, locale)} />
      <ClosureNote
        closedOn={museum.closed_on}
        tempClosed={museum.temp_closed}
        tempClosedUntil={museum.temp_closed_until}
        locale={locale}
      />
      {museum.image === null ? null : <MuseumImage image={museum.image} museum={museumName(museum, locale)} />}
      {description === null ? null : <p>{description}</p>}
      <section className="stack" aria-labelledby="museum-score">
        <h2 id="museum-score">{m.score_h()}</h2>
        <ScoreSummary museum={museum} locale={locale} readSlug={museum.slug} />
      </section>
      <section>
        <h2>{m.museum_facts()}</h2>
        <dl className="facts">
          <Fact label={m.fact_address()}>
            {address.length === 0 ? (
              <Unknown />
            ) : (
              address.map((line) => (
                <span key={line}>
                  {line}
                  <br />
                </span>
              ))
            )}
          </Fact>
          <Fact label={m.fact_municipality()}>
            {museum.municipality_name === null ? <Unknown /> : museum.municipality_name}
          </Fact>
          <Fact label={m.fact_province()}>
            {provinceSlug === undefined ? (
              <Unknown />
            ) : (
              <Link href={pathOf({ page: 'province', locale, province: provinceSlug, query: '' })}>
                {PROVINCE_NAME[provinceSlug]()}
              </Link>
            )}
          </Fact>
          <Fact label={m.fact_categories()}>
            {museum.categories.length === 0 ? (
              <Unknown />
            ) : (
              museum.categories.map((c) => CATEGORY_LABEL[c]()).join(', ')
            )}
          </Fact>
          <Fact label={m.fact_website()}>
            {museum.website === null ? <Unknown /> : <External href={museum.website} />}
          </Fact>
          <Fact label={m.fact_museumnl()}>
            {museum.museumnl_url === null ? <Unknown /> : <External href={museum.museumnl_url} />}
          </Fact>
        </dl>
      </section>
      <p>
        <Link href={pathOf({ page: 'map', locale, query: '' })}>
          <IconMapPin /> {m.museum_on_map()}
        </Link>
      </p>
      <VisitForm museumId={museum.id} name={museumName(museum, locale)} closedOn={museum.closed_on} />
      <MyReviewSlot museum={museum} locale={locale} />
    </article>
  );
}
