# AGENTS.md — OpenCode Mod Loader

## What this repo is

A Node.js reverse proxy (`server.mjs`) that intercepts OpenCode Web's HTML and
JS bundle responses and **prepends user-written IIFE mods** before the SolidJS
app boots. The proxy sits in front of a normal `opencode web` server:

```
Browser → :8080 (proxy, server.mjs) → :4096 (upstream OpenCode server)
                                ↓
                          scripts/*.js (auto-scanned, hot-reloaded)
```

Locked to OpenCode Web **v1.18.4**. The injection points are `index.html`
(`/`, `/index.html`) and the Vite bundle `/assets/index-*.js`. Different
upstream versions will likely break the proxy silently.

## Entry points

| File | Role |
|---|---|
| `server.mjs` | HTTP server, ETag/cache-control, upstream forwarding, route dispatch for `/__oc_mods/*`. |
| `internal/loader.mjs` | `ModLoader` class: scans `scripts/`, parses metadata, polls for changes, builds the injected bundle. |
| `internal/injector.mjs` | `shouldInject` / `injectHTML` / `injectBundle` — pure transforms on response bodies. |
| `launcher.mjs` | TUI dashboard (Bun + OpenTUI) that spawns the upstream + proxy, streams logs, and exposes `[r]`/`[q]` controls. |
| `scripts/*.js` | Mods. Each must be an IIFE that calls `globalThis.OC.register({ id, name, version, init })`. See `scripts/README.md`. |

## Commands

```powershell
# 1. Run the launcher (Bun is required because OpenTUI uses bun:ffi).
bun launcher.mjs               # or: npm run launcher

# 2. OR run the proxy directly (no TUI, Node is fine for the proxy itself)
cd C:\Users\LordLoro05\opencode-mod-loader
node server.mjs                # or: npm start
node --watch server.mjs        # or: npm run dev  (Node 18+ only)

# 3. Browse the proxy, NOT the upstream
#    http://localhost:8080          (proxy)
#    http://localhost:4096          (upstream — will skip all mods)
```

There is **no test runner** in `package.json`. Run tests directly:

```powershell
node test-mod-loader.mjs       # E2E: spawns mock + proxy, asserts HTML/JS/ETag/manifest
node test-init-fix.mjs         # jsdom: verifies mods register and init() runs
node debug-test.mjs            # ad-hoc: prints raw upstream vs proxied bundle
```

`test-mock-opencode.mjs` is a fixture, not a test — it listens on :4096 to mimic
upstream OpenCode Web (HTML, bundle, `/global/health`, `/file/list`).

## Gotchas the agent will miss

- **`launcher.mjs` requires Bun, not Node.** The OpenTUI dashboard relies on
  `bun:ffi` for its native renderer. Stock Node.js (no experimental `node:ffi`,
  which never shipped stable) fails with "OpenTUI native FFI is not available
  for this runtime yet". `launcher.mjs:46` refuses to run under non-Bun
  runtimes with a clear error message. Use `bun launcher.mjs` or
  `npm run launcher`.
- **Files declared in `package.json` but missing**: `scripts/list-mods.mjs` and
  `scripts/validate-mods.mjs` do not exist. `npm run list-mods` and
  `npm run validate-mods` will fail. Don't trust the script list blindly.
- **`chokidar` is declared in `dependencies` but never imported.** The watcher
  in `internal/loader.mjs` polls via `setInterval` + `fs.readdir` (Windows + WSL
  compat). The dep is removable.
- **`OC_PROXY_HOST` default disagrees with README.** `server.mjs:40` defaults to
  `0.0.0.0` (binds all interfaces). The README says `127.0.0.1`. The code is
  the source of truth — set `OC_PROXY_HOST=127.0.0.1` for local-only.
- **Watcher polls every 500 ms** (`OC_WATCH_MS`). For instant rescan in tests
  or after a write, hit `GET /__oc_mods/refresh` (no-op except triggering a
  `loader.scan()`).
