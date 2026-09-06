/**
 * Optional Cloudflare Worker: a tiny CORS proxy in front of data-api.vnas.vatsim.net.
 *
 * vNAS's /api/* endpoints do not send Access-Control-Allow-Origin, so the
 * trainer normally reads from the baked catalog/ instead. Deploy this worker,
 * then paste its URL (with `?url=` on the end, e.g.
 * https://vnas-proxy.you.workers.dev/?url=) into Settings → vNAS proxy, and the
 * page will fetch airports and scenarios live from vNAS on every load.
 *
 *   npx wrangler deploy proxy-worker.js --name vnas-proxy
 */
const ALLOWED_HOSTS = new Set(['data-api.vnas.vatsim.net']);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'accept, content-type',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: CORS });
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('usage: ?url=https://data-api.vnas.vatsim.net/api/...', { status: 400, headers: CORS });
    let t;
    try { t = new URL(target); } catch { return new Response('bad url', { status: 400, headers: CORS }); }
    if (t.protocol !== 'https:' || !ALLOWED_HOSTS.has(t.hostname)) return new Response('host not allowed', { status: 403, headers: CORS });

    const upstream = await fetch(t.toString(), {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const headers = new Headers(CORS);
    headers.set('content-type', upstream.headers.get('content-type') || 'application/json');
    headers.set('cache-control', 'public, max-age=300');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
