import type { MuseumDetail } from '@mjk/contracts';
import type { Locale } from '../../lib/routes.ts';

// The member's own review of this museum on its page (P3a): "Beoordeel <museum>" or their review with edit and
// delete, read from GET /me/museums/:slug while the signed-in hint is set. Empty on the server and in the first
// client render, like MarkSlot. WP7 builds it.

export function MyReviewSlot(_props: { museum: MuseumDetail; locale: Locale }) {
  return null;
}
