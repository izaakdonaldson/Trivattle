import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3001', ws: true, changeOrigin: false },
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/images': { target: 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
});
