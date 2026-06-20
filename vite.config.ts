import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(() => ({
  // Packaged Electron windows load dist/index.html through file://, so assets
  // must resolve relative to that file instead of from the filesystem root.
  base: './',
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
}))
