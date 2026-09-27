import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works at any sub-path (e.g. GitHub Pages /airbnb-finder/)
  base: './',
  // transformers.js is lazy-loaded into its own ~560 kB chunk; that's expected
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    port: 5173,
    strictPort: true,
    // Allow importing ../data/listings.json from outside the frontend root
    fs: { allow: ['..'] }
  }
})
