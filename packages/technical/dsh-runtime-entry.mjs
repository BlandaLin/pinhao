import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A source launch is supported by DSH. Pin both SDK and runtime to the same
// checkout rather than resolving an older npm CLI with an equal version name.
const sourceRoot = process.env.PINHAO_DSH_SOURCE_ROOT;
if (!sourceRoot) throw new Error('Missing fixed DSH runtime source');
const require = createRequire(path.join(sourceRoot, 'package.json'));
const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
register({ tsconfig: path.join(sourceRoot, 'apps/cli/tsconfig.json') });
const { runCli } = await import(pathToFileURL(path.join(sourceRoot, 'apps/cli/src/bin.ts')).href);
await runCli();
