// server.mjs — OpenCode Mod Loader (Estrategia A: reverse proxy Node.js)
//
// Architecture:
//
//   ┌─────────────────┐         ┌──────────────────────────────┐         ┌─────────────────┐
//   │  Navegador      │  ───────▶  Proxy (:8080)             │  ───────▶  OpenCode Server  │
//   │  localhost:8080 │  HTTP   │  • watch /scripts            │   HTTP   │  localhost:4096  │
//   │                 │ ◀───────  • inject mods in HTML/JS    │ ◀───────  • upstream proxy  │
//   └─────────────────┘         │  • serve /__oc_mods/*.js    │         └─────────────────┘
//                              └──────────────────────────────┘
//
// Cache busting strategy:
//   1. Mods live in /scripts. mtime changes when user saves a file.
//   2. Each response carries:
//      - Cache-Control: no-store, must-revalidate  (force re-check with server)
//      - ETag: <sha256 of mod bundle>             (cheap revalidation)
//      - X-OC-Mod-Loaded: <count>                  (debug header)
//   3. If ETag matches the If-None-Match header, return 304 Not Modified.
//   4. The bundle itself doesn't have a stable URL (Vite hashes it), so we
//      re-prepend mods on every request. The browser CAN cache the bundle
//      but the mod preamble changes only when mods change → ETag handles it.
//   5. Mods served at /__oc_mods/<id>.js include ETag + Last-Modified for
//      fine-grained cache control.

import http from 'node:http'
import { promises as fs, watch } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ModLoader } from './internal/loader.mjs'
import { shouldInject, injectHTML, injectBundle, getStandaloneModBundle } from './internal/injector.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ============================================================
// Configuration
// ============================================================
const CONFIG = {
  LISTEN_PORT: parseInt(process.env.OC_PROXY_PORT || '8080', 10),
  LISTEN_HOST: process.env.OC_PROXY_HOST || '0.0.0.0',
  TARGET_URL: process.env.OC_TARGET_URL || 'http://127.0.0.1:4096',
  SCRIPTS_DIR: process.env.OC_SCRIPTS_DIR || path.join(__dirname, 'scripts'),
  WATCH_INTERVAL_MS: parseInt(process.env.OC_WATCH_MS || '500', 10),
  VERBOSE: process.env.OC_VERBOSE === '1',
  LOG_TO_FILE: process.env.OC_LOG_FILE || path.join(__dirname, 'logs', 'mod-loader.log'),
}

// ============================================================
// Logging
// ============================================================
import fsSync from 'node:fs'
const logStream = fsSync.createWriteStream(CONFIG.LOG_TO_FILE, { flags: 'a' })
function log(level, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  }
  const line = JSON.stringify(entry)
  // Console
  if (level === 'error') console.error(line)
  else if (level === 'info' || CONFIG.VERBOSE) console.log(line)
  // File
  logStream.write(line + '\n')
}

// ============================================================
// Mod loader
// ============================================================
const loader = new ModLoader({ scriptsDir: CONFIG.SCRIPTS_DIR, log })

;(async () => {
  try {
    await fs.mkdir(CONFIG.SCRIPTS_DIR, { recursive: true })
    const summary = await loader.scan()
    log('info', 'Initial scan complete', {
      mods: summary.mods.length,
      collisions: summary.collisions.length,
    })
    if (summary.collisions.length > 0) {
      log('error', 'Mod id collisions detected', { collisions: summary.collisions })
    }
  } catch (err) {
    log('error', 'Initial scan failed', { error: err.message })
  }
})()

// Polling watcher (more reliable than fs.watch across Windows + WSL)
const stopWatch = loader.watch({
  intervalMs: CONFIG.WATCH_INTERVAL_MS,
  onChange: (summary) => {
    log('info', 'Mod registry changed', {
      count: summary.mods.length,
      mods: summary.mods.map((m) => `${m.id}@${m.version}`),
    })
  },
})

// ============================================================
// Proxy server
// ============================================================
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
])

function buildETag(content) {
  return '"' + crypto.createHash('sha256').update(content).digest('base64').slice(0, 22) + '"'
}

