/**
 * A local CORS proxy for live mode during development. vNAS serves /api/* without
 * an Access-Control-Allow-Origin header, so the browser cannot read it directly;
 * this forwards `?url=<encoded vNAS URL>` and adds the header. Deploy
 * legacy/proxy-worker.js for the same thing in production.
 *
 *   bun run proxy            # http://localhost:8787/?url=
 *   PORT=9000 bun run proxy
 */
const port = Number(process.env['PORT'] ?? 8787)
const allowed = new Set(['data-api.vnas.vatsim.net'])
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }

Bun.serve({
  port,
  fetch: async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors })
    }
    const target = new URL(request.url).searchParams.get('url')
    if (target === null) {
      return new Response('usage: ?url=<encoded vNAS URL>', { status: 400, headers: cors })
    }
    let upstream: URL
    try {
      upstream = new URL(target)
    } catch {
      return new Response('bad url', { status: 400, headers: cors })
    }
    if (!allowed.has(upstream.hostname)) {
      return new Response('host not allowed', { status: 403, headers: cors })
    }
    const response = await fetch(upstream, { headers: { accept: 'application/json' } })
    return new Response(response.body, {
      status: response.status,
      headers: { ...cors, 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  },
})
console.log(`vNAS dev proxy on http://localhost:${port}/?url=`)
