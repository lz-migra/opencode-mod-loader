// debug-test.mjs — Debug script to see actual response from proxy
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const mock = spawn('node', ['test-mock-opencode.mjs'], { cwd: __dirname, stdio: 'pipe' })
mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`))

await sleep(500)

const proxy = spawn('node', ['server.mjs'], { cwd: __dirname, stdio: 'pipe', env: { ...process.env, OC_VERBOSE: '1' } })
proxy.stdout.on('data', (d) => process.stdout.write(`[proxy] ${d}`))

await sleep(1500)

console.log('\n=== Direct upstream request ===')
const upstream = await fetch('http://127.0.0.1:4096/assets/index-abc123.js')
console.log('status:', upstream.status)
console.log('content-type:', upstream.headers.get('content-type'))
console.log('body:', (await upstream.text()).slice(0, 200))

console.log('\n=== Proxy request ===')
const proxied = await fetch('http://127.0.0.1:8080/assets/index-abc123.js')
console.log('status:', proxied.status)
console.log('content-type:', proxied.headers.get('content-type'))
console.log('x-oc-mod-count:', proxied.headers.get('x-oc-mod-count'))
console.log('etag:', proxied.headers.get('etag'))
console.log('cache-control:', proxied.headers.get('cache-control'))
console.log('body:', (await proxied.text()).slice(0, 500))

mock.kill()
proxy.kill()
process.exit(0)
