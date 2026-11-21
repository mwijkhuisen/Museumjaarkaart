import { MuseumList, Provinces } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { MuseumResults } from '../components/museum/MuseumResults.tsx';
import { useApi } from '../lib/api.ts';
import { provinceName } from '../lib/names.ts';
import { apiPath, PROVINCE_SLUGS, provinceQuery, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

export function Province({ route }: { route: Extract<Route, { page: 'province' }> }) {
  const provinces = useApi(apiPath.provinces, Provinces);
  const list = useApi(apiPath.museums(provinceQuery(route)), MuseumList);
  if (provinces === undefined || list === undefined) return <Loading />;
  const province = provinces.items.find((p) => p.code === PROVINCE_SLUGS[route.province]);
  return (
    <>
      <h1>{m.page_province({ province: province ? provinceName(province, route.locale) : '' })}</h1>
      <MuseumResults list={list} route={route} />
    </>
  );
}
