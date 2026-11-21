// Zod 4 probes `new Function` when it builds an object schema, which is a CSP violation in the
// browser (no 'unsafe-eval', A§15.6). This is its own module and every entry imports it first,
// because ESM evaluates every import before the importing module's body (CLAUDE.md gotcha).
import { config } from 'zod';

config({ jitless: true });
