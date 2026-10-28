import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  entryPoints: [root + 'electron/preload.mjs'],
  outfile: root + 'dist-host/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
});
