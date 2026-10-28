import path from 'node:path';
import { quickJsRuntimePackages } from './desktop-runtime.mjs';

/** Keep acceptance-only exports out of the normal portable application. */
export function desktopBundleBuilds({ root, stage, define, args = [] }) {
  const common = { bundle: true, platform: 'node', target: 'node24', format: 'esm',
    legalComments: 'external', metafile: true };
  const banner = { js: "import { createRequire as __pinhaoCreateRequire } from 'node:module'; const require = __pinhaoCreateRequire(import.meta.url);" };
  const entries = [
    ['main', 'apps/desktop/electron/main.mjs', { define, external: ['electron', 'node:*', 'sharp'], banner }],
    ['service-worker', 'apps/desktop/electron/service-worker.mjs', { define, external: ['node:*', 'sharp'], banner }],
    ['sandbox-worker', 'packages/technical/adaptation/sandbox-worker.mjs', { external: ['node:*', ...quickJsRuntimePackages, '@jitl/*'] }],
  ];
  if (args.includes('--acceptance-bundle')) entries.push([
    'dsh-business', 'scripts/dsh-carrier-entry.mjs', { define, external: ['node:*', 'sharp'], banner },
  ]);
  return entries.map(([name, entry, options]) => ({ name, options: { ...common, ...options,
    entryPoints: [path.join(root, entry)], outfile: path.join(stage, `${name}.mjs`) } }));
}
