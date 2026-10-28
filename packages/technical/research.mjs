import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

async function bounded(operation, { signal, timeoutMs = 15000 } = {}) {
  const controller = new AbortController(), signals = [controller.signal, ...(signal ? [signal] : [])];
  const active = AbortSignal.any(signals);
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('公开资料读取超时')), timeoutMs) : null;
  let onAbort;
  try {
    active.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(active.reason instanceof Error ? active.reason : new DOMException('公开资料任务已取消', 'AbortError'));
      active.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => operation(active)), cancelled]);
  } finally { clearTimeout(timer); if (onAbort) active.removeEventListener('abort', onAbort); }
}

export function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 2) || (a === 198 && [18, 19].includes(b))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (version === 6) {
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    if (normalized.startsWith('::ffff:')) return false;
    const first = parseInt(normalized.split(':')[0] || '0', 16);
    const second = parseInt(normalized.split(':')[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && !(first === 0x2001 && second < 0x200)
      && !normalized.startsWith('2001:db8:') && !normalized.startsWith('2002:');
  }
  return false;
}

export async function resolvePublicUrl(value, { lookup = dns.lookup, signal, timeoutMs = 15000 } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('公开资料使用 HTTPS 标准端口');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('资料地址需要公网主机');
  signal?.throwIfAborted();
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await bounded(() => lookup(hostname, { all: true, verbatim: true }), { signal, timeoutMs });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('资料地址包含本地或保留网络');
  return { url, address: addresses[0] };
}

function requestPage({ url, address }, { signal, maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal, agent: false, headers: { 'User-Agent': 'Pinhao-Technical-Research/0.4', Accept: 'text/html,text/plain,application/json' },
      lookup: (_hostname, options, callback) => callback(null, options.all ? [address] : address.address, address.family),
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (response.headers.location) resolve({ redirect: response.headers.location }); else reject(new Error('公开资料重定向缺少目标地址'));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); reject(new Error(`公开资料返回 HTTP ${response.statusCode}`)); return; }
      const contentType = response.headers['content-type'] ?? '';
      if (!/text\/|application\/(?:json|xml|xhtml\+xml)/i.test(contentType)) { response.destroy(); reject(new Error('公开资料需要文本格式')); return; }
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(new Error('公开资料超过读取上限')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), contentType }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('公开资料读取超时')));
    request.on('error', reject);
  });
}

export async function readPublicPage(value, { signal, maxBytes = 1024 * 1024, timeoutMs = 15000, maxRedirects = 3, lookup, request = requestPage } = {}) {
  return bounded(async active => {
    let target = value;
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      active.throwIfAborted();
      const resolved = await resolvePublicUrl(target, { lookup, signal: active, timeoutMs: 0 });
      const response = await request(resolved, { signal: active, maxBytes, timeoutMs });
      if (response.redirect) { target = new URL(response.redirect, resolved.url).href; continue; }
      const links = [...response.text.matchAll(/href=["']([^"']+)["']/gi)].slice(0, 120).map(match => {
        try { const link = new URL(match[1].replaceAll('&amp;', '&'), resolved.url); return link.protocol === 'https:' ? link.href : null; } catch { return null; }
      }).filter(Boolean);
      const text = response.text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { url: resolved.url.href, text, links: [...new Set(links)].slice(0, 40), contentType: response.contentType, sourceKind: 'untrusted-public-reference' };
    }
    throw new Error('公开资料重定向次数达到上限');
  }, { signal, timeoutMs });
}

export async function searchPublicReferences(query, options = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('请输入 1 至 500 字的技术检索词');
  return readPublicPage(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, options);
}
