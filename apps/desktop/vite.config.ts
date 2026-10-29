import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const uiLanguage = /^en(?:-|$)/i.test(process.env.PINHAO_UI_LANGUAGE ?? '') ? 'en' : 'zh';
export default defineConfig(({ command }) => ({
  define: { __PINHAO_UI_LANGUAGE__: JSON.stringify(uiLanguage) },
  plugins: [react(), {
    name: 'development-refresh-csp',
    transformIndexHtml(html) {
      const localized = uiLanguage === 'en' ? html.replace('lang="zh-CN"', 'lang="en"').replace('<title>拼好汉化</title>', '<title>Pinhao</title>') : html;
      return command === 'serve' ? localized.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : localized;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'ui-language.json', source: JSON.stringify({ language: uiLanguage }) });
    },
  }],
  base: './',
  server: {
    host: '127.0.0.1', port: 5191, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5190' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
}));
