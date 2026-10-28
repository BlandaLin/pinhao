import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'development-refresh-csp',
    transformIndexHtml(html) {
      return command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html;
    },
  }],
  base: './',
  server: {
    host: '127.0.0.1', port: 5191, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5190' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
}));
