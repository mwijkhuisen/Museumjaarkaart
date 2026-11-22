// The `api` role's config (A§17.3, ADR-0004): the domain names the admin host, and the Access team
// and AUD check its JWT. Config, not secrets (`/etc/mjk/mjk.env`). A missing or malformed value
// names the variable, never its value; runApi turns it into exit 78.

type Env = Readonly<Record<string, string | undefined>>;

export type ApiConfig = {
  /** `<domain>` (MJK_DOMAIN). */
  domain: string;
  /** `admin.<domain>`: the only host whose requests carry the Access JWT check. */
  adminHost: string;
  /** The Cloudflare Access team name (CF_ACCESS_TEAM): `https://<team>.cloudflareaccess.com`. */
  accessTeam: string;
  /** The Access application's AUD tag (CF_ACCESS_AUD). */
  accessAud: string;
};

/** A lowercase DNS host name with at least one dot (the same rule as the ssr's config). */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** One DNS label of lowercase letters, digits and inner hyphens: the team's subdomain. */
const TEAM = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Cloudflare shows the AUD tag as 64 lowercase hex characters; the JWT's `aud` is compared exactly. */
const AUD = /^[0-9a-f]{64}$/;

export function readApiConfig(env: Env): ApiConfig | string {
  const domain = env.MJK_DOMAIN;
  if (domain === undefined || domain === '') return 'MJK_DOMAIN is missing';
  if (!DOMAIN.test(domain)) return 'MJK_DOMAIN must be a lowercase host name with a dot';
  // admin.<domain> must itself be a valid host name (253 characters at most).
  if (domain.length > 247) return 'MJK_DOMAIN must be a lowercase host name with a dot';
  const team = env.CF_ACCESS_TEAM;
  if (team === undefined || team === '') return 'CF_ACCESS_TEAM is missing';
  if (!TEAM.test(team)) return 'CF_ACCESS_TEAM must be one label of lowercase letters, digits and hyphens';
  const aud = env.CF_ACCESS_AUD;
  if (aud === undefined || aud === '') return 'CF_ACCESS_AUD is missing';
  if (!AUD.test(aud)) return 'CF_ACCESS_AUD must be 64 lowercase hex characters';
  return { domain, adminHost: `admin.${domain}`, accessTeam: team, accessAud: aud };
}