- **Filenames are the mod list.** Files starting with `_` or ending with
  `.disabled` are skipped by `loader.scan()`. Numbered prefixes (`01-`, `02-`,
  `99-`) control load order — bundle is sorted alphabetically by id, not by
  filename (see `loader.mjs:180`).
- **The proxy never executes mod source.** It parses with `new Function(...)`
  for syntax validation and grep-regexes for `id`/`name`/`version`. The IIFE
  actually runs in the browser when the bundle is injected.
- **Injection happens at the bundle (`/assets/index-*.js`)**, not the HTML.
  The HTML-level `<script id="oc-mod-loader">` is a fallback only. Strategy A
  comment at `injector.mjs:1` explains why.
- **ETag is the cache-busting mechanism** — `Cache-Control: no-cache,
  must-revalidate` plus a SHA-256 ETag of the body. If a mod edit "doesn't
  take", check that the browser isn't sending a stale `If-None-Match` (hard
  reload with DevTools "Disable cache" on).
- **OpenCode Web v1.18.4 is the verified target.** The `connect-src * data:`
  CSP means mods can call upstream freely. Don't change the upstream version
  without re-verifying injection points (see `README.md` top section).
- **`scripts/01-debug-overlay.js` is intentionally NOT shipped.** Empirically
  (Jul 2026), when this mod is enabled the server-side conversation context
  grows abnormally fast — every message the user sends is processed and
  stored multiple times. The proxy's pass-through was buffering SSE chunks
  (see "Known proxy bugs" below); debug-overlay's MutationObserver + frequent
  re-mounts created enough parallel SSE pressure to expose the buffering as
  exponential message duplication. If you ever re-introduce it, also apply
  the SSE fix in server.mjs and verify with: send a short message, check
  `GET /session/:id/message?limit=10` shows ONE new entry, not several.
- **Known proxy bugs** (server.mjs):
  - SSE/event-stream responses were buffered in Node's internal write buffer
    because `res.write()` does not flush until `highWaterMark` (16 KB) is
    reached. SSE chunks are tiny, so the client never received events in real
    time, timed out, and retried POSTs — inflating session context. Fixed by
    calling `res.flushHeaders()` + `socket.setNoDelay(true)` + waiting on
    `res.once('drain', …)` before continuing the read loop in the pass-through.
    Verify the fix is active by reading `server.mjs` lines around the
    `// Flush headers` comment. Any fork that drops these three lines will
    re-introduce the symptom.

## Internal endpoints (proxy :8080)

| Path | Purpose |
|---|---|
| `/__oc_mods/manifest.json` | JSON list of loaded mods + collisions. |
| `/__oc_mods/loader.js` | Standalone mod bundle (used by HTML fallback). |
| `/__oc_mods/<id>.js` | Single mod source. |
| `/__oc_mods/refresh` | Force a `loader.scan()` (test helper). |

## Mods

Mods are vanilla IIFEs. The minimum viable mod:

```js
(function () {
  globalThis.OC.register({
    id: 'hello-world',
    name: 'Hello World',
    version: '1.0.0',
    init() {
      console.log('[hello] alive')
    },
  })
})()
```

Inside an `init()`, the mod has access to `window.OC.register`,
`window.OC.mods`, `window.OC.bus` (EventTarget), and the original `window.fetch`.
See `scripts/01-custom-paths.js` for a non-trivial fetch-hook example and
`scripts/README.md` for the full API.

## Where to look first when something breaks

1. `logs/mod-loader.log` — JSON-lines scan events, injection events, errors.
2. Browser DevTools → Console → `[OC] mod registered: <id>` per mod, plus
   `[OC] loader ready, N mod(s)`.
3. `http://localhost:8080/__oc_mods/manifest.json` — does the proxy see the
   mod file? If a mod is missing here, the issue is file naming/syntax, not
   injection.
4. Page source → search for `OC MOD LOADER active:` HTML banner. If it's
   stale, the browser is caching — hard reload.
5. Bring up the mock + proxy fast: `node test-mock-opencode.mjs` in one
   terminal, `node server.mjs` in another, then `node debug-test.mjs`.
