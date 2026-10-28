import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Retain the original player and add a portable Unicode-aware player to LCF builds. */
export async function installLegacyRunner({ outputDir, dependencyDir, fontPath, encoding = '936' }) {
  try { await access(path.join(outputDir, 'RPG_RT.ldb')); } catch { return null; }
  const runtime = path.join(dependencyDir, 'easyrpg');
  await access(path.join(runtime, 'Player.exe'));
  const player = path.join(outputDir, 'PinhaoPlayer.exe');
  await cp(path.join(runtime, 'Player.exe'), player);
  const licenses = path.join(outputDir, 'licenses', 'easyrpg');
  await mkdir(licenses, { recursive: true });
  for (const name of ['COPYING', 'easyrpg-player-0.8.1.1.tar.gz', 'SOURCE.txt']) await cp(path.join(runtime, name), path.join(licenses, name));
  const iniPath = path.join(outputDir, 'RPG_RT.ini');
  let ini;
  try { ini = (await readFile(iniPath)).toString('latin1'); } catch { ini = '[RPG_RT]\r\n'; }
  if (/^\[EasyRPG\][\s\S]*?(?=^\[|$(?![\s\S]))/im.test(ini)) {
    ini = ini.replace(/(^\[EasyRPG\])([\s\S]*?)(?=^\[|$(?![\s\S]))/im, (_all, title, body) => {
      const updated = /^Encoding\s*=/im.test(body) ? body.replace(/^Encoding\s*=.*$/im, `Encoding=${encoding}`) : body + `\r\nEncoding=${encoding}\r\n`;
      return title + updated;
    });
  } else ini += `\r\n[EasyRPG]\r\nEncoding=${encoding}\r\n`;
  await writeFile(iniPath, Buffer.from(ini, 'latin1'));
  const args = ['--encoding', String(encoding)];
  let fontRelative;
  if (fontPath) {
    fontRelative = 'Font/PinhaoChinese' + path.extname(fontPath).toLowerCase();
    await mkdir(path.join(outputDir, 'Font'), { recursive: true });
    await cp(fontPath, path.join(outputDir, fontRelative));
    args.push('--font1', fontRelative, '--font2', fontRelative);
  }
  const quotedArgs = args.map(value => '"' + value.replace(/"/g, '') + '"').join(' ');
  await writeFile(path.join(outputDir, 'PinhaoStart.cmd'), `@echo off\r\ncd /d "%~dp0"\r\n"%~dp0PinhaoPlayer.exe" ${quotedArgs}\r\n`, 'ascii');
  await writeFile(path.join(outputDir, 'EasyRPG-使用说明.txt'), '本副本提供独立的 EasyRPG 运行器。双击 PinhaoStart.cmd 启动中文版本。\n原 RPG_RT.exe 保留在副本中。\n特殊 DynRPG、Maniacs 或自定义运行器插件需要逐游戏兼容检查。\nEasyRPG 源码、许可证与构建来源见 licenses/easyrpg。\n', 'utf8');
  return { launchPath: player, launchArgs: args, checks: [{ name: '旧版中文运行器', status: 'passed', detail: '已随副本携带 EasyRPG、代码页与字体；实际场景验收另计' }] };
}
