import { useEffect } from 'react';
import { useConfig } from '../lib/config.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { pathOf } from '../lib/routes.ts';
import { type ErrorKind, errorTitleOf } from '../lib/seo/head.tsx';
import { m } from '../paraglide/messages.js';

// The not-found, bad-request and error pages: the SSR error documents and the SPA's error boundary.

const TEXT = {
  not_found: { title: m.page_not_found, body: m.not_found_body },
  bad_request: { title: m.page_bad_request, body: m.bad_request_body },
  error: { title: m.page_error, body: m.error_body },
} as const;

export function ErrorPage({ kind }: { kind: ErrorKind }) {
  const text = TEXT[kind];
  const { route } = useRouter();
  const title = errorTitleOf(kind, useConfig().brand);
  // The error boundary replaces the page, DocumentTitle with it: the title follows here. The server's
  // error documents carry it in <head> and run no script.
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <>
      <h1>{text.title()}</h1>
      <p>{text.body()}</p>
      <p>
        <Link href={pathOf({ page: 'home', locale: route.locale })}>{m.back_home()}</Link>
      </p>
    </>
  );
}
