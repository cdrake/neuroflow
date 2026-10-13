import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths, so the same build serves from any subpath (GitHub Pages,
  // a lab site) as well as inside the desktop app.
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true
  },
  envPrefix: ['VITE_', 'TAURI_']
})
