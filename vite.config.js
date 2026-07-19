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
        name: 'TransitOS',
        short_name: 'TransitOS',
        description: 'Corporate Transport Operations Platform',
        start_url: '/',
        display: 'standalone',
        background_color: '#0A0C0F',
        theme_color: '#0A0C0F',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache the app shell so it opens instantly even on a flaky connection.
        // API calls to Supabase are NOT cached here — they always hit the network,
        // since trip data needs to be live/current, not served from a stale cache.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
    }),
  ],
})
