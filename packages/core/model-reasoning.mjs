export function reasoningPreference(connection = {}) {
  const mode = connection.reasoning ?? 'auto';
  if (!['auto', 'enabled', 'disabled'].includes(mode)) throw new Error('模型推理请选择跟随模型默认、开启或关闭');
  return mode === 'auto' ? {} : { reasoning: mode };
}

export function applyModelReasoning(body, connection = {}) {
  const { reasoning } = reasoningPreference(connection);
  if (!reasoning) return body;
  let hostname;
  try { hostname = new URL(connection.baseUrl).hostname; } catch {}
  if (hostname === 'openrouter.ai') return { ...body, reasoning: { enabled: reasoning === 'enabled' } };
  if (hostname === 'api.deepseek.com') return { ...body, thinking: { type: reasoning } };
  throw Object.assign(new Error('此接口尚未适配推理开关，请将“模型推理”设为“跟随模型默认”。目前支持 OpenRouter 和 DeepSeek 官方接口。'), { code: 'MODEL_REASONING_UNSUPPORTED' });
}
