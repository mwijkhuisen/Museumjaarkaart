import './lib/zod.ts';
import './styles.css';
import { hydrateRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createQueryClient } from './lib/api.ts';
import { localeOf } from './lib/routes.ts';
import { setLocale } from './paraglide/runtime.js';

// Hydrates a server-rendered page (A§15.1). The cache starts from `mjk-state` under the same keys
// the server used, so nothing in it is fetched again. Error documents carry no client script.

const root = document.getElementById('app');
const stateBlock = document.getElementById('mjk-state');
if (root !== null && stateBlock !== null) {
  const path = location.pathname + location.search;
  setLocale(localeOf(path), { reload: false });
  const brand = document.querySelector('meta[name="application-name"]')?.getAttribute('content') ?? '';
  const queryClient = createQueryClient();
  const state = JSON.parse(stateBlock.textContent ?? '{}') as Record<string, unknown>;
  for (const [key, data] of Object.entries(state)) queryClient.setQueryData([key], data);
  hydrateRoot(root, <App path={path} queryClient={queryClient} config={{ brand }} />, {
    // Production React reports a text mismatch only here; the e2e specs fail on console errors.
    onRecoverableError: (error) => console.error(error),
  });
}
