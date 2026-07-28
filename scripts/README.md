# Mods Folder

This folder is auto-scanned by the **OpenCode Mod Loader** (parent directory).
Regular `*.js` files are client mods injected into OpenCode Web. Files ending
in `.server.js` or `.server.mjs` are imported and executed by the Node proxy.

## Filename Conventions

| Pattern | Behavior |
|---|---|
| `01-foo.js` | Loaded as a client mod. Execution order is alphabetical by mod `id`. |
| `99-bar.js` | Loaded as a client mod; the numeric prefix affects the fallback id, not an explicitly declared `id`. |
| `foo.server.js` | Imported by Node as a server-side mod; never injected into the browser. |
| `foo.server.mjs` | Same server-side behavior with an explicit ESM extension. |
| `_foo.js` | **Skipped.** Leading underscore = disabled. |
| `foo.js.disabled` | **Skipped.** Kill switch. |
| `foo.js.bak`, `foo.js~` | **Skipped** (not `.js`). |

## Client Mod File Format (IIFE)

Each mod is a JavaScript file that, when executed in the browser, registers
itself with `globalThis.OC.register(...)`. The most common form is:

```js
(function () {
  globalThis.OC.register({
    id: 'my-mod',                  // unique id (REQUIRED)
    name: 'My Mod',                // human-readable name
    version: '1.0.0',              // semver (recommended)
    description: 'What it does',  // optional
    depends: ['other-mod'],       // optional; ordering hint only

    init() {
      // Your code runs here, after DOMContentLoaded.
      // `this` is the registered mod object.
      // `window.OC.bus` is an EventTarget for cross-mod communication.
      // `window.OC.mods` is the registry of all loaded mods.
    },
  })
})()
```

## Server-Side Mods

Files ending in `.server.js` or `.server.mjs` are imported and executed by the proxy. They must export an object with a unique `id` and at least one hook:

```js
export default {
  id: 'my-server-mod',
  version: '1.0.0',

  async onRequest(req, res, context) {
    return false
  },

  async onResponse(req, res, upstreamResponse, bodyBuffer, context) {
    return bodyBuffer
  },
}
```

`onRequest` runs before forwarding and may return `true` or end `res` to handle the request. `onResponse` runs after the upstream response and may return a `Buffer`, string, typed array, or `undefined` to keep the current body. Registering any `onResponse` hook buffers that response, so avoid matching SSE or other long-lived streams unless buffering is intentional. The context exposes `config`, `loader`, and `log`.

## Client Mod Scope

| Symbol | Description |
|---|---|
| `window.OC.register(mod)` | Register a mod (called automatically when you do it) |
| `window.OC.mods` | Map of id → registered mod (incl. `init` fn) |
| `window.OC.bus` | `EventTarget` for cross-mod events |
| `window.fetch` (original) | Hookable; remember to bind and unbind cleanly |
| `localStorage` | Persist per-user state (`oc_*` keys recommended) |

## Lifecycle

### Client mods

1. The proxy reads each regular `*.js` client mod without executing it.
2. It computes a SHA-256 of each file's source.
3. When a browser request hits `/assets/index-*.js` (the SolidJS bundle), the
   proxy prepends a single bundle that:
   - Sets up `window.OC.register`, `window.OC.mods`, `window.OC.bus`.
   - Wraps each mod's source in `try { ... } catch (err) { console.error(...) }`.
   - Executes mods after `DOMContentLoaded`.
4. A broken client mod doesn't kill the app — its error is logged and other mods continue.

### Server mods

1. The proxy imports each `*.server.js` and `*.server.mjs` module.
2. It validates the exported `id` and requires `onRequest` or `onResponse`.
3. `onRequest` hooks run before the upstream fetch.
4. `onResponse` hooks run sequentially against a buffered body after the upstream response.
5. Saving, adding, or deleting the file updates the server registry on the next scan.

## Hot Reload

The proxy polls this folder every 500 ms. When you save a file:
- The proxy re-scans both client and server registries.
- Client changes apply on the next browser reload with a new ETag.
- Server hook changes apply to subsequent requests without a browser reload.

## Cache Busting

The proxy sends:
- `Cache-Control: no-cache, must-revalidate` (force revalidation with the proxy)
- `ETag: "<sha256 of bundle>"` (cheap revalidation)
- `X-OC-Mod-Count: <n>` (debug)

If the browser's `If-None-Match` header matches the ETag, the proxy responds
`304 Not Modified` without sending the body. This keeps revalidation fast
while ensuring stale mods never linger.

## Debugging

- Visit `http://localhost:8080/__oc_mods/manifest.json` to inspect `mods` and `serverMods`.
- Open DevTools console: `[OC] mod registered: <id> <version>` for each client mod.
- Check `logs/mod-loader.log` for scan, import, hook, and proxy errors.
