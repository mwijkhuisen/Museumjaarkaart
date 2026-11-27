import { MeProgress } from '@mjk/contracts';
import { LoadFailed, MemberPage, useJson } from '../components/passport/MemberPage.tsx';
import { ProgressSummary } from '../components/passport/ProgressSummary.tsx';
import { Savings } from '../components/passport/Savings.tsx';
import { VisitLog } from '../components/passport/VisitLog.tsx';
import { Link } from '../lib/router.tsx';
import { pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The museum passport (A§10, A§15.1): progress, € saved and the visit log. Nothing is known about the
// member before the browser has asked, so the server render is the heading and "Loading".

export function Passport({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  return (
    <MemberPage route={route} title={m.page_passport()}>
      <PassportBody route={route} />
    </MemberPage>
  );
}

function PassportBody({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  const { locale } = route;
  const { data, failed, reload } = useJson('/api/v1/me/progress', MeProgress);
  return (
    <>
      <p className="cluster">
        <Link className="button" href={pathOf({ page: 'shell', locale, app: 'welcome' })}>
          {m.passport_link_onboarding()}
        </Link>
        <Link className="button button--quiet" href={pathOf({ page: 'shell', locale, app: 'wishlist' })}>
          {m.page_wishlist()}
        </Link>
      </p>
      {failed ? <LoadFailed onRetry={reload} /> : null}
      {data === undefined ? null : (
        <>
          <ProgressSummary progress={data.progress} locale={locale} />
          <Savings savings={data.savings} locale={locale} />
        </>
      )}
      <VisitLog locale={locale} onChanged={reload} />
    </>
  );
}
