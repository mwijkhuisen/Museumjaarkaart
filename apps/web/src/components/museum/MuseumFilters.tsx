import { CATEGORIES, type Provinces } from '@mjk/contracts';
import { provinceName } from '../../lib/names.ts';
import { GetForm } from '../../lib/router.tsx';
import { pathOf, type Route } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { CATEGORY_LABEL } from './categories.ts';

/** The filter form of the list and the map page: a GET form to the page's own path (no JavaScript needed). */
export function MuseumFilters({
  route,
  provinces,
}: {
  route: Extract<Route, { page: 'museums' | 'map' }>;
  provinces: Provinces;
}) {
  const query = new URLSearchParams(route.query);
  return (
    <GetForm action={pathOf({ ...route, query: '' })} className="filters">
      <div className="field">
        <label htmlFor="f-q">{m.field_q()}</label>
        <input id="f-q" name="q" type="search" defaultValue={query.get('q') ?? ''} />
      </div>
      <div className="field">
        <label htmlFor="f-province">{m.field_province()}</label>
        <select id="f-province" name="province" defaultValue={query.get('province') ?? ''}>
          <option value="">{m.option_all()}</option>
          {provinces.items.map((p) => (
            <option key={p.code} value={p.code}>
              {provinceName(p, route.locale)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="f-category">{m.field_category()}</label>
        <select id="f-category" name="category" defaultValue={query.get('category') ?? ''}>
          <option value="">{m.option_all()}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]()}
            </option>
          ))}
        </select>
      </div>
      <div className="cluster">
        <label>
          <input type="checkbox" name="mk" value="participating" defaultChecked={query.get('mk') === 'participating'} />{' '}
          {m.field_mk()}
        </label>
        <button type="submit" className="button">
          {m.action_filter()}
        </button>
      </div>
    </GetForm>
  );
}
