// CI only: Cloudflare Access's stand-in (stack.sh, `node deploy/e2e/access-stub.mjs <dir> <email>…`). Makes an RS256
// key pair that it forgets on exit, writes the public half as <dir>/jwks.json (the edge serves it at
// https://test-team.cloudflareaccess.com/cdn-cgi/access/certs, where the api's JWKS cache looks) and prints one JWT
// per email on stdout, in order: what Cloudflare Access adds as Cf-Access-Jwt-Assertion once a person is let in.
// The admin specs send it as that header themselves; the edge never injects it. Plain Node, no dependency.
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [dir, ...emails] = process.argv.slice(2);
if (!dir || emails.length === 0) throw new Error('usage: access-stub.mjs <dir> <email>…');

// The same values as compose.yaml's api (CF_ACCESS_TEAM, CF_ACCESS_AUD); the emails are the owners seed-e2e.ts made.
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const kid = 'e2e-access-1';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
writeFileSync(
  `${dir}/jwks.json`,
  JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }),
  { mode: 0o644 },
);

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
for (const email of emails) {
  const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64({ iss: issuer, aud: [audience], email, iat: now, nbf: now, exp: now + 7200 })}`;
  console.log(`${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`);
}
