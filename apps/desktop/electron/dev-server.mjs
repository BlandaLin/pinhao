import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../../../packages/core/service.mjs';
import { productWorker, seedDefaultFont, serviceMethods } from './host.mjs';
import { configureSystemTrust } from './network.mjs';
import { fontCatalog, fontPreview } from './fonts.mjs';
import { commandErrorRecord } from '../../../packages/contracts/command-errors.js';
import { runDshAdaptation } from '../../../packages/technical/dsh-runner.mjs';

configureSystemTrust();
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dataDir = process.env.PINHAO_DATA_DIR || path.join(root, 'local', 'browser-product-data');
const port = Number(process.env.PORT || 5190);
const uiDir = path.join(root, 'apps', 'desktop', 'dist');
await mkdir(dataDir, { recursive: true });
const defaultFont = await seedDefaultFont({ dataDir, bundledFontDir: path.join(root, 'local/runtime/fonts') });
// Browser development keeps keys in this process; the desktop app uses Windows encryption.
const keyring = new Map();
const service = await createService({
  dataDir, defaultFontPath: defaultFont.fontPath,
  adaptationProvider: options => runDshAdaptation({ ...options, dsh: { sourceRoot: path.join(root, 'local/dsh-runtime') } }),
  worker: productWorker({
    pythonPath: process.env.PINHAO_PYTHON || path.join(root, 'local', 'runtime', 'python', 'python.exe'),
    workerPath: path.join(root, 'adapters', 'python', 'worker.py'),
    toolkitPath: path.join(root, 'kits', 'workbench-tutorial', 'toolkit'),
    dependencyDir: path.join(root, 'local', 'dependencies'),
    defaultFontPath: defaultFont.fontPath, fontLicensePath: defaultFont.licensePath, fonts: defaultFont.fonts,
  }),
  secrets: {
    encrypt: text => { const id = randomUUID(); keyring.set(id, text); return id; },
    decrypt: id => { if (!keyring.has(id)) throw new Error('浏览器开发服务已重启，请重新填写 API 密钥'); return keyring.get(id); },
  },
});
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname.startsWith('/fonts/') && ['GET', 'HEAD'].includes(request.method)) {
      const font = await fontPreview(defaultFont.fonts, url.pathname.slice('/fonts/'.length));
      response.writeHead(font.status, Object.fromEntries(font.headers));
      response.end(request.method === 'HEAD' ? undefined : Buffer.from(await font.arrayBuffer()));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      const origin = request.headers.origin;
      if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json') ||
          (origin && ![`http://127.0.0.1:${port}`, 'http://127.0.0.1:5191'].includes(origin))) {
        response.writeHead(403); response.end(JSON.stringify({ ok: false, error: '请求来源不匹配' })); return;
      }
      const method = url.pathname.slice(5);
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new Error('请求内容过大');
        chunks.push(chunk);
      }
      const input = length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      if (!serviceMethods.has(method)) {
        if (['chooseDirectory', 'chooseFile', 'chooseSaveFile'].includes(method)) {
          response.end(JSON.stringify({ ok: true, result: null })); return;
        }
        throw new Error('请在桌面版中使用此操作');
      }
      const result = await service[method](input);
      if (method === 'snapshot') result.fonts = fontCatalog(defaultFont.fonts, `http://127.0.0.1:${port}/fonts/`);
      response.end(JSON.stringify({ ok: true, result })); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(uiDir, '.' + relative);
    const inside = path.relative(uiDir, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('路径无效');
    if (!(await stat(target)).isFile()) throw new Error('文件不存在');
    response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : await readFile(target));
  } catch (error) {
    response.writeHead(url.pathname.startsWith('/api/') ? 400 : 404);
    response.end(JSON.stringify({ ok: false, error: commandErrorRecord(error) }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`拼好汉化工作台 http://127.0.0.1:${port}/`));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await service.close?.();
  server.close(() => process.exit(0));
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
