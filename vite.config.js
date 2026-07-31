import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'icon-192-maskable.png', 'icon-512-maskable.png'],
      manifest: {
        name: 'Pearce & Sons — Staff Transport',
        short_name: 'Pearce & Sons',
        description: 'Pearce & Sons staff transport booking and dispatch platform',
        start_url: '/',
        display: 'standalone',
        background_color: '#0A0C0F',
        theme_color: '#0A0C0F',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Precached via includeAssets above but never declared here, so
          // Android never got proper adaptive/maskable home-screen icon
          // treatment despite the maskable PNGs already existing.
          { src: 'icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache the app shell so it opens instantly even on a flaky connection.
        // API calls to Supabase are NOT cached here — they always hit the network,
        // since trip data needs to be live/current, not served from a stale cache.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        // Without this, push-handler.js (the actual push/notificationclick
        // listeners) just sits in public/ as a precached static file that's
        // never executed — generateSW completely overwrites the old
        // hand-written public/sw.js, and nothing else loads this script into
        // the active service worker. Confirmed: web push notifications have
        // never fired in production because of this, independent of (and in
        // addition to) the separate missing-VAPID_PRIVATE_KEY issue.
        importScripts: ['push-handler.js'],
      },
    }),
  ],
})
