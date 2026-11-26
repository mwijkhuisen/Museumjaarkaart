import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// One build, two outputs (A§15.1, ADR-0009): the client bundle and the SSR bundle the `ssr` role
// imports. There is no index.html: the SSR bundle writes the whole document and finds the client's
// hashed files through the manifest. `vite build` builds both environments (`builder`).
export default defineConfig({
  root: import.meta.dirname,
  // public/ holds the self-hosted map glyphs and sprites (/map/...); the client build copies it.
  publicDir: 'public',
  plugins: [react()],
  builder: {},
  environments: {
    client: {
      build: {
        outDir: 'dist/client',
        manifest: true,
        // Strict CSP (A§15.6): every asset is a file, never a data: URL.
        assetsInlineLimit: 0,
        rolldownOptions: { input: 'src/entry-client.tsx' },
      },
    },
    ssr: {
      // The ssr environment keeps process.env at run time by default, which would run React's
      // development build wherever NODE_ENV is not "production" (the e2e stack, Vitest).
      define: { 'process.env.NODE_ENV': '"production"' },
      // One self-contained file: the server image needs no web node_modules.
      resolve: { noExternal: true },
      build: {
        outDir: 'dist/server',
        copyPublicDir: false,
        assetsInlineLimit: 0,
        rolldownOptions: { input: 'src/entry-server.tsx', output: { entryFileNames: 'entry-server.js' } },
      },
    },
  },
});
