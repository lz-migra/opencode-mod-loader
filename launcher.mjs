#!/usr/bin/env bun
// launcher.mjs — One-shot launcher for OpenCode + the Mod Loader proxy.
//
// Run with:  bun launcher.mjs
//
// What this does:
//   1. Spawn `opencode serve --hostname 0.0.0.0 --port <upstream-port>` as a child process.
//   2. Wait for the upstream to respond on / (or /global/health) before
//      starting the proxy — so the proxy's first request to upstream
//      never hits a "connection refused".
//   3. Spawn `node server.mjs` (the proxy) with the right env vars so it
//      points at the upstream we just started.
//   4. Render an OpenTUI dashboard (header, status, scrollable log panes)
//      and stream both children's stdout/stderr into the appropriate pane.
//   5. Forward SIGINT / SIGTERM / [q] / [r] to a clean shutdown that
//      terminates both children. If either child dies unexpectedly, kill
//      the other so you don't end up with a phantom upstream eating CPU
//      after the proxy died (or vice versa).
//
// Env vars (all optional, read at boot):
//   OC_LAUNCHER_PORT          Port for the proxy (default 8080).
//                             Forwards to the proxy as OC_PROXY_PORT.
//   OC_LAUNCHER_UPSTREAM_PORT Port for opencode web (default 4096).
//                             Forwards to the proxy as OC_TARGET_URL.
//   OC_LAUNCHER_HOST          Host the proxy binds to (default 127.0.0.1).
//                             Forwards as OC_PROXY_HOST.
//   OC_LAUNCHER_OPENCODE_BIN  Executable to run (default: `opencode`).
//                             Useful if opencode isn't on PATH, e.g.:
//                               OC_LAUNCHER_OPENCODE_BIN="C:\path\to\opencode.exe"
//   OC_LAUNCHER_OPENCODE_ARGS Extra args passed to `opencode serve`, as a
//                             single string that will be split on spaces.
//                             Example: OC_LAUNCHER_OPENCODE_ARGS="--hostname 0.0.0.0"
//   OC_LAUNCHER_HEALTH_TIMEOUT  Max seconds to wait for upstream (default 30).
//   OC_LAUNCHER_HEALTH_PATH     URL path to probe (default "/" — any 2xx/3xx
//                             or even a 404 counts as "up"). Set to
//                             "/global/health" if you want a stricter check.
//   OC_LAUNCHER_NO_OPENCODE    If set to "1", skip launching opencode and
//                             assume it's already running at OC_TARGET_URL.
//                             Useful when developing the proxy against an
//                             external opencode instance.
//
// Exit codes:
//   0  clean shutdown (Ctrl+C / [q])
//   1  upstream failed to come up within the timeout
//   2  upstream exited before/during proxy startup
//   3  proxy exited unexpectedly

// ─── Runtime guard ────────────────────────────────────────────────
// OpenTUI's native FFI uses bun:ffi / node:ffi. Stock Node.js doesn't
// ship node:ffi (it was an experimental module that never landed), so
// the renderer fails to load there. Refuse to run under plain Node and
// point the user at Bun.
const isBun = typeof process !== 'undefined' && process.versions && typeof process.versions.bun === 'string'
if (!isBun) {
  console.error('❌ launcher.mjs requires Bun (OpenTUI\'s FFI backend is bun:ffi).')
  console.error('   Run it as:  bun launcher.mjs')
  console.error('   Install Bun: https://bun.sh')
  process.exit(1)
}

import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  CliRenderEvents,
  t,
  green,
  red,
  yellow,
  stripAnsiSequences,
} from '@opentui/core'

// Resolve paths via fileURLToPath to avoid the Windows URL.pathname trap.
// `new URL('./server.mjs', import.meta.url).pathname` returns
// `/C:/Users/.../server.mjs` on Windows, which Node interprets as
// `C:\C:\Users\...` and silently fails with `Cannot find module ...`.
// `fileURLToPath` returns the proper OS-native absolute path.
const __dirname = fileURLToPath(new URL('.', import.meta.url))
function absPath(p) {
  return fileURLToPath(new URL(p, import.meta.url))
}

