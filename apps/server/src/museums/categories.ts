import { CATEGORIES, type Category } from './fields.ts';

// P31 class QID -> category (A§7.2, plan §2.2). Only classes we are sure of are
// here. [U O1]: the table is completed from the owner's recorded class counts.
export const CLASS_CATEGORY: Readonly<Record<string, Category>> = {
  Q207694: 'art', // art museum
  Q1007870: 'art', // art gallery
  Q16735822: 'history', // history museum
  Q2087181: 'history', // historic house museum
  Q2772772: 'history', // military museum
  Q3329412: 'history', // archaeological museum
};

/**
 * Classes that deliberately map to nothing: they say nothing about the collection
 * (plain "museum", "national museum"). `unmappedClasses` leaves them out.
 */
export const NEUTRAL_CLASSES: readonly string[] = ['Q33506', 'Q17431399'];

const mapped = (c: string): Category | undefined => (Object.hasOwn(CLASS_CATEGORY, c) ? CLASS_CATEGORY[c] : undefined);

/** Unique categories of the classes that map, in `CATEGORIES` order; `['other']` when none does. */
export function categoriesOf(classes: readonly string[]): Category[] {
  const found = new Set<Category>();
  for (const c of classes) {
    const category = mapped(c);
    if (category !== undefined) found.add(category);
  }
  const sorted = CATEGORIES.filter((c) => found.has(c));
  return sorted.length > 0 ? sorted : ['other'];
}

/** The distinct classes with no mapping and not neutral, sorted (for the fixture test "a class used by 10+ items"). */
export function unmappedClasses(classes: readonly string[]): string[] {
  return [...new Set(classes)].filter((c) => mapped(c) === undefined && !NEUTRAL_CLASSES.includes(c)).sort();
}
