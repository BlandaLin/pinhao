import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Menu } from 'electron';

async function verifyWelcome(window, dataDir) {
  const verified = await window.webContents.executeJavaScript(`(async () => {
    for (var attempt = 0; attempt < 100 && document.querySelector('main .loading-state'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    var help = document.querySelector('[aria-label="使用教程"]');
    if (!document.querySelector('dialog[open]')) help.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    var dialog = document.querySelector('dialog[open]');
    return Boolean(dialog && document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent === '欢迎使用拼好汉化' && dialog.querySelectorAll('.welcome-steps li').length === 4);
  })()`);
  if (!verified) throw new Error('使用教程检查失败');
  await writeFile(path.join(dataDir, 'welcome-guide.png'), (await window.webContents.capturePage()).toPNG());
  const [width, height] = window.getSize();
  window.setSize(900, 620);
  await new Promise(resolve => setTimeout(resolve, 150));
  await writeFile(path.join(dataDir, 'welcome-guide-compact.png'), (await window.webContents.capturePage()).toPNG());
  window.setSize(width, height);
  await window.webContents.executeJavaScript(`document.querySelector('dialog[open] [aria-label="关闭对话框"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 50));
  return verified;
}

async function verifyEditKeys(window) {
  const contents = window.webContents;
  window.focus(); contents.focus();
  await contents.executeJavaScript('var edit = document.createElement("input"); edit.id = "pinhao-smoke-editor"; edit.value = "neutral"; edit.style.cssText = "position:fixed;left:8px;top:8px;z-index:10000"; document.body.appendChild(edit); edit.focus();');
  const shortcut = async keyCode => {
    for (const type of ['keyDown', 'keyUp']) contents.sendInputEvent({ type, keyCode, modifiers: ['control'] });
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  try {
    await shortcut('A');
    const selected = await contents.executeJavaScript('var edit = document.getElementById("pinhao-smoke-editor"); edit.selectionStart === 0 && edit.selectionEnd === edit.value.length;');
    await contents.insertText('changed');
    await shortcut('Z');
    return selected && await contents.executeJavaScript('document.getElementById("pinhao-smoke-editor").value === "neutral"');
  } finally { await contents.executeJavaScript('document.getElementById("pinhao-smoke-editor").remove()'); }
}

async function verifyGameDrop(window, filePath) {
  const contents = window.webContents;
  contents.debugger.attach('1.3');
  try {
    await contents.executeJavaScript('var picker = document.createElement("input"); picker.type = "file"; picker.id = "pinhao-drop-check"; picker.hidden = true; document.body.appendChild(picker);');
    const { root } = await contents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#pinhao-drop-check' });
    await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] });
    await contents.executeJavaScript(`var transfer = new DataTransfer(); transfer.items.add(document.getElementById('pinhao-drop-check').files[0]); document.querySelector('.app').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));`);
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const directory = await contents.executeJavaScript('document.querySelector(".dialog .path-input input")?.value || ""');
      if (directory === path.dirname(filePath)) {
        await contents.executeJavaScript(`var importInput = document.querySelector('.dialog .path-input input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(importInput, 'manual-edit'); importInput.dispatchEvent(new Event('input', { bubbles: true }));`);
        await new Promise(resolve => setTimeout(resolve, 100));
        await contents.executeJavaScript(`document.querySelector('.app').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));`);
        await new Promise(resolve => setTimeout(resolve, 200));
        const repeated = await contents.executeJavaScript('document.querySelector(".dialog .path-input input")?.value || ""');
        if (repeated !== path.dirname(filePath)) throw new Error('重复拖入游戏后未刷新手动修改过的目录');
        await contents.executeJavaScript('document.querySelector(".dialog header button").click()');
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('拖入游戏后未填入导入目录');
  } finally {
    await contents.executeJavaScript('document.getElementById("pinhao-drop-check")?.remove()');
    contents.debugger.detach();
  }
}

