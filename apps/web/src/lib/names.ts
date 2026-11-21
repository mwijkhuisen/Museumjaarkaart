import type { MuseumListItem, Provinces } from '@mjk/contracts';
import type { Locale } from './routes.ts';

// Names in the page's language (ADR-0013): the English label where Wikidata has one, else Dutch.

export const museumName = (museum: Pick<MuseumListItem, 'name' | 'name_en'>, locale: Locale): string =>
  locale === 'en' && museum.name_en !== null ? museum.name_en : museum.name;

type Province = Provinces['items'][number];

export const provinceName = (province: Province, locale: Locale): string =>
  locale === 'en' ? province.name_en : province.name_nl;
