import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'

// `base: './'` keeps built asset URLs relative, so the site works at the root of a
// domain and under a GitHub Pages project path alike (the legacy app relied on the same).
export default defineConfig({
  base: './',
  plugins: [foldkit()],
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
  optimizeDeps: {
    entries: ['src/main.ts'],
  },
})
