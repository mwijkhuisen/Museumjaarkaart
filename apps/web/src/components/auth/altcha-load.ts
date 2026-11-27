import 'altcha/external';
import 'altcha/altcha.css';
import type { AltchaGlobal } from 'altcha/types';
// Only SHA-256 (what the server's challenge asks for, A§9). Never the argon2id or scrypt workers:
// they carry WebAssembly, which the CSP forbids (no 'wasm-unsafe-eval', A§15.6). Vite turns the
// worker into a same-origin file under /assets (`worker-src 'self'`), never a blob: or data: URL.
import ShaWorker from 'altcha/workers/sha?worker';

// The widget's code, its stylesheet and its worker, as one lazy chunk (A§15.1): Altcha.tsx reaches
// this module only through a dynamic import, so no page that has no form loads any of it. `altcha/external`
// is the build without bundled workers; `altcha/i18n` is never imported: the strings are ours.

let registered = false;
// `altcha/external` sets this global (its own typings do not reach this project's program).
const altcha = () => (globalThis as unknown as { $altcha: AltchaGlobal }).$altcha;

/** Registers the SHA-256 worker once and the widget's strings for `locale` (every key the widget reads). */
export function registerAltcha(locale: string, strings: Record<string, string>): void {
  if (!registered) {
    altcha().algorithms.set('SHA-256', () => new ShaWorker());
    registered = true;
  }
  altcha().i18n.set(locale, strings);
}
