// scripts/05-mods-tab.js
// OC Mod #05 — Mods Container
//
// Adds a plain, always-visible container to OpenCode Web's settings popover
// (the one with the Servers / MCP / LSP / Plugins tabs). The container fetches
// the mod loader's own manifest endpoint (`/__oc_mods/manifest.json`) and lists
// every loaded mod with name, version, description, and content hash.
//
// Why a mod (not a hard patch): the settings popover is rendered by SolidJS.
// We render our container as a sibling DOM node and let the surrounding layout
// determine where it sits. It is deliberately not a tab trigger or tab panel:
// it is a normal scrollable container that remains visible without changing
// the state of the existing tab system.
//
// Verified against OpenCode Web v1.18.4. Targets the settings popover by
// detecting `data-component="tabs"` containers that already have a "plugins"
// tab — that's the exact shape of the opencode.json settings popover and avoids
// accidentally injecting into unrelated tab strips elsewhere.

;(function () {
  const TABS_SEL = '[data-component="tabs"]'
  const TABLIST_SEL = '[data-slot="tabs-list"]'
  const TRIGGER_SEL = '[data-slot="tabs-trigger"]'
  const INJECTED_KEY = 'ocModsTabInjected'

  globalThis.OC.register({
    id: 'mods-tab',
    name: 'Mods Container',
    version: '1.0.0',
    description:
      'Adds a scrollable container to the OpenCode settings popover, listing every mod loaded by the mod loader.',
    depends: [],

    init() {
      console.log('[OC:mods-tab] Active. Showing the loaded mods container in Settings.')
      startObserver()
    },
  })

  // ─────────────────────────── manifest fetch ───────────────────────────
  async function fetchManifest() {
    try {
      const r = await fetch('/__oc_mods/manifest.json', { cache: 'no-store' })
      if (!r.ok) return null
      return await r.json()
    } catch {
      return null
    }
  }

  // ─────────────────────────── UI building ───────────────────────────
  function buildEmptyState() {
    const empty = document.createElement('div')
    empty.style.cssText =
      'color:var(--text-weak,#9ca3af);font-size:12px;text-align:center;padding:24px 8px;'
    empty.textContent =
      "No mods loaded. Drop *.js files into the mod loader's scripts/ directory and reload the page."
    return empty
  }

  function buildModsList(mods) {
    const list = document.createElement('div')
    list.style.cssText =
      'display:flex;flex-direction:column;gap:6px;padding:8px 4px;'

    if (!mods || mods.length === 0) {
      list.appendChild(buildEmptyState())
      return list
    }

    for (const mod of mods) {
      const card = document.createElement('div')
      card.style.cssText =
        'display:flex;flex-direction:column;gap:3px;padding:8px 10px;background:var(--surface-raised-base,#1a1d23);border:1px solid rgba(255,255,255,0.06);border-radius:6px;'

      // Header row: green dot · name · id · version (right-aligned)
      const header = document.createElement('div')
      header.style.cssText =
        'display:flex;align-items:center;gap:8px;min-width:0;'

      const dot = document.createElement('span')
      dot.title = 'Loaded'
      dot.style.cssText =
        'flex-shrink:0;display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.5);'
      header.appendChild(dot)

      const name = document.createElement('strong')
      name.style.cssText =
        'font-size:12.5px;color:var(--text-strong,#f3f4f6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
      name.textContent = mod.name || mod.id
      name.title = mod.name || mod.id
      header.appendChild(name)

      const id = document.createElement('code')
      id.style.cssText =
        'font-size:10.5px;color:var(--text-weak,#9ca3af);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;'
      id.textContent = mod.id
      id.title = mod.id
      header.appendChild(id)

      const version = document.createElement('span')
      version.style.cssText =
        'flex-shrink:0;font-size:10.5px;color:var(--text-weak,#6b7280);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
      version.textContent = 'v' + (mod.version || '0.0.0')
      header.appendChild(version)

      card.appendChild(header)

      // Description
      if (mod.description) {
        const desc = document.createElement('div')
        desc.style.cssText =
          'font-size:11px;color:var(--text-base,#d1d5db);line-height:1.4;'
        desc.textContent = mod.description
        card.appendChild(desc)
      }

      // Hash + depends footer
      const meta = document.createElement('div')
      meta.style.cssText =
        'font-size:9.5px;color:#4b5563;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;gap:12px;margin-top:1px;flex-wrap:wrap;'
      if (mod.hash) {
        const h = document.createElement('span')
        h.textContent = 'hash: ' + mod.hash
        meta.appendChild(h)
      }
      if (mod.depends && mod.depends.length > 0) {
        const d = document.createElement('span')
        d.textContent = 'depends: ' + mod.depends.join(', ')
        meta.appendChild(d)
      }
      if (mod.filename) {
        const f = document.createElement('span')
        f.textContent = mod.filename
        meta.appendChild(f)
      }
      if (meta.children.length > 0) card.appendChild(meta)

      list.appendChild(card)
    }

    return list
  }

  function buildContentShell() {
    const shell = document.createElement('div')
    shell.style.cssText =
      'padding:8px 12px 12px;display:flex;flex-direction:column;gap:6px;'
    // Header note
    const head = document.createElement('div')
    head.style.cssText =
      'font-size:10.5px;color:var(--text-weak,#6b7280);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;'
    head.textContent = 'Mods loaded by opencode-mod-loader'
    shell.appendChild(head)
    // The actual list (placeholder; filled async below)
    const list = document.createElement('div')
    list.setAttribute('data-oc-mods-list', '1')
    shell.appendChild(list)
    return shell
  }

  // ─────────────────────────── injection ───────────────────────────
  function injectIntoTabs(tabs) {
    if (!tabs || tabs.dataset[INJECTED_KEY] === '1') return false

    // Only inject into the opencode.json settings popover (the one with the
    // "plugins" tab). Skip unrelated tab strips.
    const tablist = tabs.querySelector(TABLIST_SEL)
    if (!tablist) return false
    const existingTriggers = tablist.querySelectorAll(TRIGGER_SEL)
    const values = Array.from(existingTriggers).map((b) =>
      b.getAttribute('data-value')
    )
    if (!values.includes('plugins')) return false

    // The tab strip has a unique id like "tabs-cl-860". Reuse it only to give
    // the common container a stable, local identifier; it is not a tab panel.
    const baseId = tabs.id
    if (!baseId) return false

    // This is intentionally a normal div. Do not add role="tabpanel", tab
    // attributes, or data-slot="tabs-content": the container is independent
    // from the surrounding tab controller and stays visible at all times.
    const content = document.createElement('div')
    content.id = baseId + '-mods-container'
    content.setAttribute('data-oc-mods-container', '1')
    content.style.cssText =
      'box-sizing:border-box;display:flex;flex:1 1 0%;flex-direction:column;min-width:0;min-height:0;width:100%;height:100%;max-height:100%;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;'
    const shell = buildContentShell()
    content.appendChild(shell)
    tabs.appendChild(content)

    // Populate async. Refresh the list if the user re-opens the popover
    // and the manifest has changed (cheap because the endpoint is a local
    // in-memory lookup in the mod loader).
    populateAsync(content)

    tabs.dataset[INJECTED_KEY] = '1'
    return true
  }

  async function populateAsync(content) {
    const list = content.querySelector('[data-oc-mods-list="1"]')
    if (!list) return
    const manifest = await fetchManifest()
    const mods = (manifest && Array.isArray(manifest.mods)) ? manifest.mods : []
    list.innerHTML = ''
    list.appendChild(buildModsList(mods))
  }

  // ─────────────────────────── observer ───────────────────────────
  function startObserver() {
    const tryInject = () => {
      const tabsList = document.querySelectorAll(TABS_SEL)
      for (const t of tabsList) {
        injectIntoTabs(t)
      }
    }
    tryInject()
    const obs = new MutationObserver(() => tryInject())
    obs.observe(document.body, { childList: true, subtree: true })
  }

  // ─────────────────────────── public API ───────────────────────────
  window.OC = window.OC || {}
  window.OC.modsTab = { injectIntoTabs, fetchManifest }
})()
