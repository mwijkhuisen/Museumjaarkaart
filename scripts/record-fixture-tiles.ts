// Records the CI fixture tiles (P1d Q6, owner): a few km² of Amsterdam at low zooms, extracted from a
// Protomaps build with go-pmtiles 1.31.2, as apps/web/e2e/tiles/fixture.pmtiles plus its README.md
// (provenance and the ODbL credit). The CI e2e stack serves that file from the S3 stand-in.
// Usage: node scripts/record-fixture-tiles.ts --pmtiles <go-pmtiles 1.31.2 binary> --build <YYYYMMDD> [--out <dir>]
// Pick --build from https://build-metadata.protomaps.dev/builds.json (Protomaps keeps a build one week).
//
// It runs on the owner's machine only and refuses under CI (exit 3) before it parses anything, like
// record-fixture.ts. Exit 0 recorded · 3 CI · 64 usage · 65 the result is not a small PMTiles v3 file ·
// 69 go-pmtiles failed or is not 1.31.2.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE =
  'usage: node scripts/record-fixture-tiles.ts --pmtiles <go-pmtiles 1.31.2 binary> --build <YYYYMMDD> [--out <dir>]';
export const EXIT_CI = 3;
export const EXIT_USAGE = 64;
export const EXIT_DATA = 65;
export const EXIT_TOOL = 69;
export const DEFAULT_OUT = fileURLToPath(new URL('../apps/web/e2e/tiles', import.meta.url));
/** Central Amsterdam, about 2.7 km by 2.2 km; the z0-12 pyramid above it covers much of the country. */
export const BBOX = '4.88,52.36,4.92,52.38';
export const MAXZOOM = 12;
export const MAX_BYTES = 2_000_000;

/** The refusal text when `CI` is set at all (even empty, `false` or `0`), else undefined. */
export function refuseUnderCi(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return 'CI' in env ? 'record-fixture-tiles: refusing to run under CI (it runs on the owner machine only)' : undefined;
}

export type Args = { pmtiles: string; build: string; out: string };

export function parseArgs(argv: readonly string[]): Args | undefined {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i] ?? '', argv[i + 1]];
    if (!['--pmtiles', '--build', '--out'].includes(name) || value === undefined || flags.has(name)) return undefined;
    flags.set(name, value);
  }
  const [pmtiles, build] = [flags.get('--pmtiles'), flags.get('--build')];
  if (pmtiles === undefined || build === undefined || !/^20[0-9]{6}$/.test(build)) return undefined;
  return { pmtiles, build, out: flags.get('--out') ?? DEFAULT_OUT };
}

function record({ pmtiles, build, out }: Args): number {
  const run = (args: string[]) => execFileSync(pmtiles, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!/\b1\.31\.2\b/.test(run(['version']))) {
    console.error('record-fixture-tiles: the binary is not go-pmtiles 1.31.2');
    return EXIT_TOOL;
  }
  const source = `https://build.protomaps.com/${build}.pmtiles`;
  const file = join(out, 'fixture.pmtiles');
  const part = `${file}.part`;
  rmSync(part, { force: true });
  try {
    run(['extract', source, part, `--bbox=${BBOX}`, `--maxzoom=${MAXZOOM}`]);
  } catch {
    rmSync(part, { force: true });
    console.error('record-fixture-tiles: go-pmtiles extract failed');
    return EXIT_TOOL;
  }
  const bytes = readFileSync(part);
  if (bytes.length > MAX_BYTES || bytes.subarray(0, 7).toString('latin1') !== 'PMTiles' || bytes[7] !== 3) {
    rmSync(part, { force: true });
    console.error(`record-fixture-tiles: not a PMTiles v3 file under ${MAX_BYTES} bytes (${bytes.length})`);
    return EXIT_DATA;
  }
  const header = run(['show', part]).trim();
  renameSync(part, file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(out, 'README.md'), readme({ build, source, header, size: bytes.length, sha256 }));
  console.log(`record-fixture-tiles: ${bytes.length} bytes, sha256 ${sha256}`);
  return 0;
}

const readme = (r: {
  build: string;
  source: string;
  header: string;
  size: number;
  sha256: string;
}) => `# Fixture tiles (CI only)

Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0). The tiles are
the Protomaps basemap, whose rendering of OpenStreetMap is a Produced Work: the map shows the credit
"© OpenStreetMap contributors · Protomaps" wherever these tiles are displayed. OSM data lives only inside
these tiles, never in our tables (A§7.1).

## \`fixture.pmtiles\`

The CI e2e stack uploads it to the S3 stand-in as \`tiles/nl-20261001.pmtiles\` and writes the
\`tiles/current.json\` that names it. CI never fetches a Protomaps build (P1d Q6). Recorded by the owner with
\`scripts/record-fixture-tiles.ts\`:

| | |
|---|---|
| Source | Protomaps build \`${r.build}\` (${r.source}) |
| Command | \`pmtiles extract ${r.source} fixture.pmtiles --bbox=${BBOX} --maxzoom=${MAXZOOM}\` (go-pmtiles 1.31.2) |
| Bytes | ${r.size} |
| sha256 | \`${r.sha256}\` |

\`pmtiles show\`:

\`\`\`
${r.header}
\`\`\`
`;

if (import.meta.main) {
  const refused = refuseUnderCi(process.env);
  if (refused !== undefined) {
    console.error(refused);
    process.exit(EXIT_CI);
  }
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }
  process.exit(record(args));
}
