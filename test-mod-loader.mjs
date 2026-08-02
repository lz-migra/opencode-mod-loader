// test-mod-loader.mjs — End-to-end smoke test for the mod loader.
//
// Runs:
//   1. mock OpenCode server on :4096
//   2. mod loader proxy on :18731
//   3. HTTP requests through the proxy
//   4. assertions on responses

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cwd = __dirname

function startMock() {
  const p = spawn('node', ['test-mock-opencode.mjs'], { cwd, stdio: 'pipe' })
  p.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`))
  p.stderr.on('data', (d) => process.stderr.write(`[mock!] ${d}`))
  return p
}

function startProxy() {
  const p = spawn('node', ['server.mjs'], { cwd, stdio: 'pipe', env: { ...process.env, OC_PROXY_PORT: '18731', OC_VERBOSE: '1' } })
  p.stdout.on('data', (d) => process.stdout.write(`[proxy] ${d}`))
  p.stderr.on('data', (d) => process.stderr.write(`[proxy!] ${d}`))
  return p
}

let passed = 0
let failed = 0

function assert(cond, name) {
  if (cond) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.log(`  ✗ ${name}`)
    failed++
  }
}

async function fetchText(url) {
  const r = await fetch(url)
  return { status: r.status, headers: r.headers, body: await r.text() }
}

async function fetchJson(url) {
  const r = await fetch(url)
  return { status: r.status, headers: r.headers, body: await r.json() }
}

;(async () => {
  console.log('Starting mock OpenCode server on :4096…')
  const mock = startMock()
  await sleep(500)

  console.log('Starting mod loader proxy on :18731…')
  const proxy = startProxy()
  await sleep(1500)

  try {
    console.log('\n── Test 1: HTML injection ──')
    {
      const r = await fetchText('http://127.0.0.1:18731/')
      assert(r.status === 200, 'HTML status 200')
      assert(r.body.includes('OC MOD LOADER active'), 'HTML has mod banner')
      assert(r.body.includes('oc-mod-loader') && r.body.includes('<script'), 'HTML has loader script tag')
      assert(r.headers.get('cache-control')?.includes('no-cache'), 'HTML has cache-control: no-cache')
      assert(r.headers.get('etag'), 'HTML has ETag header')
      console.log(`  → mod count in banner: ${(r.body.match(/mod\(s\):/) || [''])[0] || 'N/A'}`)
    }

    console.log('\n── Test 2: Bundle JS injection ──')
    {
      const r = await fetchText('http://127.0.0.1:18731/assets/index-abc123.js')
      assert(r.status === 200, 'Bundle status 200')
      assert(r.headers.get('content-type')?.includes('javascript'), 'Content-Type is JS')
      assert(r.body.includes('OC MOD LOADER injection'), 'Bundle has injection banner')
      assert(r.body.includes('OC.register'), 'Bundle has register function')
      assert(r.body.includes('classic-layout'), 'Bundle includes classic-layout mod')
      assert(r.body.includes('console.log("[mock]'), 'Bundle still contains original mock content')
      assert(r.headers.get('x-oc-mod-count'), 'X-OC-Mod-Count header present')
      const modCount = r.headers.get('x-oc-mod-count')
      console.log(`  → ${modCount} mod(s) loaded, bundle size: ${r.body.length} bytes`)
    }

    console.log('\n── Test 3: ETag cache revalidation ──')
    {
      const r1 = await fetchText('http://127.0.0.1:18731/assets/index-abc123.js')
      const etag = r1.headers.get('etag')
      assert(etag, 'ETag present on first request')

      const r2 = await fetch('http://127.0.0.1:18731/assets/index-abc123.js', {
        headers: { 'if-none-match': etag },
      })
      assert(r2.status === 304, 'Second request returns 304 when If-None-Match matches')
    }

    console.log('\n── Test 4: Manifest endpoint ──')
    {
      const r = await fetchJson('http://127.0.0.1:18731/__oc_mods/manifest.json')
      assert(r.status === 200, 'Manifest status 200')
      assert(Array.isArray(r.body.mods), 'Manifest has mods array')
      assert(r.body.mods.length === 4, 'Manifest has 4 mods')
      assert(r.body.mods.some((m) => m.id === 'classic-layout'), 'Manifest includes classic-layout')
      console.log(`  → mods: ${r.body.mods.map((m) => m.id).join(', ')}`)
    }

    console.log('\n── Test 5: Standalone mod loader endpoint ──')
    {
      const r = await fetchText('http://127.0.0.1:18731/__oc_mods/loader.js')
      assert(r.status === 200, 'Loader endpoint status 200')
      assert(r.body.includes('OC_MOD_LOADER'), 'Loader.js contains loader marker')
    }

    console.log('\n── Test 6: Individual mod endpoint ──')
    {
      const r = await fetchText('http://127.0.0.1:18731/__oc_mods/classic-layout.js')
      assert(r.status === 200, 'Mod endpoint status 200')
      assert(r.body.includes('globalThis.OC.register'), 'Mod source preserved')
      assert(r.headers.get('etag'), 'Mod has ETag')
    }

    console.log('\n── Test 7: Pass-through to upstream ──')
    {
      const r = await fetchText('http://127.0.0.1:18731/global/health')
      assert(r.status === 200, 'Health endpoint reachable via proxy')
      assert(r.body.includes('"version"'), 'Health response is JSON with version')
    }

    console.log('\n── Test 8: Pass-through preserves API endpoints ──')
    {
      const r = await fetchJson('http://127.0.0.1:18731/file/list?path=')
      assert(r.status === 200, 'API endpoint reachable')
      assert(Array.isArray(r.body), 'API returns array')
      assert(r.body.length > 0, 'API returns data')
    }

    console.log('\n── Test 9: Disabled mod (leading underscore) is NOT loaded ──')
    {
      // Add a disabled mod
      const fs = await import('node:fs/promises')
      await fs.writeFile(path.join(cwd, 'scripts', '_disabled.js'), 'globalThis.OC.register({ id: "should-not-load", init() {} })')
      await sleep(800) // Wait for watcher to pick up
      const r = await fetchJson('http://127.0.0.1:18731/__oc_mods/manifest.json')
      const ids = r.body.mods.map((m) => m.id)
      assert(!ids.includes('should-not-load'), 'Disabled mod is NOT in manifest')
      await fs.unlink(path.join(cwd, 'scripts', '_disabled.js'))
    }

    console.log('\n── Test 10: Hot reload — add/remove mod ──')
    {
      const fs = await import('node:fs/promises')
      const tmpFile = path.join(cwd, 'scripts', '99-hotreload-test.js')
      await fs.writeFile(tmpFile, 'globalThis.OC.register({ id: "hotreload-test", name: "Hot Reload Test", version: "0.1.0", init() { console.log("hot") } })')
      // Force an immediate rescan via the refresh endpoint (avoids racing the 500ms polling tick)
      await fetch('http://127.0.0.1:18731/__oc_mods/refresh')
      const r1 = await fetchJson('http://127.0.0.1:18731/__oc_mods/manifest.json')
      assert(r1.body.mods.some((m) => m.id === 'hotreload-test'), 'New mod appears after add')
      await fs.unlink(tmpFile)
      await fetch('http://127.0.0.1:18731/__oc_mods/refresh')
      const r2 = await fetchJson('http://127.0.0.1:18731/__oc_mods/manifest.json')
      assert(!r2.body.mods.some((m) => m.id === 'hotreload-test'), 'Mod disappears after delete')
    }

    console.log('\n── Test 11: Server-side request/response hooks ──')
    {
      const fs = await import('node:fs/promises')
      const tmpFile = path.join(cwd, 'scripts', '99-server-hooks-test.server.mjs')
      await fs.writeFile(tmpFile, `export default {
  id: 'server-hooks-test',
  version: '0.1.0',
  onRequest(req, res) {
    if (req.url !== '/api/server-local') return false
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ local: true }))
    return true
  },
  onResponse(req, res, upstream, body) {
    if (req.url !== '/api/server-mod-test') return body
    const data = JSON.parse(body.toString('utf8'))
    data.modified = true
    return Buffer.from(JSON.stringify(data))
  },
}`)
      await fetch('http://127.0.0.1:18731/__oc_mods/refresh')
      const manifest = await fetchJson('http://127.0.0.1:18731/__oc_mods/manifest.json')
      assert(manifest.body.serverMods.some((m) => m.id === 'server-hooks-test'), 'Manifest includes server mod')
      assert(!manifest.body.mods.some((m) => m.id === 'server-hooks-test'), 'Server mod is not injected as client code')
      const local = await fetchJson('http://127.0.0.1:18731/api/server-local')
      assert(local.status === 200 && local.body.local === true, 'onRequest can handle a local endpoint')
      const modified = await fetchJson('http://127.0.0.1:18731/api/server-mod-test')
      assert(modified.body.upstream === true && modified.body.modified === true, 'onResponse can modify an upstream response')
      await fs.unlink(tmpFile)
      await fetch('http://127.0.0.1:18731/__oc_mods/refresh')
      const afterDelete = await fetchJson('http://127.0.0.1:18731/__oc_mods/manifest.json')
      assert(!afterDelete.body.serverMods.some((m) => m.id === 'server-hooks-test'), 'Server mod disappears after delete')
    }

  } finally {
    proxy.kill('SIGTERM')
    mock.kill('SIGTERM')
    await sleep(500)
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`${'─'.repeat(50)}`)
  process.exit(failed > 0 ? 1 : 0)
})().catch((err) => {
  console.error('Test runner crashed:', err)
  process.exit(1)
})
