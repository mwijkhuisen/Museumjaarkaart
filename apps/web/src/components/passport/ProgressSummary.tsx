import type { Progress } from '@mjk/contracts';
import { formatCount, formatMonth } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { PROVINCE_NAME, provinceSlugOf } from '../museum/provinces.ts';

// A member's progress (A§10): N of the Museumkaart list, always with the list's date (A§7.5), the
// all-time count and the museums per year. Shared by the public profile and the passport page.

export function ProgressSummary({ progress, locale }: { progress: Progress; locale: Locale }) {
  const { list, all_time, years } = progress;
  return (
    <div className="stack">
      {list === null ? null : (
        <>
          <p className="progress__headline">
            {m.profile_progress_of_list({
              visited: formatCount(list.visited, locale),
              n: formatCount(list.n, locale),
              date: formatMonth(list.published_on, locale),
            })}
          </p>
          <ul className="plain-list">
            {list.provinces.map((p) => {
              const slug = p.code === null ? undefined : provinceSlugOf(p.code);
              return (
                <li key={p.code ?? 'none'}>
                  {m.profile_progress_province({
                    province: slug === undefined ? m.profile_progress_province_unknown() : PROVINCE_NAME[slug](),
                    visited: formatCount(p.visited, locale),
                    n: formatCount(p.n, locale),
                  })}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p>{m.profile_progress_all_time({ n: formatCount(all_time, locale) })}</p>
      {years.length === 0 ? null : (
        <ul className="plain-list">
          {years.map((y) => (
            <li key={y.year}>{m.profile_progress_year({ year: String(y.year), n: formatCount(y.museums, locale) })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
