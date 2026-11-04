// The retry delay of a failed job [U]: 15 minutes, doubling per attempt, capped at 6 hours.

const BASE_MS = 15 * 60_000;
const CAP_MS = 6 * 3_600_000;

/** Milliseconds to wait after the `attempts`-th failed attempt (1-based). */
export function backoff(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  // The exponent is capped first, so a huge `attempts` never reaches Infinity.
  return Math.min(CAP_MS, BASE_MS * 2 ** Math.min(n - 1, 10));
}
