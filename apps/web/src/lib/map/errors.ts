/** A map failure with a fixed code (never a message that holds a URL or a response body). */
export class MapError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'MapError';
    this.code = code;
  }
}

/**
 * Whether a MapLibre `error` event makes the map unusable: an error of the `basemap` source itself (the
 * pmtiles header or directory, so no TileJSON), not one failed tile. MapLibre's tile errors carry the
 * `tile` (TileManager `_loadTile`); every source error is forwarded with its `sourceId`.
 */
export const isFatalBasemapError = (e: unknown): boolean => {
  const ev = e as { sourceId?: unknown; tile?: unknown } | null;
  return ev?.sourceId === 'basemap' && ev.tile === undefined;
};
