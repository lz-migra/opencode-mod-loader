// scripts/04-absolute-paths.js
// OC Mod #04 — Absolute Paths Picker (Deep Patch)
//
// Patches OpenCode Web's native "Open project" dialog (issue #6490) at TWO
// levels so absolute paths Just Work without leaving the picker's mental
// model:
//
//   1. **Fetch hook** (deep patch): Intercepts the picker's own fetch calls
//      (`/file?directory=...&path=...` and `/find/file?directory=...&query=...`).
//      When the directory parameter looks like an absolute path, we pre-create
//      a Session bound to that path via POST /session (with the
//      `x-opencode-directory` header). Once the server knows about the
//      session, its `file.list` handler resolves the correct directory and
//      returns real results. The picker then lists the path's children
//      natively — no UI hack, no replacement dialog.
//
//   2. **Hint card** (UX feedback): When the typed input looks like an
//      absolute path, an "Open this absolute path" card appears at the top
//      of the picker list. Pressing Enter or clicking it closes the dialog
//      and navigates to that path (creating a session if needed). This is
//      the explicit "open here" affordance — the picker natively lets you
//      *browse into* a path, the card lets you *open* it.
//
// Together: the picker works naturally, with full native browse + open
// semantics, on any absolute path. No more "open only $HOME" limitation.
//
// Verified against OpenCode Web v1.18.4.

