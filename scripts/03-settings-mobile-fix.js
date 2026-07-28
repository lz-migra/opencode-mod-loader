// scripts/05-settings-mobile-fix.js
// OC Mod #05 — Settings Mobile Fix
//
// OpenCode Web settings dialog uses a horizontal flex layout
// (tablist on the left, content on the right). On narrow viewports
// (< 640px) the content panel gets squashed to ~190px and the tablist
// still takes 150px.
//
// This mod injects a stylesheet that flips the layout to vertical on
// narrow screens: the tablist becomes a compact horizontal strip of
// category buttons at the top, and the content fills the full width
// below.

;(function () {
  const STYLE_ID = 'oc-settings-mobile-fix-css'
  const BREAKPOINT = '(max-width: 639px)'

  globalThis.OC.register({
    id: 'settings-mobile-fix',
    name: 'Settings Mobile Fix',
    version: '1.0.0',
    description: 'Stacks the settings dialog vertically on narrow viewports so content is not squashed.',
    depends: [],

    init() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
@media ${BREAKPOINT} {
  [data-component="tabs"][data-variant="settings"] {
    flex-direction: column !important;
    height: 100% !important;
    min-height: 0 !important;
  }
  [data-component="tabs"][data-variant="settings"] [role="tablist"] {
    width: 100% !important;
    height: auto !important;
    flex: 0 0 auto !important;
    max-height: 42% !important;
    min-height: 0 !important;
    border-bottom: 1px solid var(--border-weaker-base, rgba(127,127,127,0.2));
    overflow: hidden !important;
  }
  [data-component="tabs"][data-variant="settings"] [role="tablist"] [data-slot="tabs-list-inner"],
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div,
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div > div,
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div > div > div,
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div > div > div > div,
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div > div > div > div > div {
    flex-direction: row !important;
    flex-wrap: nowrap !important;
    height: auto !important;
    min-height: 0 !important;
    width: auto !important;
  }
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div {
    width: 100% !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    gap: 6px !important;
    padding-bottom: 6px !important;
    align-items: center !important;
  }
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div > div,
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div > div > div,
  [data-component="tabs"][data-variant="settings"] [role="tablist"] > div > div > div > div {
    gap: 6px !important;
  }
  [data-component="tabs"][data-variant="settings"] [role="tablist"] [data-slot="tabs-section-title"] {
    display: none !important;
  }
  [data-component="tabs"][data-variant="settings"] [role="tablist"] [data-slot="tabs-trigger-wrapper"] {
    flex: 0 0 auto !important;
    width: auto !important;
  }
  [data-component="tabs"][data-variant="settings"] [role="tablist"] [data-slot="tabs-trigger-wrapper"] > button {
    width: auto !important;
    min-width: 0 !important;
    white-space: nowrap !important;
  }
  [data-component="tabs"][data-variant="settings"] [data-slot="tabs-content"] {
    width: 100% !important;
    height: auto !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow-y: auto !important;
  }
}
`
      document.head.appendChild(style)
      console.log('[OC:settings-mobile-fix] Stylesheet injected for viewports < 640px.')
    },
  })
})()