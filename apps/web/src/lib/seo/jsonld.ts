import type { MuseumDetail } from '@mjk/contracts';
import { museumName } from '../names.ts';
import type { Locale } from '../routes.ts';

/**
 * The schema.org `Museum` of a museum page. A key whose value is unknown is left out, never null.
 * The object goes into the page only through `jsonForScript` (invariant 5).
 */
export function museumJsonLd(museum: MuseumDetail, locale: Locale, url: string, description: string): object {
  const street = [museum.street, museum.house_number].filter((s) => s !== null).join(' ');
  const address = {
    ...(street === '' ? {} : { streetAddress: street }),
    ...(museum.postcode === null ? {} : { postalCode: museum.postcode }),
    ...(museum.place === null ? {} : { addressLocality: museum.place }),
  };
  return {
    '@context': 'https://schema.org',
    '@type': 'Museum',
    name: museumName(museum, locale),
    url,
    description,
    address: { '@type': 'PostalAddress', ...address, addressCountry: 'NL' },
    ...(museum.lat === null || museum.lon === null
      ? {}
      : { geo: { '@type': 'GeoCoordinates', latitude: museum.lat, longitude: museum.lon } }),
    ...(museum.website === null ? {} : { sameAs: [museum.website] }),
    // Q9: the shown mean (one decimal) and the count, once there is a rating.
    ...(museum.rating_count < 1 || museum.rating_mean === null
      ? {}
      : {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: museum.rating_mean,
            ratingCount: museum.rating_count,
            bestRating: 5,
            worstRating: 1,
          },
        }),
  };
}