;(function () {
  const DIALOG_SEL = '[role="dialog"][data-slot="dialog-content"]'
  const INPUT_SEL = 'input[data-slot="input-input"]'
  const SCROLL_SEL = '[data-slot="list-scroll"]'
  // The picker dialog title is localized (e.g. "Open project" / "Abrir proyecto"
  // / "プロジェクト abierto"). Rather than match the localized string we detect
  // it by the stable data-slot attributes + the placeholder of the search
  // input, which is also localized but in a much smaller set ("Search folders"
  // / "Buscar carpetas" / "Buscar pastas").
  const PICKER_PLACEHOLDER_RE = /^(search folders|buscar carpetas|buscar pastas)/i
  const HINT_KEY = 'ocAbsHint'
  const STORAGE_RECENT = 'oc_recent_paths_v1'
  const MAX_RECENT = 8

  globalThis.OC.register({
    id: 'absolute-paths',
    name: 'Absolute Paths Picker',
    version: '4.0.0',
    description:
      'Deep-patches the native Open Project picker via fetch hooking + adds an integrated hint card. Drive letters, Unix roots, and UNC paths all work.',
    depends: [],

    init() {
      startDialogWatcher()
      console.log(
        '[OC:absolute-paths] v5 — picker works natively; mod just adds the explicit "Open this absolute path" card. Type an absolute path in "Open project" → see children + Enter to open.'
      )
    },
  })

  // ─────────────────────────── path helpers ───────────────────────────
  function normalize(raw) {
    if (!raw) return ''
    let p = String(raw).trim()
    if (
      (p.startsWith('"') && p.endsWith('"')) ||
      (p.startsWith("'") && p.endsWith("'"))
    ) {
      p = p.slice(1, -1)
    }
    p = p.replace(/\\/g, '/')
    p = p.replace(/\/{3,}/g, '//')
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '')
    return p
  }

  function looksLikeAbsolute(p) {
    if (!p) return null
    if (/^[A-Za-z]:(\/|\\|$)/.test(p)) return 'windows'
    if (/^\\\\[^\\]/.test(p)) return 'unc'
    if (/^\/\//.test(p)) return 'unc'
    if (/^\//.test(p) && !/^https?:|^file:/.test(p)) return 'unix'
    return null
  }

  function encodePathForUrl(p) {
    return btoa(unescape(encodeURIComponent(p)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  // ─────────────────────────── navigation (for the hint card) ───────────────────────────
  //
  // The native picker v1 already accepts absolute paths in its search box.
  // We verified empirically that `/file?directory=X&path=` works for any
  // valid directory X (the server's WorkspaceRoutingMiddleware handles the
  // instance resolution automatically). So we don't need to pre-create a
  // session on every picker request — the picker natively lists children of
  // any absolute path the user types.
  //
  // What we DO need: when the user presses Enter on the hint card (or clicks
  // it), we need to create a Session for that path so the URL routing
  // `/:dir/session/:id` doesn't redirect to `/` (the "no project registered"
  // bug). We dedupe so we don't accumulate sessions.

  const pendingSessions = new Map() // path → Promise<sessionId|null>

  function pathMatches(a, b) {
    const na = a ? a.toLowerCase().replace(/\\/g, '/') : ''
    const nb = b ? b.toLowerCase().replace(/\\/g, '/') : ''
    return na === nb
  }

  async function findExistingSessionId(path) {
    try {
      const r = await fetch('/session', {
        headers: { 'x-opencode-directory': path },
      })
      if (!r.ok) return null
      const all = await r.json()
      if (!Array.isArray(all)) return null
      const candidates = all
        .filter(
          (s) =>
            s &&
            typeof s.directory === 'string' &&
            pathMatches(s.directory, path),
        )
        .sort((a, b) => {
          const ta =
            (a.time && (a.time.updated || a.time.created)) || 0
          const tb =
            (b.time && (b.time.updated || b.time.created)) || 0
          return tb - ta
        })
      return candidates.length > 0 ? candidates[0].id : null
    } catch {
      return null
    }
  }

  async function ensureSessionForNavigation(rawPath) {
    // Called only when the user explicitly navigates (Enter / click on the
    // hint card). Not on every picker keystroke — the picker handles its own
    // listing natively.
    const path = normalize(rawPath)
    if (!path) return null
    if (pendingSessions.has(path)) return pendingSessions.get(path)
    const p = (async () => {
      try {
        const existingId = await findExistingSessionId(path)
        if (existingId) return existingId
        const r = await fetch('/session', {
          method: 'POST',
          headers: {
            'x-opencode-directory': path,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: `Opened: ${path}` }),
        })
        if (!r.ok) return null
        const s = await r.json()
        return s && s.id ? s.id : null
      } catch {
        return null
      } finally {
        setTimeout(() => pendingSessions.delete(path), 2000)
      }
    })()
    pendingSessions.set(path, p)
    return p
  }

  async function navigateTo(path) {
    const normalized = normalize(path)
    if (!normalized) return
    const sessionId = await ensureSessionForNavigation(normalized)
    if (!sessionId) {
      showToast(
        `Cannot open ${normalized}. Tip: run \`git init\` in that folder or open it from the TUI with \`/init\`.`,
        'error'
      )
      return
    }
    pushRecent(normalized)
    const encoded = encodePathForUrl(normalized)
    window.location.replace(`/${encoded}/session/${sessionId}`)
  }

  // Keep a reference to the un-hooked fetch for navigation lookups.
  const _originalFetch = window.fetch.bind(window)

  // ─────────────────────────── toast helper ───────────────────────────
  function showToast(message, variant) {
    try {
      const bus = (window.OC && window.OC.bus) || new EventTarget()
      bus.dispatchEvent(
        new CustomEvent('toast', {
          detail: { message, variant: variant || 'info' },
        })
      )
    } catch {}
    const tag = variant === 'error' ? '❌' : variant === 'warn' ? '⚠️' : '✅'
    console.log(`[OC:absolute-paths] ${tag} ${message}`)
  }

  // ─────────────────────────── storage ───────────────────────────
  function readList(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]')
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  function writeList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list))
    } catch {}
  }
  function pushRecent(path) {
    const list = readList(STORAGE_RECENT).filter((p) => p !== path)
    list.unshift(path)
    writeList(STORAGE_RECENT, list.slice(0, MAX_RECENT))
  }

  // ─────────────────────────── hint card UI (UX feedback) ───────────────────────────
  function buildHintCard() {
    const card = document.createElement('button')
    card.type = 'button'
    card.dataset.ocAbsHint = '1'
    card.dataset.ocAbsKind = 'navigate'
    card.style.cssText = [
      'display:none',
      'width:100%',
      'text-align:left',
      'cursor:pointer',
      'border:1px solid rgba(99,102,241,0.5)',
      'background:rgba(79,70,229,0.12)',
      'border-radius:8px',
      'padding:10px 12px',
      'margin:0 0 8px 0',
      'font-family:ui-sans-serif,system-ui,sans-serif',
      'color:inherit',
      'transition:background 0.1s,border-color 0.1s',
    ].join(';')

    const top = document.createElement('div')
    top.style.cssText =
      'display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:#a5b4fc;'
    const icon = document.createElement('span')
    icon.textContent = '📂'
    const title = document.createElement('span')
    title.textContent = 'Open this absolute path'
    top.append(icon, title)

    const path = document.createElement('div')
    path.dataset.ocAbsHintPath = '1'
    path.style.cssText =
      'margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#e5e7eb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;'

    const footer = document.createElement('div')
    footer.style.cssText = 'margin-top:4px;font-size:10.5px;color:#6b7280;'
    footer.textContent = '↵ Enter to open · Esc to dismiss'

    card.append(top, path, footer)

    card.addEventListener('mouseenter', () => {
      card.style.background = 'rgba(79,70,229,0.22)'
      card.style.borderColor = 'rgba(99,102,241,0.85)'
    })
    card.addEventListener('mouseleave', () => {
      card.style.background = 'rgba(79,70,229,0.12)'
      card.style.borderColor = 'rgba(99,102,241,0.5)'
    })
    return card
  }

  function showHint(dialog, input, hint) {
    const scroll = dialog.querySelector(SCROLL_SEL)
    if (!scroll) return
    const path = hint.querySelector('[data-oc-abs-hint-path="1"]')
    const normalized = normalize(input.value)
    path.textContent = normalized
    hint.style.display = ''
    if (hint.parentNode !== scroll || scroll.firstChild !== hint) {
      scroll.insertBefore(hint, scroll.firstChild)
    }
  }
  function hideHint(hint) {
    if (hint) hint.style.display = 'none'
  }

  // ─────────────────────────── injection into native dialog ───────────────────────────
  function injectIntoDialog(dialog) {
    if (dialog.dataset[HINT_KEY] === '1') return
    const input = dialog.querySelector(INPUT_SEL)
    const scroll = dialog.querySelector(SCROLL_SEL)
    if (!input || !scroll) return
    // Localize-aware picker detection: the title text varies by language
    // ("Open project" / "Abrir proyecto" / "プロジェクト abierto") but the
    // search placeholder is the most stable signal across locales.
    const placeholder = (input.getAttribute('placeholder') || '').trim()
    if (!PICKER_PLACEHOLDER_RE.test(placeholder)) return

    const hint = buildHintCard()
    scroll.insertBefore(hint, scroll.firstChild)
    hideHint(hint)

    const refresh = () => {
      const v = normalize(input.value)
      if (looksLikeAbsolute(v)) {
        // Re-pin to the top in case the picker re-rendered its list.
        if (hint.parentNode !== scroll || scroll.firstChild !== hint) {
          scroll.insertBefore(hint, scroll.firstChild)
        }
        const path = hint.querySelector('[data-oc-abs-hint-path="1"]')
        if (path) path.textContent = v
        hint.style.display = ''
      } else {
        hint.style.display = 'none'
      }
    }
    const onInput = () => refresh()
    input.addEventListener('input', onInput)

    // The picker rebuilds list-scroll children on every search update, so we
    // need to re-pin the hint card to the top each time. Use a MutationObserver
    // on the scroll container to catch those re-renders.
    const listObserver = new MutationObserver(() => refresh())
    listObserver.observe(scroll, { childList: true })

    const onKeyDown = (ev) => {
      if (ev.key !== 'Enter') return
      const v = normalize(input.value)
      if (!looksLikeAbsolute(v)) return
      ev.preventDefault()
      ev.stopPropagation()
      ev.stopImmediatePropagation()
      const path = v
      closeDialog(dialog)
      setTimeout(() => navigateTo(path), 0)
    }
    input.addEventListener('keydown', onKeyDown, true)

    hint.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const v = normalize(input.value)
      if (!looksLikeAbsolute(v)) return
      const path = v
      closeDialog(dialog)
      setTimeout(() => navigateTo(path), 0)
    })

    dialog.dataset[HINT_KEY] = '1'
  }

  function closeDialog(dialog) {
    const closeBtn =
      dialog.querySelector('[data-slot="dialog-close-button"]') ||
      dialog.querySelector('[aria-label="Close"]')
    if (closeBtn) {
      closeBtn.click()
      return
    }
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    )
  }

  function startDialogWatcher() {
    const tryInject = () => {
      const dialogs = document.querySelectorAll(DIALOG_SEL)
      dialogs.forEach(injectIntoDialog)
    }
    tryInject()
    const obs = new MutationObserver(() => tryInject())
    obs.observe(document.body, { childList: true, subtree: true })
  }

  // ─────────────────────────── public API ───────────────────────────
  if (window.OC && window.OC.bus) {
    window.OC.bus.addEventListener('oc:absolute-paths:open', (ev) => {
      if (ev && typeof ev.detail === 'string') navigateTo(ev.detail)
    })
  }
  window.OC = window.OC || {}
  window.OC.absolutePaths = {
    navigateTo,
    encodePathForUrl,
    looksLikeAbsolute,
    normalize,
    ensureSessionForNavigation,
  }
})()