async function handleProxy(req, res) {
  const reqUrl = req.url || '/'
  const t0 = Date.now()

  // ─── Special: serve mod-loader internal endpoints ────────────────
  // Order matters: specific paths before generic /__oc_mods/<id>
  if (reqUrl === '/__oc_mods/loader.js') {
    const bundle = getStandaloneModBundle(loader)
    if (!bundle) {
      res.statusCode = 204
      return res.end()
    }
    const etag = buildETag(bundle)
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      res.setHeader('etag', etag)
      return res.end()
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/javascript; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, must-revalidate')
    res.setHeader('etag', etag)
    res.setHeader('x-oc-mod-count', String(loader.registry.size))
    return res.end(bundle)
  }

  if (reqUrl === '/__oc_mods/manifest.json') {
    const summary = loader.summary()
    const etag = buildETag(JSON.stringify(summary))
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      res.setHeader('etag', etag)
      return res.end()
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, must-revalidate')
    res.setHeader('etag', etag)
    return res.end(JSON.stringify(summary, null, 2))
  }

  // Force a registry rescan (useful for tests + immediate hot reload)
  if (reqUrl === '/__oc_mods/refresh') {
    const summary = await loader.scan()
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({
      ok: true,
      count: summary.mods.length,
      serverCount: summary.serverMods.length,
    }))
  }

  if (reqUrl.startsWith('/__oc_mods/')) {
    const id = decodeURIComponent(reqUrl.slice('/__oc_mods/'.length).replace(/\.js$/, ''))
    const mod = loader.getMod(id)
    if (!mod) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: `mod not found: ${id}` }))
    }
    const etag = '"' + mod.hash + '"'
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      res.setHeader('etag', etag)
      return res.end()
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/javascript; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, must-revalidate')
    res.setHeader('etag', etag)
    res.setHeader('last-modified', new Date(mod.mtime).toUTCString())
    return res.end(mod.source)
  }

  // ─── Forward everything else to upstream ──────────────────────────
  for (const mod of loader.serverMods.values()) {
    if (typeof mod.onRequest !== 'function') continue
    try {
      const handled = await mod.onRequest(req, res, { config: CONFIG, loader, log })
      if (handled || res.writableEnded) return
    } catch (err) {
      log('error', 'Server mod onRequest failed', { mod: mod.id, url: reqUrl, error: err.message })
      if (res.writableEnded) return
      if (res.headersSent) throw err
    }
  }

  const target = new URL(reqUrl, CONFIG.TARGET_URL)

  // Build upstream request headers
  const upstreamHeaders = { ...req.headers }
  for (const h of HOP_BY_HOP) delete upstreamHeaders[h]
  upstreamHeaders.host = target.host
  // Tell upstream it's a proxy pass
  upstreamHeaders['x-forwarded-for'] = req.socket.remoteAddress || ''

  // Read body for non-GET/HEAD
  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = Buffer.from([])
    for await (const chunk of req) body = Buffer.concat([body, chunk])
  }

  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders,
      body: body && body.length ? body : undefined,
      redirect: 'manual',
    })
  } catch (err) {
    log('error', 'Upstream fetch failed', { url: reqUrl, error: err.message })
    res.statusCode = 502
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ error: 'upstream unreachable', detail: err.message }))
  }

  const ct = upstream.headers.get('content-type') || ''
  const injectKind = shouldInject(reqUrl, ct)
  const responseMods = [...loader.serverMods.values()].filter((mod) => typeof mod.onResponse === 'function')

  // Copy upstream response headers
  const resHeaders = {}
  for (const [k, v] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue
    resHeaders[k] = v
  }

  let transformedBody
  if (responseMods.length > 0) {
    transformedBody = Buffer.from(await upstream.arrayBuffer())
    for (const mod of responseMods) {
      try {
        const nextBody = await mod.onResponse(req, res, upstream, transformedBody, { config: CONFIG, loader, log })
        if (res.writableEnded) return
        if (nextBody !== undefined && nextBody !== null) {
          transformedBody = Buffer.isBuffer(nextBody) ? nextBody : Buffer.from(nextBody)
        }
      } catch (err) {
        log('error', 'Server mod onResponse failed', { mod: mod.id, url: reqUrl, error: err.message })
        if (res.writableEnded) return
        if (res.headersSent) throw err
      }
    }
    delete resHeaders.etag
    delete resHeaders['last-modified']
    resHeaders['content-length'] = String(transformedBody.length)
  }

  // ─── Strategy A: inject into bundle ─────────────────────────────
  if (injectKind === 'bundle') {
    const original = transformedBody || Buffer.from(await upstream.arrayBuffer())
    const injected = injectBundle(original.toString('utf8'), loader)
    const buf = Buffer.from(injected, 'utf8')
    const etag = buildETag(buf)

    res.statusCode = upstream.status
    resHeaders['content-type'] = 'application/javascript; charset=utf-8'
    resHeaders['content-length'] = String(buf.length)
    resHeaders['cache-control'] = 'no-cache, must-revalidate'
    resHeaders['etag'] = etag
    resHeaders['x-oc-mod-count'] = String(loader.registry.size)

    for (const [k, v] of Object.entries(resHeaders)) res.setHeader(k, v)
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      return res.end()
    }

    log('info', 'Bundle injected', {
      url: reqUrl,
      mods: loader.registry.size,
      bytes: buf.length,
      ms: Date.now() - t0,
    })
    return res.end(buf)
  }

  // ─── Strategy B: inject into HTML ──────────────────────────────
  if (injectKind === 'html') {
    const original = transformedBody || Buffer.from(await upstream.arrayBuffer())
    const html = injectHTML(original.toString('utf8'), loader)
    const buf = Buffer.from(html, 'utf8')
    const etag = buildETag(buf)

    res.statusCode = upstream.status
    resHeaders['content-type'] = 'text/html; charset=utf-8'
    resHeaders['content-length'] = String(buf.length)
    resHeaders['cache-control'] = 'no-cache, must-revalidate'
    resHeaders['etag'] = etag
    resHeaders['x-oc-mod-count'] = String(loader.registry.size)

    for (const [k, v] of Object.entries(resHeaders)) res.setHeader(k, v)
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      return res.end()
    }

    log('info', 'HTML banner injected', {
      url: reqUrl,
      mods: loader.registry.size,
      ms: Date.now() - t0,
    })
    return res.end(buf)
  }

  // ─── Pass-through (no injection) ──────────────────────────────────
  res.statusCode = upstream.status
  for (const [k, v] of Object.entries(resHeaders)) res.setHeader(k, v)
  if (transformedBody) return res.end(transformedBody)
  if (upstream.body) {
    const reader = upstream.body.getReader()
    // Flush headers + disable Nagle so SSE/event-stream chunks reach the
    // client immediately instead of being held in Node's write buffer. Without
    // this, the client may time out waiting for the first chunk and retry
    // the request, which inflates the server-side conversation context.
    try {
      res.flushHeaders()
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true)
      }
    } catch {}
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const ok = res.write(Buffer.from(value))
      // If the internal buffer is full, wait for drain before continuing
      // (keeps back-pressure honest without losing chunks).
      if (!ok) await new Promise((r) => res.once('drain', r))
    }
  }
  res.end()
}

