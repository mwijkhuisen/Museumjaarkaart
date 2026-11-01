import { EXIT_CONFIG, runMigrate } from './db/migrate.ts';
import { HEARTBEAT_PATH, healthy } from './heartbeat.ts';

/** Roles of the single server image (A§5); the first argument picks one. */
export const ROLES = ['api', 'ssr', 'worker', 'migrate', 'healthcheck', 'sync-museums', 'admin', 'backup'] as const;
export type Role = (typeof ROLES)[number];

/** A role its phase has not built yet, a missing role and an unknown role. */
export const EXIT_NOT_BUILT = 2;
/** Extra arguments to `healthcheck` or `migrate`. */
export const EXIT_USAGE = 64;
export { EXIT_CONFIG };

type Env = Readonly<Record<string, string | undefined>>;

const USAGE = `usage: main.ts <${ROLES.join('|')}> [args]`;

/** Resolves with the exit code. `heartbeatPath` is a test seam. */
export async function run(
  argv: readonly string[],
  env: Env,
  log: (line: string) => void = (line) => console.error(line),
  heartbeatPath = HEARTBEAT_PATH,
): Promise<number> {
  const [role, ...rest] = argv;
  if (role === undefined || !(ROLES as readonly string[]).includes(role)) {
    log(USAGE);
    return EXIT_NOT_BUILT;
  }
  if (role === 'healthcheck' || role === 'migrate') {
    if (rest.length > 0) {
      log(USAGE);
      return EXIT_USAGE;
    }
    return role === 'healthcheck' ? (healthy(heartbeatPath) ? 0 : 1) : runMigrate(env, log);
  }
  log(`role ${role} is not built yet`);
  return EXIT_NOT_BUILT;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
