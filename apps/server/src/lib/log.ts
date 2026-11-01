// The logger contract (WP6 builds it on pino 10.4.0). Fixed codes and counts
// only: never a name, URL, payload, email, IP, token or error message
// (invariant 8). `msg` is a fixed code such as `sync_applied`.

export type LogFields = Readonly<Record<string, number | boolean | string | null>>;

export type Logger = {
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
};

/** Discards everything (tests that do not capture logs). */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
