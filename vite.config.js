import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  envDir: 'client',
  server: { port: 5173, strictPort: true, proxy: { '/api': 'https://visioai-xqse.onrender.com' } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
