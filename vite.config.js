import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  envDir: 'client',
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
