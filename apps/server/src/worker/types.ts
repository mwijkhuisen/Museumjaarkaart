// The job contract (A§8 `job`, ADR-0015, plan §2.5). WP6 builds the queue and the
// worker loop on it; job handlers (the museum sync first) only see this.

/** A fixed error code: lower case and underscores, at most 40 characters (the `job.last_error` CHECK). */
export const ERROR_CODE = /^[a-z_]{1,40}$/;

/**
 * The only error whose code a job stores and logs. Any other error is stored and
 * logged as `internal`, never with its message (invariant 8).
 * `retry: false` fails the job at once (the empty guard, say).
 */
export class JobError extends Error {
  readonly code: string;
  readonly retry: boolean;

  constructor(code: string, options: { retry?: boolean } = {}) {
    if (!ERROR_CODE.test(code)) throw new Error('JobError: the code must match ^[a-z_]{1,40}$');
    super(code);
    this.name = 'JobError';
    this.code = code;
    this.retry = options.retry ?? true;
  }
}

export type JobContext = {
  /** Aborted on SIGTERM; a handler may finish its current step and return. */
  signal: AbortSignal;
};

/** `payload` is the job row's `jsonb` (ids only); a handler validates it. */
export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<void>;
