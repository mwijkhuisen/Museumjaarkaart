import { expect, test } from './fixtures.ts';

// A§17.2, P2a: 50 parallel password sign-ins (half unknown addresses, half an owner's account, which has no password)
// must each answer 401 or 429, never a 5xx. The per-prefix limiter refuses most of them (429); the hash concurrency
// itself is covered in-process. stack.sh runs this last, in Chromium only, and then checks that the api neither
// restarted nor was OOM-killed (memory.events), printing memory.peak.
test('@load 50 parallel password sign-ins answer 401 or 429', async ({ request }) => {
  const answers = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      request.post('/api/v1/auth/password', {
        headers: { origin: 'https://mjk.test', 'content-type': 'application/json' },
        data: {
          email: i % 2 === 0 ? `nobody-${i}@mjk.test` : 'owner-chromium@mjk.test',
          password: 'wrong staple seven horses',
        },
      }),
    ),
  );
  expect(answers.map((r) => r.status()).filter((s) => s !== 401 && s !== 429)).toEqual([]);
});
