/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const host = '127.0.0.1';
// Next to apps/web (5200), clear of Windows' reserved low ports.
const port = 5300;
const apiProxy = { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { host, port, strictPort: true, proxy: apiProxy },
  preview: { host, port, strictPort: true, proxy: apiProxy },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
