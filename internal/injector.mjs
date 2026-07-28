// internal/injector.mjs
// Decides how to mutate an upstream response (HTML or bundle JS) before
// streaming it to the browser. The proxy calls `injectHTML()` and
// `injectBundle()` for the relevant paths.
//
// Two injection points in OpenCode Web (verified against v1.18.4):
//
//   1. The HTML root index.html has:
//        <script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>
//      If we replace that tag with an INLINE <script id="oc-theme-preload-script">
//      containing our payload, the server (in its own response) will re-sign
//      with the new SHA256. But the proxy is BEFORE the server signs — the
//      server signs its OWN response. So this trick only works if we don't
//      forward the CSP header verbatim OR we strip the inline-signing logic.
//
//   2. The bundle JS at /assets/index-*.js (Vite production convention)
//      is served from the same origin and is therefore allowed by CSP
//      `script-src 'self'`. We can prepend our mods there.
//
// We use strategy (2) because:
//   - it doesn't require messing with the server's CSP re-signing logic
//   - it runs BEFORE any SolidJS code (so fetch is hookable before app boot)
//   - it survives version bumps of the HTML (only bundle names change)

const BUNDLE_PATTERN = /^\/assets\/index-[A-Za-z0-9_-]+\.js(\?.*)?$/
const HTML_PATHS = new Set(['/', '/index.html'])

export function shouldInject(reqPath, contentType) {
  if (BUNDLE_PATTERN.test(reqPath) && /javascript/i.test(contentType)) {
    return 'bundle'
  }
  if (HTML_PATHS.has(reqPath.split('?')[0]) && /text\/html/i.test(contentType)) {
    return 'html'
  }
  return null
}

/**
 * Modifies the HTML body to inject a banner + script tag that loads our
 * mods as separate URLs. We use this for clarity / debugging, but the
 * real injection happens at the bundle level.
 */
export function injectHTML(html, modLoader) {
  const banner = modLoader.buildHtmlBanner()
  // Inject a small loader right before </head> that fetches our mod bundle.
  // This is redundant with the bundle injection but gives us a fallback for
  // edge cases (e.g. SPA routes that don't go through the main bundle).
  const modBundleUrl = '/__oc_mods/loader.js'
  const scriptTag = `<script id="oc-mod-loader" src="${modBundleUrl}" defer></script>`
  if (html.includes('</head>')) {
    return banner + html.replace('</head>', `${scriptTag}</head>`)
  }
  // Fallback: inject at start of body
  return banner + html.replace('<body', `<body`).replace(/<body([^>]*)>/, `<body$1>${scriptTag}`)
}

/**
 * Prepends the mod bundle to the Vite JS bundle.
 * Runs in the SAME realm as the OpenCode app, before any SolidJS code.
 */
export function injectBundle(jsBody, modLoader) {
  const modBundle = modLoader.buildInjectionBundle()
  if (!modBundle) return jsBody
  // Add a tiny newline + banner so the user can see mods loaded in DevTools
  const banner = `\n/* === OC MOD LOADER injection (${modLoader.registry.size} mod(s)) === */\n`
  return modBundle + banner + jsBody
}

/**
 * For path /__oc_mods/loader.js, return the mod bundle to serve as a
 * standalone file. Used by the HTML-injection fallback.
 */
export function getStandaloneModBundle(modLoader) {
  return modLoader.buildInjectionBundle()
}

export { BUNDLE_PATTERN, HTML_PATHS }
