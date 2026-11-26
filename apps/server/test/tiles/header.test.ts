import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NL_BOX } from '@mjk/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { TILE_LIMITS, type TileLimits, tilesProblem } from '../../src/tiles/header.ts';

// The committed fixture is a real go-pmtiles 1.31.2 extract of the world at z0-2 (`apps/web/e2e/tiles`).
const FIXTURE = join(import.meta.dirname, '../../../web/e2e/tiles/fixture.pmtiles');
const WORLD = { latMin: -85.06, latMax: 85.06, lonMin: -180, lonMax: 180 };
const SMALL: TileLimits = { minBytes: 1000, maxBytes: 10 * 1024 * 1024, box: WORLD };
const NL: TileLimits = { ...SMALL, box: NL_BOX };

let dir: string;
let good: Buffer;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mjk-header-'));
  good = readFileSync(FIXTURE);
});

/** A copy of the fixture with its header patched. */
function variant(name: string, patch: (b: Buffer) => void, cut?: number): string {
  const b = Buffer.from(good);
  patch(b);
  const path = join(dir, name);
  writeFileSync(path, cut === undefined ? b : b.subarray(0, cut));
  return path;
}
const e7 = (b: Buffer, at: number, deg: number) => b.writeInt32LE(Math.round(deg * 1e7), at);
const nlBox = (b: Buffer) => {
  e7(b, 102, 3.2);
  e7(b, 106, 50.7);
  e7(b, 110, 7.3);
  e7(b, 114, 53.7);
};

describe('tilesProblem', () => {
  it('accepts the fixture: PMTiles v3, mvt, gzip, z0, inside the box, between the limits', async () => {
    expect(await tilesProblem(FIXTURE, SMALL)).toBeNull();
  });

  it('accepts a header with the national bounds against the national box', async () => {
    expect(await tilesProblem(variant('nl.pmtiles', nlBox), NL)).toBeNull();
  });

  it('refuses a world extract against the national box', async () => {
    expect(await tilesProblem(FIXTURE, NL)).toBe('bounds');
  });

  it('refuses bounds that leave the box on any side, and bounds that are upside down', async () => {
    for (const [at, deg] of [
      [102, 3.0],
      [106, 50.5],
      [110, 7.5],
      [114, 53.9],
    ] as const) {
      expect(
        await tilesProblem(
          variant('edge.pmtiles', (b) => {
            nlBox(b);
            e7(b, at, deg);
          }),
          NL,
        ),
      ).toBe('bounds');
    }
    expect(
      await tilesProblem(
        variant('flip.pmtiles', (b) => {
          nlBox(b);
          e7(b, 102, 7.3);
          e7(b, 110, 3.2);
        }),
        NL,
      ),
    ).toBe('bounds');
  });

  it('refuses a size under the floor or over the ceiling with the real limits', async () => {
    expect(await tilesProblem(FIXTURE, TILE_LIMITS)).toBe('size');
    expect(await tilesProblem(FIXTURE, { ...SMALL, maxBytes: 1000 })).toBe('size');
  });

  it('refuses what is not a PMTiles v3 file of vector tiles', async () => {
    expect(
      await tilesProblem(
        variant('magic.pmtiles', (b) => b.write('PMTilez', 0, 'latin1')),
        SMALL,
      ),
    ).toBe('magic');
    expect(
      await tilesProblem(
        variant('v2.pmtiles', (b) => b.writeUInt8(2, 7)),
        SMALL,
      ),
    ).toBe('version');
    expect(
      await tilesProblem(
        variant('png.pmtiles', (b) => b.writeUInt8(2, 99)),
        SMALL,
      ),
    ).toBe('type');
    expect(
      await tilesProblem(
        variant('brotli.pmtiles', (b) => b.writeUInt8(3, 98)),
        SMALL,
      ),
    ).toBe('compression');
    expect(
      await tilesProblem(
        variant('zoom.pmtiles', (b) => b.writeUInt8(1, 100)),
        SMALL,
      ),
    ).toBe('zoom');
    expect(
      await tilesProblem(
        variant('short.pmtiles', () => {}, 100),
        { ...SMALL, minBytes: 1 },
      ),
    ).toBe('magic');
  });

  it('refuses a truncated file', async () => {
    expect(
      await tilesProblem(
        variant('cut.pmtiles', () => {}, good.length - 1000),
        SMALL,
      ),
    ).toBe('truncated');
  });

  it('refuses a directory and a missing file', async () => {
    expect(await tilesProblem(dir, SMALL)).toBe('not_file');
    expect(await tilesProblem(join(dir, 'nope.pmtiles'), SMALL)).toBe('not_file');
  });
});
