import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || env.API_PROXY_TARGET || 'http://127.0.0.1:8000';

  return {
    plugins: [
      react(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.js',
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
        manifest: {
          name: 'MacroLens — Calorie & Macro Tracker',
          short_name: 'MacroLens',
          description: 'Snap any meal for instant AI calorie and macro tracking.',
          theme_color: '#080a0f',
          background_color: '#080a0f',
          display: 'standalone',
          orientation: 'portrait',
          scope: '/',
          start_url: '/',
          icons: [
            { src: '/icon.svg?v=mono1', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: '/icon-192.png?v=mono1', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png?v=mono1', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png?v=mono1', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: '/apple-touch-icon.png?v=mono1', sizes: '180x180', type: 'image/png' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        },
      }),
    ],
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