async function verifyFontChoices(window, dataDir) {
  const result = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[aria-label="设置"]').click();
    for (var attempt = 0; attempt < 100 && document.querySelectorAll('.font-choice').length !== 3; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    var fonts = (await window.pinhao.snapshot()).fonts;
    var loaded = await Promise.all(fonts.map(async font => {
      var faces = await document.fonts.load('28px "PinhaoPreview-' + font.id + '"', '山河入梦故事新生');
      return { name: font.name, loaded: faces.length === 1 && faces[0].status === 'loaded' };
    }));
    var choices = document.querySelectorAll('.font-choice input');
    choices[1].click();
    var selectable = choices[1].checked && choices[1].closest('label').classList.contains('selected');
    choices[2].click();
    document.querySelector('.font-panel').scrollIntoView({ block: 'center' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { loaded, selectable };
  })()`);
  if (result.loaded.length !== 3 || result.loaded.some(font => !font.loaded) || !result.selectable) throw new Error('内置字体预览或点选检查失败');
  await writeFile(path.join(dataDir, 'font-choices.png'), (await window.webContents.capturePage()).toPNG());
  return result;
}

/** An opt-in localhost-only desktop integration fixture, never a paid provider. */
export async function runDesktopSmoke({ service, window, windowIcon, secrets, dataDir, gameDir }) {
  const welcomeVerified = await verifyWelcome(window, dataDir);
  const renderer = await window.webContents.executeJavaScript(`(async () => {
    const value = await window.pinhao.snapshot();
    const logo = document.querySelector('.brand-mark');
    const favicon = document.querySelector('link[rel=icon]');
    const image = new Image();
    const faviconLoaded = Boolean(favicon) && await new Promise(resolve => {
      image.onload = () => resolve(image.naturalWidth > 0);
      image.onerror = () => resolve(false);
      image.src = favicon.href;
    });
    return { connected: true, projects: value.projects.length, logoLoaded: Boolean(logo && logo.naturalWidth > 0), faviconLoaded };
  })()`);
  const shellVerified = { menuGone: Menu.getApplicationMenu() === null, windowIconLoaded: Boolean(windowIcon && !windowIcon.isEmpty()), editShortcuts: await verifyEditKeys(window) };
  const encrypted = await secrets.encrypt('neutral-test-key');
  const cryptoVerified = await secrets.decrypt(encrypted) === 'neutral-test-key';
  const bitmap = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#a72e2e' } }).png().toBuffer();
  const imageVerified = (await sharp(bitmap).metadata()).width === 2;
  const dropVerified = process.env.PINHAO_SMOKE_IMPORT_PATH
    ? await verifyGameDrop(window, path.resolve(process.env.PINHAO_SMOKE_IMPORT_PATH)) : undefined;
  const fontsVerified = process.env.PINHAO_SMOKE_FONTS === '1' ? await verifyFontChoices(window, dataDir) : undefined;
  let httpsDiagnostic;
  if (process.env.PINHAO_SMOKE_DEEPSEEK === '1') {
    const response = await fetch('https://api.deepseek.com/models', { signal: AbortSignal.timeout(20_000) });
    httpsDiagnostic = { host: 'api.deepseek.com', status: response.status, tlsVerified: true, authenticated: false };
    await response.body?.cancel();
  }
  let extraction, pipeline;
  if (gameDir) {
    if (!process.env.PINHAO_DATA_DIR) throw new Error('桌面样例检查需要独立 PINHAO_DATA_DIR');
    extraction = await service.createProject({ gameDir, name: 'Neutral Desktop Check' });
    let calls = 0, technicalCalls = 0;
    const server = createServer(async (request, response) => {
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body); calls++;
        let message, finish = 'stop';
        if (parsed.tools) {
          technicalCalls++;
          const replies = parsed.messages.filter(item => item.role === 'tool').length;
          const name = replies === 0 ? 'inspect_game' : replies === 1 ? 'select_recipe' : undefined;
          message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'inspect_game' ? {} : { decision: 'native-standard', summary: 'Neutral native recipe verified', selectedCandidateIds: [] }) } }] } : { role: 'assistant', content: 'Recipe committed.' };
          if (name) finish = 'tool_calls';
        } else {
          const payload = JSON.parse(parsed.messages.at(-1).content);
          const result = payload.task === 'proofreading'
            ? { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits: [], issues: [] }
            : { records: payload.units.map(unit => ({ id: unit.id, translation: `译${unit.source ?? payload.sources?.[unit.sourceRef]}`, notes: '' })) };
          message = { role: 'assistant', content: JSON.stringify(result) };
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 'local-desktop-smoke', object: 'chat.completion', created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { settings } = await service.snapshot();
      const connection = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-localhost', apiKey: 'neutral-test-key' };
      await service.saveSettings({ ...settings, connection, roles: Object.fromEntries(['technical', 'translation', 'proofreading'].map(role => [role, { useShared: true, connection: { baseUrl: connection.baseUrl, model: connection.model } }])), processImages: false, proofreading: true });
      await service.startProject({ projectId: extraction.id });
      const deadline = Date.now() + 60_000;
      let detail;
      do {
        detail = await service.getProject({ projectId: extraction.id });
        if (detail.status === 'paused' || detail.status === 'failed') throw new Error(detail.lastError || detail.stage);
        if (detail.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      if (detail.status !== 'completed' || !detail.builds.length || technicalCalls !== 3) throw new Error('桌面 SDK 制作流程检查失败');
      const packagePath = path.join(dataDir, 'neutral-handoff.zip');
      await service.exportPackage({ projectId: extraction.id, filePath: packagePath, profile: 'text' });
      const imported = await service.importPackage({ projectId: extraction.id, filePath: packagePath });
      await service.exportRelease({ projectId: extraction.id, filePath: path.join(dataDir, 'neutral-release.zip') });
      pipeline = { status: detail.status, done: detail.done, total: detail.total, builds: detail.builds.length, changed: detail.builds.at(-1).changed, modelCalls: calls, technicalCalls, idempotentImport: imported.accepted === 0 };
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  if (!renderer.connected || !renderer.logoLoaded || !renderer.faviconLoaded || !Object.values(shellVerified).every(Boolean) || !cryptoVerified || !imageVerified || (extraction && extraction.status !== 'ready')) throw new Error('桌面集成检查失败');
  const result = { smoke: true, electron: process.versions.electron, node: process.versions.node, renderer, shellVerified, cryptoVerified, imageVerified, welcomeVerified, dropVerified, fontsVerified, httpsDiagnostic, extraction: extraction ? { total: extraction.total, status: extraction.status } : undefined, pipeline };
  await writeFile(path.join(dataDir, 'desktop-smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(path.join(dataDir, 'desktop-smoke.png'), (await window.webContents.capturePage()).toPNG());
  return result;
}
