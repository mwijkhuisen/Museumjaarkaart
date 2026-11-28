import type { OwnPhoto, PublicPhoto } from '@mjk/contracts';
import { useConfig } from '../../lib/config.ts';
import { m } from '../../paraglide/messages.js';

// A published photo (P3b, A§12): AVIF first, WebP as the fallback, from `media.<domain>` (the CSP's `img-src`). The
// alt is the member's plain text or, when there is none, a generated one. Nothing here touches HTML: React escapes
// the attributes.

type Pic = Pick<PublicPhoto, 'widths' | 'alt_text'> & {
  public_key: string | null;
  width?: number | null | undefined;
  height?: number | null | undefined;
};

/** The photo's alt: the member's text, else "Foto bij <museum> door <handle>". */
export function photoAlt(photo: Pick<Pic, 'alt_text'>, museum: string, handle: string | null): string {
  if (photo.alt_text !== null) return photo.alt_text;
  return handle === null ? m.photo_alt_generated_anon({ museum }) : m.photo_alt_generated({ museum, handle });
}

const SIZES = '(min-width: 40rem) 400px, 100vw';

export function Picture({ photo, alt, sizes = SIZES }: { photo: Pic; alt: string; sizes?: string }) {
  const { media } = useConfig();
  const widths = [...photo.widths].sort((a, b) => a - b);
  const [smallest] = widths;
  if (photo.public_key === null || smallest === undefined) return null;
  const url = (w: number, ext: 'avif' | 'webp') => `${media}/p/${photo.public_key}/${w}.${ext}`;
  const set = (ext: 'avif' | 'webp') => widths.map((w) => `${url(w, ext)} ${w}w`).join(', ');
  return (
    <picture>
      <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
      <source type="image/webp" srcSet={set('webp')} sizes={sizes} />
      <img
        src={url(smallest, 'webp')}
        width={photo.width ?? undefined}
        height={photo.height ?? undefined}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="photo__img"
      />
    </picture>
  );
}

/** The photos of a public review. */
export function PhotoGrid({
  photos,
  museum,
  handle,
}: {
  photos: readonly PublicPhoto[];
  museum: string;
  handle: string | null;
}) {
  if (photos.length === 0) return null;
  return (
    <ul className="photo-grid plain-list">
      {photos.map((p) => (
        <li key={p.id}>
          <Picture photo={p} alt={photoAlt(p, museum, handle)} />
        </li>
      ))}
    </ul>
  );
}

/** What the author sees of one of their photos in a state: the `<picture>`, or the preview with its label. */
export function OwnPhotoView({ photo, alt }: { photo: OwnPhoto; alt: string }) {
  switch (photo.state) {
    case 'approved':
      return <Picture photo={photo} alt={alt} />;
    case 'pending_review':
      return (
        <figure className="photo-pending">
          <img src={`/api/v1/uploads/${photo.id}/preview?w=400`} alt={alt} loading="lazy" className="photo__img" />
          <figcaption>{m.photo_pending()}</figcaption>
        </figure>
      );
    case 'rejected':
      return <p className="muted">{m.photo_rejected()}</p>;
    default:
      return <p className="muted">{m.photo_processing()}</p>;
  }
}
