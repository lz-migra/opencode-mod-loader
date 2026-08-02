# OpenCode Mod Loader

Reverse proxy + auto-discovered client and server mod loader for **OpenCode Web v1.18.4**.

Client mods from `scripts/*.js` are injected into the SolidJS bundle before it
loads in the browser. Server mods from `scripts/*.server.js` or
`scripts/*.server.mjs` run inside the Node.js proxy and can intercept requests
or transform buffered upstream responses.

> Verified against [v1.18.4 of `anomalyco/opencode`](https://github.com/anomalyco/opencode/tree/v1.18.4).
> Diff from v1.17.15 → v1.18.4 was 250 commits / 300 files changed, but **the
> injection points are untouched**:
> - `packages/opencode/src/server/shared/ui.ts` (CSP, themePreloadHash): identical
> - `packages/app/index.html` (HTML root): identical
> - Bundle convention `/assets/index-<hash>.js`: identical
> - `script-src 'self' 'wasm-unsafe-eval' ... + dynamic SHA256`: identical
> - `connect-src * data:`: identical (lets our mods call upstream freely)

## Quick Start

```
# 1. Install dependencies (one-time)
cd \opencode-mod-loader
npm install

# 2. Start OpenCode server (in another terminal, anywhere)
cd D:\code\my-project
opencode web --port 4096

# 3. Start the mod loader proxy
cd \opencode-mod-loader
node server.mjs

# 4. Open your browser at
#    http://localhost:7531
#    (NOT :4096 — the proxy is the entry point)
```

## What Gets Injected

The proxy intercepts:

| Path | What happens |
|---|---|
| `GET /` or `/index.html` | Adds a `<script>` tag for the mod loader + an HTML comment banner listing loaded mods. |
| `GET /assets/index-*.js` | Prepends the entire mod bundle (all mods concatenated in an IIFE). Runs BEFORE SolidJS. |
| `GET /__oc_mods/loader.js` | Returns the mod bundle as a standalone JS file. |
| `GET /__oc_mods/<id>.js` | Returns a single mod by id. |
| `GET /__oc_mods/manifest.json` | Returns the client and server registries as JSON (for debugging). |
| Any other path | Runs server `onRequest` hooks, forwards to upstream when unhandled, then runs server `onResponse` hooks. |

## Adding a Client Mod

Drop a regular `*.js` file in `scripts/` and reload the page. Server suffixes
are reserved and are not injected into the browser.

The mod must follow the IIFE convention documented in [`scripts/README.md`](./scripts/README.md).
The minimum viable mod:

```js
(function () {
  globalThis.OC.register({
    id: 'hello-world',
    name: 'Hello World',
    version: '1.0.0',
    init() {
      console.log('👋 Hello from a mod!')
    },
  })
})()
```

## Adding a Server Mod

Create `scripts/my-mod.server.mjs` or `scripts/my-mod.server.js` and export an
object with a unique `id` and at least one lifecycle hook:

```js
export default {
  id: 'example-server-mod',
  version: '1.0.0',

  async onRequest(req, res, context) {
    if (req.url !== '/api/example') return false
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
    return true
  },

  async onResponse(req, res, upstreamResponse, bodyBuffer, context) {
    return bodyBuffer
  },
}
```

`onRequest` runs before the upstream fetch. Return `true` or end `res` to stop
forwarding. `onResponse` receives the complete upstream body and may return a
`Buffer`, string, typed array, or `undefined` to preserve the current body.
The `context` object exposes `config`, `loader`, and `log`.

An enabled `onResponse` hook causes the response to be buffered. Do not install
one for SSE or other long-lived streams unless buffering is intentional.

Server mods are imported by Node and therefore have the same local access as
the proxy process. Only install trusted server mods.

## Architecture

```
┌─────────────────┐            ┌──────────────────────────────┐         ┌──────────────────┐
│  Browser        │-----------→│ Proxy (:8080)                │--------→│  OpenCode Server │
│  localhost:8080 │    HTTP    │  • inject client mods        │  HTTP   │  localhost:4096  │
│                 │←-----------│  • run server mod hooks      │←--------│ • upstream proxy │
└─────────────────┘            │  • serve /__oc_mods/*.js     │         └──────────────────┘
                               │  • ETag cache busting        │
                               └──────────────────────────────┘
                                              │
                                              ↓
                                   ┌─────────────────────┐
                                   │  scripts/           │
                                   │  *.js (client IIFE) │
                                   │  *.server.{js,mjs}  │
                                   └─────────────────────┘
```

## Cache Busting Strategy

This was the trickiest part because Vite uses content-hashed filenames for the
bundle (`/assets/index-abc123.js`). Three layers of defense:

1. **ETag on every response.** The proxy sends `ETag: "<sha256 of body>"`.
   On `If-None-Match`, it returns `304 Not Modified` without the body. This is
   fast and accurate.

2. **`Cache-Control: no-cache, must-revalidate`.** Forces browsers to
   revalidate with the proxy on every page load. They may serve a 304 in <1 ms.

3. **HTML banner with mod IDs.** When you look at the page source, the HTML
   has a comment listing the loaded client mods (e.g. `<!-- OC MOD LOADER active:
   4 mod(s): absolute-paths@4.0.0 · classic-layout@1.0.0 · mods-tab@1.0.0 · settings-mobile-fix@1.0.0 -->`).
   If the list doesn't match what you expect, the cache is stale.

The polling watcher re-scans `scripts/` every 500 ms. When you save a file:
- The proxy's internal ETag changes (different content → different hash).
- Next page load: browser sends `If-None-Match: "<old-hash>"`, proxy says 304
  if content hasn't actually changed, or sends full body with new ETag.

## Configuration

Edit `config.json` to choose the proxy port used by both `node server.mjs` and
`bun launcher.mjs`:

```json
{
  "proxyPort": 7531
}
```

`proxyPort` must be an integer from 1 to 65535. `OC_PROXY_PORT` overrides this
value for the proxy, while `OC_LAUNCHER_PORT` overrides it for the launcher.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OC_PROXY_PORT` | `config.json` → `proxyPort` | Port the proxy listens on |
| `OC_PROXY_HOST` | `0.0.0.0` | Interface to bind (set `127.0.0.1` for local-only access) |
| `OC_TARGET_URL` | `http://127.0.0.1:4096` | Upstream OpenCode server |
| `OC_SCRIPTS_DIR` | `./scripts` | Where to look for mods |
| `OC_WATCH_MS` | `500` | File polling interval in ms |
| `OC_VERBOSE` | `0` | Set to `1` for verbose console logs |
| `OC_LOG_FILE` | `./logs/mod-loader.log` | Path to JSON-lines log |

## Files

```
opencode-mod-loader/
├── server.mjs                    # Main proxy server
├── package.json                  # Package metadata and commands
├── README.md                     # This file
├── internal/
│   ├── loader.mjs                # Mod discovery + injection bundle builder
│   └── injector.mjs              # HTML/JS transformation logic
├── scripts/
│   ├── README.md                 # Client/server mod API
│   ├── 02-classic-layout.js     # Client mod example
│   └── example.server.mjs       # Server mod naming convention (optional)
│
└── logs/
    └── mod-loader.log            # Auto-created JSON-lines log
```

## Limitations

- **Server response hooks buffer bodies.** Defining `onResponse` causes each
  affected proxy response to be read completely before delivery. Avoid SSE,
  downloads, and long-lived streams unless the mod explicitly needs buffering.
- **One client per proxy.** Each browser session loads the same mod bundle.
  If you need per-user mods, host the proxy separately per user.
- **No mod dependencies enforced.** The `depends: ['foo']` field is currently
  a hint only — load order is alphabetical by id. Stronger enforcement is
  planned in v2.
- **Polling instead of fs.watch.** We poll every 500 ms because Node's
  `fs.watch` is unreliable on Windows + WSL. Cost is negligible.

## Security Notes

- Client mods execute in your browser with full DOM access. They can read your
  OpenCode tokens and call the server.
- Server mods execute inside the proxy process with access to Node.js and the
  local filesystem. Audit every mod before installing it.
- The default bind address is `0.0.0.0`. Set `OC_PROXY_HOST=127.0.0.1` for
  local-only access; if exposing it to a LAN, configure upstream authentication.
- Logs in `logs/mod-loader.log` do NOT contain request/response bodies.

## Roadmap

- Mod dependency resolution (currently only alphabetical ordering)
- `dev` mode with `--watch` (auto-restart on loader.mjs changes)
- Mod marketplace: install from URL
- Per-user mod profiles (separate bundles per session)
