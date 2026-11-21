import type { ErrorKind } from '../lib/seo/head.tsx';
import { m } from '../paraglide/messages.js';

// The not-found, bad-request and error pages: the SSR error documents and the SPA's error boundary.

const TEXT = {
  not_found: { title: m.page_not_found, body: m.not_found_body },
  bad_request: { title: m.page_bad_request, body: m.bad_request_body },
  error: { title: m.page_error, body: m.error_body },
} as const;

export function ErrorPage({ kind }: { kind: ErrorKind }) {
  const text = TEXT[kind];
  return (
    <>
      <h1>{text.title()}</h1>
      <p>{text.body()}</p>
    </>
  );
}
