import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works at any sub-path (e.g. GitHub Pages /airbnb-finder/)
  base: './',
  // data/listings.json and data/embeddings.bin (built by scripts/build-data.mjs)
  // are served as static files next to index.html
  publicDir: '../data',
  // transformers.js is lazy-loaded into its own ~560 kB chunk; that's expected
  build: { chunkSizeWarningLimit: 1000 },
  server: { port: 5173, strictPort: true },
})
