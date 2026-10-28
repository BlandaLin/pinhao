import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const validTheme = value => value === 'light' || value === 'dark' || value === 'system';

export async function createAppearance({ directory, nativeTheme, onChanged = () => {} }) {
  const file = path.join(directory, 'appearance.json');
  let theme;
  try { theme = JSON.parse(await readFile(file, 'utf8'))?.theme; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  nativeTheme.themeSource = validTheme(theme) ? theme : 'system';
  const background = () => nativeTheme.shouldUseDarkColors ? '#181716' : '#fafafa';
  nativeTheme.on?.('updated', () => onChanged(background()));
  let writes = Promise.resolve();
  return {
    get backgroundColor() { return background(); },
    async setTheme(value) {
      if (!validTheme(value)) throw new Error('请选择日间模式或深夜模式');
      nativeTheme.themeSource = value;
      onChanged(background());
      const operation = writes.catch(() => {}).then(async () => {
        await mkdir(directory, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ theme: value }), 'utf8');
        await rename(`${file}.tmp`, file);
      });
      writes = operation;
      await operation;
    },
  };
}
