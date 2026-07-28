// test-init-fix.mjs — Simula el navegador con jsdom y verifica que init() se llama
import { ModLoader } from './internal/loader.mjs'
import { JSDOM } from 'jsdom'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Set up a temp scripts dir with our 3 real mods + a synthetic test mod
const tmpDir = path.join(__dirname, 'test-fixtures-init')
await fs.mkdir(tmpDir, { recursive: true })

// Copy our 3 real mods
const scriptsSrc = path.join(__dirname, 'scripts')
for (const file of (await fs.readdir(scriptsSrc))) {
  if (file.endsWith('.js')) {
    await fs.copyFile(path.join(scriptsSrc, file), path.join(tmpDir, file))
  }
}

const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body></body></html>`)
global.window = dom.window
global.document = dom.window.document
global.HTMLElement = dom.window.HTMLElement
global.EventTarget = dom.window.EventTarget
global.CustomEvent = dom.window.CustomEvent

const loader = new ModLoader({ scriptsDir: tmpDir })
await loader.scan()

const bundle = loader.buildInjectionBundle()

// Execute the bundle in the jsdom window context
const vm = await import('node:vm')
const ctx = vm.createContext(dom.window)
dom.window.eval(bundle)

// Wait a tick for async mods
await new Promise((r) => setTimeout(r, 200))

console.log('=== After bundle execution ===')
console.log('OC.mods:', Object.keys(ctx.OC.mods))
console.log('OC.__OC_MOD_LOADER_LOADED__:', ctx.__OC_MOD_LOADER_LOADED__)
console.log('OC.__OC_MOD_LOADER_RAN__:', ctx.__OC_MOD_LOADER_RAN__)
console.log()
for (const [id, mod] of Object.entries(ctx.OC.mods)) {
  console.log(`Mod ${id}:`, {
    hasInit: typeof mod.init === 'function',
    name: mod.name,
    version: mod.version,
  })
}

console.log()
console.log('=== UI elements in DOM ===')
const debugOverlay = dom.window.document.getElementById('oc-debug-overlay')
const customPathsBtn = dom.window.document.getElementById('oc-custom-paths-btn')
console.log('oc-debug-overlay exists:', !!debugOverlay)
console.log('oc-debug-overlay HTML (first 200 chars):', debugOverlay?.outerHTML?.slice(0, 200))
console.log('oc-custom-paths-btn exists:', !!customPathsBtn)
console.log('oc-custom-paths-btn HTML:', customPathsBtn?.outerHTML?.slice(0, 200))

// Test idempotency: run bundle again
console.log()
console.log('=== Re-running bundle (idempotency test) ===')
dom.window.eval(bundle)
await new Promise((r) => setTimeout(r, 100))
console.log('After 2nd run — OC.__OC_MOD_LOADER_RAN__:', ctx.__OC_MOD_LOADER_RAN__)
console.log('After 2nd run — debugOverlay still in DOM:', !!dom.window.document.getElementById('oc-debug-overlay'))
console.log('After 2nd run — customPathsBtn still in DOM:', !!dom.window.document.getElementById('oc-custom-paths-btn'))

// Cleanup
await fs.rm(tmpDir, { recursive: true, force: true })