// ─── Configuration ────────────────────────────────────────────────
const PROXY_PORT        = parseInt(process.env.OC_LAUNCHER_PORT || '8080', 10)
const UPSTREAM_PORT     = parseInt(process.env.OC_LAUNCHER_UPSTREAM_PORT || '4096', 10)
const PROXY_HOST        = process.env.OC_LAUNCHER_HOST || '127.0.0.1'
const OPENCODE_BIN      = process.env.OC_LAUNCHER_OPENCODE_BIN || 'opencode'
const OPENCODE_EXTRA    = (process.env.OC_LAUNCHER_OPENCODE_ARGS || '')
                            .split(/\s+/)
                            .filter(Boolean)
const HEALTH_TIMEOUT_S  = parseInt(process.env.OC_LAUNCHER_HEALTH_TIMEOUT || '30', 10)
const HEALTH_PATH       = process.env.OC_LAUNCHER_HEALTH_PATH || '/'
const SKIP_OPENCODE     = process.env.OC_LAUNCHER_NO_OPENCODE === '1'
const UPSTREAM_URL      = `http://127.0.0.1:${UPSTREAM_PORT}`

// ─── Captured log buffers (also fed to the TUI panes) ─────────────
const LOG_BUFFER_LIMIT = 200_000 // chars per pane; older lines are trimmed
const launcherLog = { buf: '' }
const proxyLog    = { buf: '' }
const opencodeLog = { buf: '' }

function appendLog(target, chunk) {
  target.buf += chunk
  if (target.buf.length > LOG_BUFFER_LIMIT) {
    target.buf = target.buf.slice(-LOG_BUFFER_LIMIT)
  }
  // Push to the TUI if it has been built.
  if (target.render) target.render()
}

// ─── State ────────────────────────────────────────────────────────
let upstream = null     // child process for `opencode web`
let proxy    = null     // child process for `node server.mjs`
let shuttingDown = false
let proxyReady = false
let renderer = null
let ui = null           // populated after createCliRenderer

