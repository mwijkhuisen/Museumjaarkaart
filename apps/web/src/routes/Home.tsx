import { MkList, Provinces } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { provinceSlugOf } from '../components/museum/provinces.ts';
import { IconSearch } from '../components/ui/icons.tsx';
import { useApi } from '../lib/api.ts';
import { formatCount, formatMonth } from '../lib/format.ts';
import { provinceName } from '../lib/names.ts';
import { GetForm, Link } from '../lib/router.tsx';
import { apiPath, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

export function Home({ route }: { route: Extract<Route, { page: 'home' }> }) {
  const { locale } = route;
  const provinces = useApi(apiPath.provinces, Provinces);
  const mkList = useApi(apiPath.mkList, MkList);
  if (provinces === undefined || mkList === undefined) return <Loading />;
  return (
    <div className="stack">
      <h1>{m.home_heading()}</h1>
      <p>{m.home_intro()}</p>
      <GetForm action={pathOf({ page: 'search', locale, query: '' })} className="cluster">
        <div className="field">
          <label htmlFor="home-q">{m.field_q()}</label>
          <input id="home-q" name="q" type="search" />
        </div>
        <button type="submit" className="button">
          <IconSearch /> {m.action_search()}
        </button>
      </GetForm>
      <ul className="site-nav">
        <li>
          <Link href={pathOf({ page: 'museums', locale, query: '' })}>{m.home_all_museums()}</Link>
        </li>
        <li>
          <Link href={pathOf({ page: 'museums', locale, query: 'mk=participating' })}>{m.home_mk_museums()}</Link>
        </li>
        <li>
          <Link href={pathOf({ page: 'map', locale })}>{m.home_map()}</Link>
        </li>
      </ul>
      {mkList.list === null ? null : (
        <p className="muted">
          {m.home_mk_list({
            date: formatMonth(mkList.list.published_on, locale),
            n: formatCount(mkList.list.n, locale),
          })}
        </p>
      )}
      <section>
        <h2>{m.home_provinces()}</h2>
        <ul className="card-list">
          {provinces.items.map((province) => {
            const slug = provinceSlugOf(province.code);
            const name = provinceName(province, locale);
            return (
              <li key={province.code}>
                <div className="card">
                  {slug === undefined ? (
                    name
                  ) : (
                    <Link href={pathOf({ page: 'province', locale, province: slug, query: '' })}>{name}</Link>
                  )}{' '}
                  <span className="muted">({formatCount(province.museum_count, locale)})</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