const server = http.createServer((req, res) => {
  handleProxy(req, res).catch((err) => {
    log('error', 'Unhandled proxy error', { url: req.url, error: err.message, stack: err.stack })
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'proxy error' }))
    } else {
      res.end()
    }
  })
})

server.listen(CONFIG.LISTEN_PORT, CONFIG.LISTEN_HOST, () => {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  OpenCode Mod Loader — reverse proxy + dynamic mod injection ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log('')
  console.log(`  Listening on : http://${CONFIG.LISTEN_HOST}:${CONFIG.LISTEN_PORT}`)
  console.log(`  Upstream:      ${CONFIG.TARGET_URL}`)
  console.log(`  Scripts dir:   ${CONFIG.SCRIPTS_DIR}`)
  console.log(`  Watch every:   ${CONFIG.WATCH_INTERVAL_MS} ms`)
  console.log(`  Mods loaded:   ${loader.registry.size}`)
  console.log(`  Log file:      ${CONFIG.LOG_TO_FILE}`)
  console.log('')
  console.log(`  Open your browser at http://${CONFIG.LISTEN_HOST}:${CONFIG.LISTEN_PORT}`)
  console.log('')
  console.log('  Internal endpoints:')
  console.log(`    /__oc_mods/manifest.json       list of loaded mods`)
  console.log(`    /__oc_mods/loader.js           standalone mod bundle`)
  console.log(`    /__oc_mods/<id>.js             individual mod source`)
  console.log('')
  console.log('  Add a new mod by dropping a .js file in scripts/ and reloading.')
  console.log('  Press Ctrl+C to stop.')
  console.log('')
  log('info', 'Proxy started', {
    port: CONFIG.LISTEN_PORT,
    upstream: CONFIG.TARGET_URL,
    mods: loader.registry.size,
  })
})
// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nShutting down...')
    stopWatch()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000).unref()
  })
}