// ─── UI construction ──────────────────────────────────────────────
function buildUI(r) {
  const root = new BoxRenderable(r, {
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    padding: 1,
    gap: 1,
  })

  // ── Header ────────────────────────────────────────────────
  const header = new BoxRenderable(r, {
    flexDirection: 'row',
    flexShrink: 0,
    borderStyle: 'rounded',
    borderColor: '#7aa2f7',
    paddingX: 2,
    paddingY: 0,
    width: '100%',
    height: 'auto',
  })
  const headerText = new TextRenderable(r, {
    content: 'OpenCode Mod Loader — launcher',
    fg: '#7aa2f7',
    attributes: 1, // bold
    flexShrink: 0,
    width: '100%',
  })
  header.add(headerText)
  root.add(header)

  // ── Status panel ──────────────────────────────────────────
  const statusPanel = new BoxRenderable(r, {
    flexDirection: 'column',
    flexShrink: 0,
    borderStyle: 'rounded',
    borderColor: '#565f89',
    paddingX: 2,
    paddingY: 0,
    width: '100%',
    height: 'auto',
    gap: 0,
  })

  const statusProxy = new TextRenderable(r, {
    content: '',
    fg: '#c0caf5',
    flexShrink: 0,
    width: '100%',
  })
  const statusUpstream = new TextRenderable(r, {
    content: '',
    fg: '#c0caf5',
    flexShrink: 0,
    width: '100%',
  })
  const statusHealth = new TextRenderable(r, {
    content: '',
    fg: '#9aa5ce',
    flexShrink: 0,
    width: '100%',
  })
  const statusTimeout = new TextRenderable(r, {
    content: '',
    fg: '#9aa5ce',
    flexShrink: 0,
    width: '100%',
  })
  const statusActions = new TextRenderable(r, {
    content: '',
    fg: '#e0af68',
    flexShrink: 0,
    width: '100%',
  })
  statusPanel.add(statusProxy)
  statusPanel.add(statusUpstream)
  statusPanel.add(statusHealth)
  statusPanel.add(statusTimeout)
  statusPanel.add(statusActions)
  root.add(statusPanel)

  // ── Logs container (two scrollable panes, stacked) ────────
  const logsContainer = new BoxRenderable(r, {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    width: '100%',
    minHeight: 0,
    gap: 1,
  })

  const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let frame = 0
  let proxyStatus = 'starting'
  let upstreamStatus = 'starting'
  let spinnerTimer = null

  function makeLogPanel(title) {
    const box = new BoxRenderable(r, {
      flexDirection: 'column',
      borderStyle: 'rounded',
      borderColor: '#3b4261',
      title,
      titleAlignment: 'left',
      flexGrow: 1,
      width: '100%',
      paddingX: 1,
    })
    const scroll = new ScrollBoxRenderable(r, {
      flexGrow: 1,
      width: '100%',
      stickyScroll: true,
      stickyStart: 'bottom',
      scrollY: true,
      scrollX: false,
      viewportOptions: { padding: 0 },
      contentOptions: { padding: 0 },
    })
    const text = new TextRenderable(r, {
      content: '',
      fg: '#a9b1d6',
      wrapMode: 'word',
      width: '100%',
    })
    scroll.add(text)
    box.add(scroll)
    return { box, scroll, text }
  }

  const launcherPanel = makeLogPanel('LOGS LAUNCHER')
  const proxyPanel = makeLogPanel('LOGS PROXY')
  const upstreamPanel = makeLogPanel('LOGS OPENCODE')
  // The launcher panel is informational and short — give it a fixed
  // baseline of 25% of the available height so it doesn't dominate the
  // proxy/opencode logs which are the real source of truth.
  launcherPanel.box.flexGrow = 0
  launcherPanel.box.flexShrink = 1
  launcherPanel.box.height = '25%'
  logsContainer.add(launcherPanel.box)
  logsContainer.add(proxyPanel.box)
  logsContainer.add(upstreamPanel.box)
  root.add(logsContainer)

  r.root.add(root)

  // ── Status line refresh ───────────────────────────────────
  function paintStatus() {
    const spin = FRAMES[frame % FRAMES.length]
    const proxyLabel = colorForStatus(proxyStatus)
    const upLabel = colorForStatus(upstreamStatus)
    statusProxy.content = t`Proxy will bind:    http://${PROXY_HOST}:${PROXY_PORT}  ${spin}  ${proxyLabel}`
    statusUpstream.content = t`OpenCode upstream:  ${UPSTREAM_URL}  ${spin}  ${upLabel}`
    statusHealth.content  = t`Health check path:  ${HEALTH_PATH}`
    statusTimeout.content = t`Health timeout:     ${HEALTH_TIMEOUT_S}s`
    statusActions.content = '[r] Reiniciar    [q] Salir'
  }

  function colorForStatus(status) {
    if (status === 'up') return green(status)
    if (status === 'down' || status === 'error') return red(status)
    return yellow(status)
  }

  paintStatus()
  spinnerTimer = setInterval(() => {
    frame++
    paintStatus()
  }, 80)

  // Wire log buffer → UI text. We rebuild the text content from the
  // in-memory buffer (which is size-capped) so streams of mixed ANSI
  // from the children get re-rendered cleanly.
  launcherLog.render = () => {
    launcherPanel.text.content = launcherLog.buf
  }
  proxyLog.render = () => {
    proxyPanel.text.content = proxyLog.buf
  }
  opencodeLog.render = () => {
    upstreamPanel.text.content = opencodeLog.buf
  }
  launcherLog.render()
  proxyLog.render()
  opencodeLog.render()

  // Initial paint
  r.start()

  return {
    setProxyStatus(s) { proxyStatus = s; paintStatus() },
    setUpstreamStatus(s) { upstreamStatus = s; paintStatus() },
    stop() { if (spinnerTimer) clearInterval(spinnerTimer) },
  }
}

function logLauncherLine(level, msg) {
  // Launcher status lines go to the dedicated launcher pane so the
  // user sees them separately from the proxy/opencode child output.
  const ts = new Date().toISOString().slice(11, 19)
  const line = `[${ts}] [launcher/${level}] ${msg}\n`
  appendLog(launcherLog, line)
  if (ui) ui.setProxyStatus(level === 'error' ? 'error' : proxyReady ? 'up' : 'starting')
}

