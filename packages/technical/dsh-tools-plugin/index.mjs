import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'pinhao-business-tools';
export const inject = ['tools', 'agents', 'loader', 'pluginPackages', 'systemPrompt', 'llm'];

/** Only protocol and identity translation live in the runtime process. */
export async function apply(ctx) {
  const endpoint = process.env.PINHAO_DSH_TOOL_URL;
  const token = process.env.PINHAO_DSH_TOOL_TOKEN;
  const sessionId = process.env.PINHAO_DSH_SESSION_ID;
  if (!endpoint || !token || !sessionId) throw new Error('Missing host tool binding');
  const request = async (route, input, signal) => {
    const response = await fetch(`${endpoint}${route}`, { method: input === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? 'Host tool bridge failed'), body.error);
    if (route === '/execute') {
      if (body?.ok !== true) throw Object.assign(new Error(body?.error?.message ?? 'Host execute response failed'), body?.error);
      return body.result;
    }
    return body;
  };
  const definitions = await request('/definitions');
  // Readiness follows the registered route, not import order or a delay.
  await new Promise((resolve, reject) => {
    let settled = false;
    const check = () => {
      if (!settled && ctx.llm.listProviders().some(provider => provider.id === 'pinhao-relay')) {
        settled = true; dispose(); resolve();
      }
    };
    const dispose = ctx.on('llm/adapters-updated', check);
    ctx.effect(() => () => { dispose(); if (!settled) reject(new Error('Model route did not become ready before runtime disposal')); });
    check();
  });
  await ctx.llm.resolveCallConfig({ provider: 'pinhao-relay', model: process.env.PINHAO_DSH_MODEL,
    maxTokens: Number(process.env.PINHAO_DSH_MAX_TOKENS) });
  let sharedFacts = (await request('/status')).lessons ?? '';
  ctx.systemPrompt.section({ name: 'pinhao-shared-facts', order: 100, text: () => sharedFacts, interpolate: false });
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.id !== sessionId) throw new Error('Unexpected agent in a single-job runtime');
    const expected = process.env.PINHAO_DSH_PENDING_PROMPT_HASH;
    const messages = agent.session.snapshotEvents().flatMap(event => [event.data?.message, ...(event.data?.inserted ?? [])]).filter(Boolean);
    const present = Boolean(expected && messages.some(message => createHash('sha256')
      .update((message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')).digest('hex') === expected));
    await request('/restored', { sessionId, source, pendingPromptDigest: expected || null, pendingPromptPresent: present });
    const cache = ctx.loader.internal?.loadCache;
    const modules = [];
    for (const entry of ctx.loader.entries()) {
      if (entry.disabled || !entry.moduleNamespace || !entry.fiber) continue;
      let resolvedURL;
      if (cache) for (const [url, variants] of cache) {
        for (const job of Object.values(variants)) {
          try { if (job?.module?.getNamespace() === entry.moduleNamespace) resolvedURL = url; } catch {}
        }
      }
      const owner = ctx.pluginPackages.packageOf(entry.options.name, entry.parent.tree.ctx.baseUrl);
      if (!resolvedURL && /^[A-Za-z]:[\\/]/.test(entry.options.name)) resolvedURL = pathToFileURL(entry.options.name).href;
      let sha256;
      if (resolvedURL?.startsWith('file:')) sha256 = createHash('sha256').update(await readFile(fileURLToPath(resolvedURL))).digest('hex');
      modules.push({ id: entry.id, name: entry.options.name, state: entry.fiber.state,
        ...(owner ? { packageDir: owner.dir, version: owner.version } : {}),
        ...(resolvedURL ? { resolvedURL, sha256 } : {}), provenance: resolvedURL ? 'loaded-module-identity' : 'runtime-resolution-package' });
    }
    await request('/runtime-manifest', { sessionId, source, modules, registeredTools: definitions });
  });
  for (const definition of definitions) {
    const { concurrencySafe, ...schema } = definition;
    ctx.tools.register({ ...schema, isConcurrencySafe: () => concurrencySafe === true,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (exec.agent?.id !== sessionId) throw new Error('Tool caller does not own this runtime');
        const callScope = String(exec.agent.session.seq);
        const envelope = await request('/allocate', { sessionId, toolCallId: exec.callId,
          rootToolCallId: exec.rootCallId ?? null, callScope, toolName: definition.name, arguments: args }, exec.signal);
        return request('/execute', envelope, exec.signal);
      },
    });
  }
  // Business completion, not a model's final sentence, owns the stop boundary.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (agent.id !== sessionId) return { kind: 'reject' };
    const status = await request('/status', undefined, signal);
    sharedFacts = status.lessons ?? '';
    if (status.done) return { kind: 'reject' };
    return next();
  });
  ctx.provide('pinhaoBusinessTools', { registeredNames: definitions.map(definition => definition.name) });
}
