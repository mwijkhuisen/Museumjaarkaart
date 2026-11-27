import { readFileSync } from 'node:fs';
import { parseCredentials, R2Client } from '../src/media/r2.ts';
import { JobError } from '../src/worker/types.ts';

// CI e2e only (deploy/e2e): stands in for the owner's [box] tiles upload. Against the MinIO stand-in of R2 it
// creates the bucket, makes `tiles/*` and `p/*` (the published photos, P3b), and nothing else, readable anonymously,
// uploads the fixture tiles as `tiles/nl-20261001.pmtiles` and then `tiles/current.json` (A§15.3, Q3), through the
// production R2 client.
// The credentials are the file secret /run/secrets/r2_media_rw (the format of the real one). Prints counts only.

const BUCKET = 'mjk-media';
const FILE = 'nl-20261001.pmtiles';
const FIXTURE = new URL('../../web/e2e/tiles/fixture.pmtiles', import.meta.url).pathname;

const credentials = parseCredentials(readFileSync('/run/secrets/r2_media_rw', 'utf8'));
if (credentials === undefined) {
  console.error('seed-e2e-tiles: the file secret r2_media_rw has no valid [default] key');
  process.exit(78);
}
const r2 = new R2Client({ endpoint: 'http://minio:9000', bucket: BUCKET, region: 'us-east-1', credentials });

try {
  // MinIO answers (anything below 500) once it is up.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await r2.send({ method: 'GET' }).then(
      (res) => res.status < 500,
      () => false,
    );
    if (!up) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!up) throw new JobError('store_unavailable');

  const created = await r2.send({ method: 'PUT' });
  if (created.status !== 200 && created.status !== 409) throw new JobError('store_rejected');
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${BUCKET}/tiles/*`, `arn:aws:s3:::${BUCKET}/p/*`],
      },
    ],
  });
  const put = await r2.send({ method: 'PUT', query: { policy: '' }, body: policy });
  if (put.status !== 204 && put.status !== 200) throw new JobError('store_rejected');

  await r2.putFile(`tiles/${FILE}`, FIXTURE, {
    contentType: 'application/vnd.pmtiles',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  await r2.put('tiles/current.json', JSON.stringify({ file: FILE, previous: null }), {
    contentType: 'application/json',
    cacheControl: 'public, max-age=300',
  });
  const head = await r2.head(`tiles/${FILE}`);
  console.log(`seed-e2e-tiles: bucket ${BUCKET}, 2 objects, tiles ${head?.size ?? 0} bytes`);
} catch (err) {
  console.error(`seed-e2e-tiles: ${err instanceof JobError ? err.code : 'internal'}`);
  process.exit(1);
}
