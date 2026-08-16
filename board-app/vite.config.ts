import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-mode proxy points at the bare-node server so /api works under `vite`.
// Production never uses vite: server.cjs serves dist/ + the API itself.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:4272' },
  },
  build: { outDir: 'dist', sourcemap: false },
});