// ─── Child process plumbing ───────────────────────────────────────
function pipeStream(stream, label, target, onChunk) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    if (onChunk) onChunk(chunk)
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() // last fragment is incomplete
    let out = ''
    for (const raw of lines) {
      // Filter empty lines from raw stdout/stderr (too noisy).
      if (raw.trim() === '') continue
      const clean = stripAnsiSequences(raw)
      out += `[${label}] ${clean}\n`
    }
    if (out) appendLog(target, out)
  })
  stream.on('end', () => {
    if (buffer.trim() !== '') {
      const clean = stripAnsiSequences(buffer)
      appendLog(target, `[${label}] ${clean}\n`)
    }
  })
}

function shutdown(exitCode, reason) {
  if (shuttingDown) return
  shuttingDown = true
  logLauncherLine('warn', `Shutting down (${reason})…`)
  // Kill proxy first so it stops forwarding requests, then upstream.
  const killChain = async () => {
    if (proxy && proxy.exitCode === null) {
      try { proxy.kill('SIGTERM') } catch {}
    }
    if (upstream && upstream.exitCode === null) {
      try { upstream.kill('SIGTERM') } catch {}
    }
    // Give them 3s to exit cleanly, then SIGKILL.
    await wait(3000)
    for (const p of [proxy, upstream]) {
      if (p && p.exitCode === null) {
        try { p.kill('SIGKILL') } catch {}
      }
    }
  }
  killChain().finally(async () => {
    if (ui) ui.stop()
    if (renderer && !renderer.isDestroyed) renderer.destroy()

    // Imprime el error en la terminal limpia antes de salir completamente
    if (exitCode !== 0) {
      console.error(`\n[ERROR FATAL] El launcher se cerró (código ${exitCode}). Razón: ${reason}`);
    }

    process.exit(exitCode)
  })
}

// ─── Reap orphaned upstream listening on UPSTREAM_PORT ──────────
// When the launcher is restarted after a crash, a previous OpenCode
// process may still hold UPSTREAM_PORT. Probing that port via net.Server
// distinguishes "nothing listening" from "something IS listening".
// When something is listening, we identify the PID by platform and kill it.
// Errors are swallowed at every step — the helper must never abort the
// launcher if the port is free.
async function reapOrphanedUpstream(port) {
  const inUse = await isPortInUse(port)
  if (!inUse) return

  logLauncherLine('info', `Port ${port} is already in use; checking for an orphaned upstream…`)

  let pids = []
  try {
    if (process.platform === 'win32') {
      pids = await findPidsOnPortWindows(port)
    } else {
      pids = await findPidsOnPortPosix(port)
    }
  } catch (err) {
    logLauncherLine('warn', `Could not enumerate PIDs on port ${port}: ${err.message}`)
    return
  }

  if (pids.length === 0) {
    logLauncherLine('warn', `Port ${port} appears busy but no owning PID was found (likely TIME_WAIT or another proxy in front). Continuing — OpenCode will fail loudly if it cannot bind.`)
    return
  }

  for (const pid of pids) {
    try {
      logLauncherLine('info', `Found orphaned process on port ${port} (PID: ${pid}), terminating…`)
      process.kill(pid, 'SIGKILL')
    } catch (err) {
      if (err.code === 'ESRCH') {
        logLauncherLine('info', `PID ${pid} already gone, skipping.`)
      } else if (err.code === 'EPERM') {
        logLauncherLine('warn', `PID ${pid} exists but we lack permission to kill it. Re-run as admin or stop the process manually.`)
      } else {
        logLauncherLine('warn', `Failed to kill PID ${pid}: ${err.message}`)
      }
    }
  }

  await wait(1000)
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      try { tester.close() } catch {}
      resolve(v)
    }
    tester.once('error', () => done(true))
    tester.once('listening', () => done(false))
    try {
      tester.listen(port, '127.0.0.1')
    } catch {
      done(true)
    }
  })
}

