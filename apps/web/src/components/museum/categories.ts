import type { Category } from '@mjk/contracts';
import { m } from '../../paraglide/messages.js';

/** Labels chosen by name, never `m[category]` (the bundler would keep every message). */
export const CATEGORY_LABEL = {
  art: m.category_art,
  history: m.category_history,
  natural_history: m.category_natural_history,
  science_technology: m.category_science_technology,
  ethnology: m.category_ethnology,
  other: m.category_other,
} as const satisfies Record<Category, () => string>;
