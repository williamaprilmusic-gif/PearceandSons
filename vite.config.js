import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
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
