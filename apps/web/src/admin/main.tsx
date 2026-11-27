import '../lib/zod.ts';
import '../styles.css';
import { createRoot } from 'react-dom/client';
import { setLocale } from '../paraglide/runtime.js';
import { AdminApp } from './AdminApp.tsx';

// The admin entry (A§15.1: the third build output, `dist/client/admin.html`). Admin exists only on
// `admin.<domain>` behind Cloudflare Access (A§9): a plain client render into #admin, no server
// render and no hydration, in Dutch.

const root = document.getElementById('admin');
if (root !== null) {
  setLocale('nl', { reload: false });
  createRoot(root).render(<AdminApp />);
}
