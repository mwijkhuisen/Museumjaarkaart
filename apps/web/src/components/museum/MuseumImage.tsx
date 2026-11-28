import { commonsFilePageUrl, type MuseumImage as Image, licenceDeedUrl, licenceShortName } from '@mjk/contracts';
import { m } from '../../paraglide/messages.js';
import { Picture } from '../photos/Picture.tsx';

// The museum's Wikimedia Commons image (ADR-0018, A§12): our own derivatives from `media.<domain>`, and the credit the
// licence asks for as plain text (a React text node, never an HTML sink), the licence linked to its deed, the file's
// Commons page and the note that we resized it. The links are plain `<a href>`: the browser requests nothing from them.

const SIZES = '(min-width: 40rem) 640px, 100vw';

export function MuseumImage({ image, museum }: { image: Image; museum: string }) {
  const deed = licenceDeedUrl(image.licence);
  const name = licenceShortName(image.licence) ?? (image.licence === 'pd' ? m.museum_image_pd() : image.licence);
  return (
    <figure className="museum-image">
      <Picture
        photo={{
          public_key: image.public_key,
          widths: image.widths,
          width: image.width,
          height: image.height,
          alt_text: null,
        }}
        alt={m.photo_alt_generated_anon({ museum })}
        sizes={SIZES}
      />
      <figcaption className="muted">
        {image.attribution === null ? null : <>{m.museum_image_by({ credit: image.attribution })} · </>}
        {deed === null ? (
          name
        ) : (
          <a href={deed} rel="noopener noreferrer">
            {name}
          </a>
        )}
        {' · '}
        <a href={commonsFilePageUrl(image.file)} rel="noopener noreferrer">
          {m.museum_image_commons()}
        </a>
        {' · '}
        {m.museum_image_edited()}
      </figcaption>
    </figure>
  );
}
