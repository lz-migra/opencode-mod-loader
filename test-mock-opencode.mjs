// test-mock-opencode.mjs — Mock server that mimics OpenCode Web v1.18.4
// Used for end-to-end testing of the mod loader without needing the real
// opencode binary. Listens on :4096 by default.

import http from 'node:http'
import crypto from 'node:crypto'

const PORT = 4096
const csp = (hash = '') =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`

function cspForHtml(body) {
  const m = body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
  return csp(m ? crypto.createHash('sha256').update(m[2]).digest('base64') : '')
}

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenCode (mock)</title>
    <script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
    <script src="/assets/index-abc123.js" type="module"></script>
  </body>
</html>
`

const JS_BUNDLE = `
console.log("[mock] SolidJS bundle starting");
window.fetch("/file/list?path=").then(r => r.json()).then(d => console.log("dir listing:", d));
window.addEventListener("DOMContentLoaded", () => console.log("[mock] DOM ready"));
`

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  console.log(`[mock] ${req.method} ${req.url}`)

  if (u === '/' || u === '/index.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('content-security-policy', cspForHtml(HTML))
    return res.end(HTML)
  }
  if (u === '/oc-theme-preload.js') {
    res.setHeader('content-type', 'application/javascript')
    return res.end('// theme preload (mock)')
  }
  if (u.startsWith('/assets/index-') && u.endsWith('.js')) {
    res.setHeader('content-type', 'application/javascript; charset=utf-8')
    return res.end(JS_BUNDLE)
  }
  if (u === '/global/health') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ healthy: true, version: '1.18.4-mock' }))
  }
  if (u === '/api/server-mod-test') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ upstream: true }))
  }
  if (u.startsWith('/file/list') || u.startsWith('/find/files')) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify([
      { name: 'folder-a', type: 'directory', absolute: '/mock/folder-a' },
      { name: 'folder-b', type: 'directory', absolute: '/mock/folder-b' },
      { name: 'file.txt', type: 'file', absolute: '/mock/file.txt' },
    ]))
  }
  res.statusCode = 404
  res.end('not found')
})

server.listen(PORT, () => {
  console.log(`[mock] OpenCode-like server on http://127.0.0.1:${PORT}`)
})