function findPidsOnPortWindows(port) {
  return new Promise((resolve) => {
    const command = `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`
    const proc = spawn('powershell', ['-NoProfile', '-Command', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d) => { out += d })
    proc.once('close', () => {
      const pids = out
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
      resolve([...new Set(pids)])
    })
    proc.once('error', () => resolve([]))
  })
}

function findPidsOnPortPosix(port) {
  return new Promise((resolve) => {
    const tryLsof = spawn('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    tryLsof.stdout.setEncoding('utf8')
    tryLsof.stdout.on('data', (d) => { out += d })
    tryLsof.once('error', () => {
      const fuser = spawn('fuser', [`${port}/tcp`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let fOut = ''
      fuser.stdout.setEncoding('utf8')
      fuser.stdout.on('data', (d) => { fOut += d })
      fuser.once('close', () => {
        const pids = (fOut.match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter(Number.isFinite)
        resolve(pids)
      })
      fuser.once('error', () => resolve([]))
    })
    tryLsof.once('close', (code) => {
      if (code !== 0) return resolve([])
      const pids = out.split(/\s+/).map((s) => parseInt(s, 10)).filter(Number.isFinite)
      resolve(pids)
    })
  })
}

// ─── Wait for upstream to be reachable ────────────────────────────
async function waitForUpstream(url, timeoutSec) {
  let spawnFailed = false
  let resolveSpawn
  const spawned = new Promise((resolve) => { resolveSpawn = resolve })
  upstream.once('spawn', () => resolveSpawn(true))
  upstream.once('error', () => {
    spawnFailed = true
    resolveSpawn(false)
  })

  const deadline = Date.now() + timeoutSec * 1000
  let attempt = 0
  // We accept any TCP-level response: opencode web returns HTML for "/",
  // and even a 404 means the server is up. We just need to confirm the
  // port is open.
  if (upstream && !(await spawned)) return false
  while (Date.now() < deadline && !spawnFailed && !shuttingDown) {
    attempt++
    try {
      const res = await fetch(url, { method: 'GET' })
      logLauncherLine('ok', `Upstream responded with ${res.status} on attempt #${attempt}`)
      return true
    } catch {
      if (attempt % 5 === 1) {
        logLauncherLine('info', `Waiting for upstream at ${url}… (attempt #${attempt})`)
      }
    }
    await wait(500)
  }
  return false
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  // OpenTUI takes over stdin/stdout. Build the dashboard first so the
  // status panel is visible while we reap/orphan/spawn.
  if (!renderer) {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,        // we handle Ctrl+C ourselves cleanly
      useMouse: true,
      enableMouseMovement: true,
      autoFocus: true,
    })
    ui = buildUI(renderer)

    // ── Key bindings ──────────────────────────────────────────
    renderer.keyInput.on('keypress', (key) => {
      if (shuttingDown) return
      const name = key.name || ''
      if (name === 'q' || (key.ctrl && name === 'c')) {
        shutdown(0, 'user requested quit')
      } else if (name === 'r') {
        restart()
      }
    })
    renderer.on(CliRenderEvents.DESTROY, () => {
      if (!shuttingDown) shutdown(0, 'renderer destroyed')
    })
  } else {
    ui.setProxyStatus('starting')
    ui.setUpstreamStatus('starting')
  }

  // ── 0. Reap any orphaned upstream listening on UPSTREAM_PORT ─────
  await reapOrphanedUpstream(UPSTREAM_PORT)

  // ── 1. Start OpenCode (unless skipped) ────────────────────────
  if (SKIP_OPENCODE) {
    logLauncherLine('info', `OC_LAUNCHER_NO_OPENCODE=1 — assuming upstream already running at ${UPSTREAM_URL}`)
    ui.setUpstreamStatus('up')
  } else {
    const args = ['serve', '--hostname', '0.0.0.0', '--port', String(UPSTREAM_PORT), ...OPENCODE_EXTRA]
    logLauncherLine('info', `Spawning: ${OPENCODE_BIN} ${args.join(' ')}`)
    upstream = spawn(OPENCODE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: process.env,
      shell: process.platform === 'win32',
    })
    if (process.platform !== 'win32') upstream.unref()
    pipeStream(upstream.stdout, 'opencode', opencodeLog)
    pipeStream(upstream.stderr, 'opencode', opencodeLog)

    upstream.on('error', (err) => {
      if (shuttingDown) return
      logLauncherLine('error', `Failed to spawn ${OPENCODE_BIN}: ${err.message}`)
      if (err.code === 'ENOENT') {
        logLauncherLine('error', `Hint: set OC_LAUNCHER_OPENCODE_BIN to the full path of the opencode executable`)
      }
      ui.setUpstreamStatus('error')
      shutdown(1, 'spawn failed')
    })
    upstream.on('exit', (code, signal) => {
      if (shuttingDown) return
      logLauncherLine('error', `OpenCode exited unexpectedly (code=${code}, signal=${signal})`)
      ui.setUpstreamStatus('down')
      shutdown(2, 'upstream died')
    })

    // ── 2. Wait for it to be reachable ──────────────────────────
    const ok = await waitForUpstream(UPSTREAM_URL + HEALTH_PATH, HEALTH_TIMEOUT_S)
    if (shuttingDown) return
    if (!ok) {
      logLauncherLine('error', `Upstream did not respond within ${HEALTH_TIMEOUT_S}s`)
      ui.setUpstreamStatus('down')
      shutdown(1, 'health timeout')
      return
    }
    ui.setUpstreamStatus('up')
  }

  // ── 3. Start the proxy ────────────────────────────────────────
  const proxyEnv = {
    ...process.env,
    OC_PROXY_PORT: String(PROXY_PORT),
    OC_PROXY_HOST: PROXY_HOST,
    OC_TARGET_URL: UPSTREAM_URL,
  }
  const proxyScript = absPath('./server.mjs')
  logLauncherLine('info', `Spawning proxy: node ${proxyScript} (OC_TARGET_URL=${UPSTREAM_URL})`)
  proxy = spawn(process.execPath, [proxyScript], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: proxyEnv,
    detached: process.platform !== 'win32',
  })
  if (process.platform !== 'win32') proxy.unref()

  proxy.on('error', (err) => {
    if (shuttingDown) return
    logLauncherLine('error', `Failed to spawn proxy: ${err.message}`)
    ui.setProxyStatus('error')
    shutdown(1, 'proxy spawn failed')
  })

  pipeStream(proxy.stdout, 'proxy', proxyLog, (chunk) => {
    if (proxyReady) return
    if (/Listening on/.test(chunk)) {
      proxyReady = true
      logLauncherLine('ok', `Proxy is up. Open http://${PROXY_HOST}:${PROXY_PORT} in your browser.`)
      ui.setProxyStatus('up')
    }
  })
  pipeStream(proxy.stderr, 'proxy', proxyLog)
  proxy.on('exit', (code, signal) => {
    if (shuttingDown) return
    logLauncherLine('error', `Proxy exited unexpectedly (code=${code}, signal=${signal})`)
    ui.setProxyStatus('down')
    shutdown(3, 'proxy died')
  })
}

async function restart() {
  logLauncherLine('warn', '[r] Restart requested — terminating children and re-running routine…')
  // Kill children but keep the TUI alive.
  if (proxy && proxy.exitCode === null) {
    try { proxy.kill('SIGTERM') } catch {}
  }
  if (upstream && upstream.exitCode === null) {
    try { upstream.kill('SIGTERM') } catch {}
  }
  await wait(1500)
  for (const p of [proxy, upstream]) {
    if (p && p.exitCode === null) {
      try { p.kill('SIGKILL') } catch {}
    }
  }
  proxy = null
  upstream = null
  proxyReady = false
  appendLog(launcherLog, '\n--- restart ---\n')
  await main()
}

// ─── Signal handling ──────────────────────────────────────────────
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0, `received ${sig}`))
}

process.on('SIGBREAK', () => shutdown(0, 'received SIGBREAK'))

process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return
  logLauncherLine('error', `Uncaught exception: ${err.message}`)
  shutdown(1, 'uncaughtException')
})

main().catch((err) => {
  console.error('\n❌ ERROR EN MAIN():', err)
  shutdown(1, 'main() threw')
})
