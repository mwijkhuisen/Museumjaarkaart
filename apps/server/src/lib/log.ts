import pino from 'pino';

// The logger (pino 10.4.0). Fixed codes and counts only: never a name, URL,
// payload, email, IP, token or error message (invariant 8). `msg` is a fixed
// code such as `sync_applied`.

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

type Destination = { write(chunk: string): unknown };

function build(role: string, destination: Destination): Logger {
  return pino(
    {
      level: 'info',
      // `base` replaces pino's default pid and hostname: neither is needed.
      base: { role },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Never serialise an error: pino's default `err` serializer would write its message.
      serializers: { err: () => undefined },
    },
    destination,
  );
}

/** JSON lines to stderr (or `destination`), one per call, with the role as a base field. */
export function createLogger(opts: { role: string; destination?: Destination }): Logger {
  return build(opts.role, opts.destination ?? pino.destination({ fd: 2, sync: true }));
}

/** The same set-up with an in-memory destination, for tests that read the log lines back. */
export function memoryLogger(role = 'test'): { logger: Logger; lines(): Record<string, unknown>[] } {
  const raw: string[] = [];
  return {
    logger: build(role, { write: (chunk) => raw.push(chunk) }),
    lines: () => raw.flatMap((chunk) => chunk.split('\n').filter((l) => l !== '')).map((l) => JSON.parse(l)),
  };
}
