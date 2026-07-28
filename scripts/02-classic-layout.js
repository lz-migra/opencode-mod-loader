(function () {
  globalThis.OC.register({
    id: 'classic-layout',
    name: 'Classic Layout',
    version: '1.0.0',
    description: 'Disables the new layout designs and enables layout transitions.',

    init() {
      const d = JSON.parse(localStorage.getItem('settings.v3') || '{}')
      d.general = d.general || {}
      const needsReload =
        d.general.newLayoutDesigns !== false ||
        d.general.layoutTransitionEligible !== true

      d.general.newLayoutDesigns = false
      d.general.layoutTransitionEligible = true
      localStorage.setItem('settings.v3', JSON.stringify(d))

      if (needsReload) location.reload()
    },
  })
})()
