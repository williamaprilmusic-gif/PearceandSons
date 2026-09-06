import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
      output: {
        // Split the rarely-changing third-party code into its own chunk.
        // App code changes on every deploy; React + supabase-js do not,
        // so this lets a returning user's browser reuse the cached
        // vendor chunk instead of re-downloading ~all of it because a
        // one-line app change rotated the single bundle's hash.
        // (@sentry is deliberately NOT here — errorReporter.js keeps it
        // in its own lazy chunk that is only fetched when a DSN is set;
        // leaflet is already isolated in the DriverNavMap lazy chunk.)
        // Function form, not the object form — this project builds with
        // rolldown-vite, which only supports manualChunks as a function.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'vendor-supabase';
        },
      },
    },
  },
  test: {
    // jsdom, not the Vitest default 'node' environment — the app's main
    // source file references browser globals (window/document/navigator)
    // at module scope (e.g. the service-worker registration check), so
    // even importing it for a pure-function unit test needs those to
    // exist. Kept lightweight: no jest-dom/testing-library setup, since
    // this first pass tests pure business logic, not rendered components.
    environment: 'jsdom',
  },
});
