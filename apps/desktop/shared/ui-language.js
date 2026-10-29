import base from './locales/base.en.json' with { type: 'json' };
import app from './locales/app.en.json' with { type: 'json' };
import assist from './locales/assist.en.json' with { type: 'json' };
import settings from './locales/settings.en.json' with { type: 'json' };
import host from './locales/host.en.json' with { type: 'json' };

const configured = typeof __PINHAO_UI_LANGUAGE__ !== 'undefined'
  ? __PINHAO_UI_LANGUAGE__
  : typeof process !== 'undefined' ? process.env.PINHAO_UI_LANGUAGE : 'zh';
export const uiLanguage = /^en(?:-|$)/i.test(configured || '') ? 'en' : 'zh';
export const uiLocale = uiLanguage === 'en' ? 'en-US' : 'zh-CN';
export const englishMessages = Object.freeze({ ...base, ...app, ...assist, ...settings, ...host });

function interpolate(text, values) {
  return text.replace(/\{(\d+)\}/g, (token, index) => index < values.length ? String(values[index]) : token);
}

// Only application-owned presentation text belongs here, never game/user text.
export function translate(source, values = [], language = uiLanguage) {
  const key = typeof source === 'string' ? source : source.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '');
  return interpolate(language === 'en' ? englishMessages[key] ?? key : key, values);
}

export function tr(source, ...values) {
  return translate(source, values);
}

export function trc(context, source, ...values) {
  const key = `${context}::${source}`;
  return uiLanguage === 'en' && Object.hasOwn(englishMessages, key)
    ? interpolate(englishMessages[key], values) : translate(source, values);
}

let messagePatterns;
export function uiMessage(value) {
  if (uiLanguage !== 'en' || typeof value !== 'string' || !/[\u3400-\u9fff]/u.test(value)) return value;
  if (Object.hasOwn(englishMessages, value)) return englishMessages[value];
  if (value.length > 8192) return value;
  messagePatterns ??= Object.entries(englishMessages).filter(([key]) => /\{\d+\}/.test(key)).map(([key, output]) => {
    const indices = [];
    const pieces = key.split(/\{(\d+)\}/g).map((piece, index) => {
      if (index % 2) { indices.push(Number(piece)); return '([\\s\\S]*?)'; }
      return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return { pattern: new RegExp('^' + pieces.join('') + '$', 'u'), output, indices };
  });
  for (const { pattern, output, indices } of messagePatterns) {
    const match = pattern.exec(value);
    if (!match) continue;
    const values = [];
    indices.forEach((index, position) => { values[index] = match[position + 1]; });
    return interpolate(output, values);
  }
  return value;
}
