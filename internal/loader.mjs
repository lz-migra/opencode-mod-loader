// internal/loader.mjs
// Mod discovery + caching. Watches /scripts for changes, builds a registry
// of {id, source, mtime, hash} that the proxy uses at request time.
//
// Design goals:
// 1. NEVER execute the mod on the server (mods are browser-only).
// 2. Hot reload: add/edit/remove a file in /scripts and reload the page.
// 3. Collision detection: if two mods export the same `id`, surface a warning.
// 4. Atomic reads: snapshot of all mods is consistent at a single timestamp.
//
// File format: each .js file in /scripts must be an IIFE that calls
//   `globalThis.OC_MOD_REGISTRY.register({ id, name, version?, description?, init })`
// or simply defines a `globalThis.OC_MOD = { id, name, init }` object.
// We don't *call* the IIFE on the server — we just extract metadata + source.
// The browser calls the IIFE in the injected context (window scope, after fetch patch).

import { promises as fs } from 'node:fs'
import * as fssync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

export class ModLoader {
  /**
   * @param {object} opts
   * @param {string} opts.scriptsDir - absolute path to /scripts
   * @param {Function} [opts.log] - (level, msg, meta) => void
   */
  constructor({ scriptsDir, log = () => {} }) {
    this.scriptsDir = scriptsDir
    this.log = log
    /** @type {Map<string, {id: string, filename: string, source: string, mtime: number, hash: string, meta: any}>} */
    this.registry = new Map()
    /** @type {Map<string, {id: string, filename: string, version: string | null, hash: string, mtime: number, onRequest?: Function, onResponse?: Function}>} */
    this.serverMods = new Map()
    this.loadedAt = 0
  }

  async scan() {
    let entries
    try {
      entries = await fs.readdir(this.scriptsDir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') {
        await fs.mkdir(this.scriptsDir, { recursive: true })
        entries = []
      } else throw err
    }

    const seen = new Set()
    const seenServer = new Set()
    const nextServerMods = new Map()
    for (const e of entries) {
      if (!e.isFile()) continue
      if (!e.name.endsWith('.js') && !e.name.endsWith('.mjs')) continue
      if (e.name.startsWith('_')) continue          // _foo.js = disabled/private
      if (e.name.endsWith('.disabled')) continue   // explicit kill switch
      const full = path.join(this.scriptsDir, e.name)
      if (/\.server\.(?:m?js)$/.test(e.name)) {
        seenServer.add(e.name)
        try {
          const loaded = await this.loadServerMod(full, e.name)
          if (loaded) nextServerMods.set(loaded.id, loaded)
        } catch (err) {
          this.log('error', `Failed to load server mod ${e.name}`, { error: err.message })
        }
        continue
      }
      if (!e.name.endsWith('.js')) continue
      seen.add(e.name)
      try {
        await this.loadOne(full, e.name)
      } catch (err) {
        this.log('error', `Failed to load mod ${e.name}`, { error: err.message })
      }
    }
    // Remove mods whose file was deleted
    for (const [filename] of this.registry) {
      if (!seen.has(filename)) {
        this.registry.delete(filename)
        this.log('info', `Mod removed: ${filename}`)
      }
    }
    for (const [id, mod] of this.serverMods) {
      if (!seenServer.has(mod.filename)) this.log('info', `Server mod removed: ${mod.filename} → id="${id}"`)
    }
    this.serverMods = nextServerMods
    this.loadedAt = Date.now()
    return this.summary()
  }

  async loadOne(full, filename) {
    const source = await fs.readFile(full, 'utf8')
    const stat = await fs.stat(full)
    const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)

    // Validate: must be syntactically valid JS
    // We do a cheap parse via new Function (won't execute, just parse).
    try {
      new Function(source)
    } catch (err) {
      throw new Error(`syntax error: ${err.message}`)
    }

    // Extract metadata via static analysis (best effort, no execution).
    const meta = this.extractMeta(source, filename)
    const id = meta.id || filename.replace(/\.js$/, '')

