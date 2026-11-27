import { Link } from '../../lib/router.tsx';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { IconInfo } from '../ui/icons.tsx';

/** The link to "Hoe wij reviews controleren", which sits next to every score (P3a, A§11). */
export function HowWeCheck({ locale, icon = false }: { locale: Locale; icon?: boolean }) {
  const href = pathOf({ page: 'legal', locale, doc: 'reviews' });
  // The icon form (list cards) keeps the full text as the link's accessible name.
  return icon ? (
    <Link href={href} className="howcheck howcheck--icon" aria-label={m.page_reviews()}>
      <IconInfo />
    </Link>
  ) : (
    <Link href={href} className="howcheck">
      {m.page_reviews()}
    </Link>
  );
}
