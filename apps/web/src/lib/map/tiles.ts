import { z } from 'zod';
import { MapError } from './errors.ts';

// Where the basemap tiles are (A§15.3, ADR-0014): `media.<domain>/tiles/current.json` names the
// PMTiles file in use. Nothing here imports maplibre-gl, so the tests and the style code read it.

export const TILE_FILE = /^nl-[0-9]{8}\.pmtiles$/;
const TileFile = z.string().regex(TILE_FILE);

/** `tiles/current.json`: the file in use and the one before it (rollback), nothing else. */
export const TilesPointer = z.strictObject({ file: TileFile, previous: TileFile.nullable() });
export type TilesPointer = z.infer<typeof TilesPointer>;

/** Parses the body of `current.json` strictly; anything else is `tiles_pointer_invalid`. */
export function parseTilesPointer(text: string): TilesPointer {
  try {
    return TilesPointer.parse(JSON.parse(text));
  } catch {
    throw new MapError('tiles_pointer_invalid');
  }
}

export { mediaOrigin } from '../media.ts';

export const tilesPointerUrl = (media: string): string => `${media}/tiles/current.json`;

/** Reads `current.json` without following a redirect and without a cached answer. */
export async function loadTilesPointer(media: string, signal: AbortSignal): Promise<TilesPointer> {
  const res = await fetch(tilesPointerUrl(media), { signal, redirect: 'error', cache: 'no-cache' });
  if (!res.ok) throw new MapError('tiles_unavailable');
  return parseTilesPointer(await res.text());
}