    this.registry.set(filename, {
      id,
      filename,
      source,
      mtime: stat.mtimeMs,
      hash,
      meta,
    })
    this.log('info', `Mod loaded: ${filename} → id="${id}" v${meta.version || '0.0.0'}`)
  }

  async loadServerMod(full, filename) {
    const source = await fs.readFile(full, 'utf8')
    const stat = await fs.stat(full)
    const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)
    const fileUrl = pathToFileURL(full)
    fileUrl.searchParams.set('v', hash)
    const namespace = await import(fileUrl.href)
    const candidate = namespace.default || namespace
    if (!candidate || typeof candidate !== 'object' || !candidate.id || typeof candidate.id !== 'string') {
      throw new Error('server mod must export an object with a non-empty string id')
    }
    if (typeof candidate.onRequest !== 'function' && typeof candidate.onResponse !== 'function') {
      throw new Error('server mod must define onRequest or onResponse')
    }
    const mod = {
      ...candidate,
      id: candidate.id,
      filename,
      version: typeof candidate.version === 'string' ? candidate.version : null,
      hash,
      mtime: stat.mtimeMs,
    }
    this.log('info', `Server mod loaded: ${filename} → id="${mod.id}" v${mod.version || '0.0.0'}`)
    return mod
  }

  /**
   * Lightweight metadata extraction.
   * Looks for an IIFE that calls register({...}) with id/name/version,
   * or a top-level OC_MOD = {...} assignment.
   * Falls back to filename-based id.
   */
  extractMeta(source, filename) {
    const meta = { id: null, name: null, version: null, description: null, depends: [] }

    // Pattern: register({ id: 'foo', name: 'Foo', version: '1.0.0', ... })
    const registerMatch = source.match(
      /register\s*\(\s*\{\s*([\s\S]*?)\}\s*\)/
    )
    if (registerMatch) {
      const obj = registerMatch[1]
      const idM = obj.match(/id\s*:\s*['"`]([^'"`]+)['"`]/)
      const nameM = obj.match(/name\s*:\s*['"`]([^'"`]+)['"`]/)
      const verM = obj.match(/version\s*:\s*['"`]([^'"`]+)['`]/)
      const descM = obj.match(/description\s*:\s*['"`]([^'"`]+)['"`]/)
      const depsM = obj.match(/depends\s*:\s*\[([^\]]*)\]/)
      if (idM) meta.id = idM[1]
      if (nameM) meta.name = nameM[1]
      if (verM) meta.version = verM[1]
      if (descM) meta.description = descM[1]
      if (depsM) {
        meta.depends = [...depsM[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
      }
    }

    // Pattern: globalThis.OC_MOD = { id, name, ... }
    if (!meta.id) {
      const objMatch = source.match(
        /OC_MOD\s*=\s*\{\s*([\s\S]*?)\n\s*\}/
      )
      if (objMatch) {
        const obj = objMatch[1]
        const idM = obj.match(/id\s*:\s*['"`]([^'"`]+)['"`]/)
        const nameM = obj.match(/name\s*:\s*['"`]([^'"`]+)['"`]/)
        const verM = obj.match(/version\s*:\s*['"`]([^'"`]+)['`]/)
        if (idM) meta.id = idM[1]
        if (nameM) meta.name = nameM[1]
        if (verM) meta.version = verM[1]
      }
    }

    return meta
  }

  summary() {
    const mods = [...this.registry.values()].map((m) => ({
      id: m.id,
      filename: m.filename,
      version: m.meta.version,
      name: m.meta.name,
      description: m.meta.description,
      depends: m.meta.depends,
      hash: m.hash,
      mtime: m.mtime,
    }))
    // Detect collisions
    const ids = new Map()
    for (const m of mods) {
      if (!ids.has(m.id)) ids.set(m.id, [])
      ids.get(m.id).push(m.filename)
    }
    const collisions = []
    for (const [id, files] of ids) {
      if (files.length > 1) collisions.push({ id, files })
    }
    const serverMods = [...this.serverMods.values()].map((m) => ({
      id: m.id,
      filename: m.filename,
      version: m.version,
      hooks: ['onRequest', 'onResponse'].filter((hook) => typeof m[hook] === 'function'),
      hash: m.hash,
      mtime: m.mtime,
    }))
    return { mods, serverMods, collisions, loadedAt: this.loadedAt }
  }

  /**
   * Returns the concatenated source of all mods, ordered by id, with each
   * mod wrapped in an IIFE that runs in window scope. The bundle is wrapped
   * in a single global try/catch so a single broken mod doesn't kill the app.
   *
   * @returns {string} the mod bundle to inject into /assets/*.js
   */
  buildInjectionBundle() {
    const sorted = [...this.registry.values()].sort((a, b) => a.id.localeCompare(b.id))
    if (sorted.length === 0) return ''

    // Build a fingerprint comment so the user can verify which mods loaded.
    const summary = sorted
      .map((m) => `  • ${m.id}@${m.meta.version || '0'}  [${m.hash}]`)
      .join('\n')

    const header = `/* ============================================================
   OC MOD LOADER · injected by opencode-mod-loader
   ${sorted.length} mod(s) loaded:
${summary}
   ============================================================ */
(function OC_MOD_LOADER(){
  if (window.__OC_MOD_LOADER_LOADED__) return;
  window.__OC_MOD_LOADER_LOADED__ = true;
  // Marker that this OUTER IIFE actually ran (helpful for debugging
  // if a second copy of the bundle somehow slips past the dedup).
  window.__OC_MOD_LOADER_RAN__ = (window.__OC_MOD_LOADER_RAN__ || 0) + 1;

  // Tiny registry so mods can find each other
  window.OC = window.OC || {};
  window.OC.mods = window.OC.mods || {};
  window.OC.bus  = window.OC.bus  || new EventTarget();
  window.OC.register = function (mod) {
    if (!mod || !mod.id) return console.warn('[OC] mod missing id');
    // Idempotent: only log the FIRST registration per id.
    const alreadyRegistered = !!window.OC.mods[mod.id];
    window.OC.mods[mod.id] = mod;
    if (!alreadyRegistered) {
      window.OC.bus.dispatchEvent(new CustomEvent('mod:registered', { detail: mod }));
      console.log('[OC] mod registered:', mod.id, mod.version || '');
    } else {
      console.debug('[OC] mod re-registered (no-op):', mod.id);
    }
  };

  // Each mod is wrapped in try/catch so a single broken mod
  // doesn't kill the rest of the bundle.
  const mods = [
`

    const body = sorted
      .map(
        (m, i) => `    {
      id: ${JSON.stringify(m.id)},
      version: ${JSON.stringify(m.meta.version || '0.0.0')},
      src: function(){
        try {
${m.source
  .split('\n')
  .map((line) => '          ' + line)
  .join('\n')}
        } catch (err) {
          console.error('[OC] mod failed:', ${JSON.stringify(m.id)}, err);
        }
      }
    }${i < sorted.length - 1 ? ',' : ''}`
      )
      .join('\n')

    const footer = `
  ];

  // Execute mods after DOMContentLoaded so the app's <div id="root"> exists
  // and our injection into fetch happens before the app's first request.
  function bootMods() {
    for (const m of mods) {
      try {
        if (document.readyState === 'loading') {
          // wait one tick
          setTimeout(() => m.src(), 0);
        } else {
          m.src();
        }
      } catch (err) {
        console.error('[OC] mod crashed:', m.id, err);
      }
    }
    // After registering, call init() on each mod. Mods that declared an
    // init() will run it now (after DOMContentLoaded if applicable).
    // init() may return a Promise; we swallow errors per mod.
    for (const m of mods) {
      const registered = window.OC.mods[m.id];
      if (registered && typeof registered.init === 'function') {
        try {
          const result = registered.init();
          if (result && typeof result.catch === 'function') {
            result.catch((err) =>
              console.error('[OC] mod init failed:', m.id, err),
            );
          }
        } catch (err) {
          console.error('[OC] mod init threw:', m.id, err);
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootMods);
  } else {
    bootMods();
  }

  console.log('[OC] loader ready, %d mod(s)', mods.length);
})();
`
    return header + body + footer
  }

  /**
   * Build the metadata banner to embed in HTML (visible in DevTools).
   * @returns {string}
   */
  buildHtmlBanner() {
    if (this.registry.size === 0) return ''
    const sorted = [...this.registry.values()].sort((a, b) => a.id.localeCompare(b.id))
    const lines = sorted
      .map((m) => `${m.id}@${m.meta.version || '0.0.0'}`)
      .join(' · ')
    return `\n<!-- OC MOD LOADER active: ${sorted.length} mod(s): ${lines} -->\n`
  }

  /**
   * Serve a single mod as a standalone JS file (used for /__oc_mods/<id>.js).
   * @param {string} id
   * @returns {{source: string, hash: string, mtime: number} | null}
   */
  getMod(id) {
    for (const m of this.registry.values()) {
      if (m.id === id) return { source: m.source, hash: m.hash, mtime: m.mtime }
    }
    return null
  }

  /**
   * Watch the scripts directory for changes (uses polling for cross-platform
   * reliability — fs.watch is unreliable on Windows + WSL).
   */
  watch({ intervalMs = 500, onChange = () => {} } = {}) {
    let lastSnapshot = ''
    const tick = async () => {
      try {
        const entries = await fs.readdir(this.scriptsDir, { withFileTypes: true }).catch(() => [])
        const relevant = entries
          .filter((e) => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs')) && !e.name.startsWith('_') && !e.name.endsWith('.disabled'))
          .map((e) => e.name)
          .sort()
          .join('|')
        if (relevant !== lastSnapshot) {
          lastSnapshot = relevant
          const summary = await this.scan()
          onChange(summary)
        }
      } catch (err) {
        this.log('error', 'watch tick failed', { error: err.message })
      }
    }
    const handle = setInterval(tick, intervalMs)
    return () => clearInterval(handle)
  }
}
