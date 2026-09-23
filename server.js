#!/usr/bin/env node
'use strict'

// Arbiter control panel.
//
// State is derived from the system on every poll (lsof + git + docker) rather
// than from the dashboard's own bookkeeping. Five vite servers were already
// running when this was written, none of them started here, so anything that
// trusted its own records would have shown them all as stopped and then
// collided on their ports.

const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileP = promisify(execFile)

// ---------------------------------------------------------------- config ---

const HOME = os.homedir()
const REPO = process.env.ARBITER_REPO || path.join(HOME, 'arbiter')
const PORT = Number(process.env.ARBITER_DASH_PORT || 7777)
const HOST = '127.0.0.1'

// Compose derives its project name from the working directory. Left alone, a
// `docker compose up` from arbiter-workbench-restyle-p2 would build a second
// postgres that then fails to bind 5432. Pin it and always run from REPO.
const COMPOSE_PROJECT = 'arbiter'

const STATE_DIR = path.join(HOME, '.arbiter-dash')
const LOG_DIR = path.join(STATE_DIR, 'logs')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

const VITE_PORT_MIN = 5173
const VITE_PORT_MAX = 5210
const BACKEND_PORT = 8000

const PATH_PREFIX = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(HOME, '.local', 'bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]
const ENV = {
  ...process.env,
  PATH: [...new Set([...PATH_PREFIX, ...(process.env.PATH || '').split(':')])]
    .filter(Boolean)
    .join(':'),
}

fs.mkdirSync(LOG_DIR, { recursive: true })

// ----------------------------------------------------------------- state ---

let store = { ports: {}, editor: null }
try {
  store = { ...store, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
} catch {
  /* first run */
}
let saveTimer = null
function saveStore() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(store, null, 2), () => {})
  }, 200)
}

// --------------------------------------------------------------- helpers ---

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const tildeify = (p) => (p && p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p)

async function run(file, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(file, args, {
      env: ENV,
      timeout: opts.timeout ?? 20000,
      maxBuffer: 16 * 1024 * 1024,
      cwd: opts.cwd,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || String(err.message || err),
    }
  }
}

const git = (cwd, ...args) => run('git', ['-C', cwd, ...args])

function logPath(key) {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error('bad log key')
  return path.join(LOG_DIR, `${key}.log`)
}

function appendLog(key, text) {
  fs.appendFile(logPath(key), text, () => {})
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function connects(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

// vite binds `localhost`, which on this machine resolves to ::1 only. Probing
// just 127.0.0.1 reports a healthy server as never having started.
async function portOpen(port, timeout = 400) {
  const r = await Promise.all([
    connects('127.0.0.1', port, timeout),
    connects('::1', port, timeout),
  ])
  return r.some(Boolean)
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await new Promise((r) => setTimeout(r, 350))
  }
  return false
}

async function tailLog(key, lines = 40) {
  try {
    const buf = await fsp.readFile(logPath(key), 'utf8')
    return buf.split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

// ------------------------------------------------------------- discovery ---

// `lsof -Fpn` emits `p<pid>` then one `n<addr>` per listening socket.
async function listeners() {
  const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 8000 })
  const out = []
  let pid = null
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid) {
      const m = line.match(/:(\d+)$/)
      if (m) out.push({ pid, port: Number(m[1]) })
    }
  }
  return out
}

async function procInfo(pids) {
  const map = new Map()
  if (!pids.length) return map

  const list = pids.join(',')
  const cwds = await run('lsof', ['-a', '-p', list, '-d', 'cwd', '-Fpn'], { timeout: 8000 })
  let pid = null
  for (const line of cwds.stdout.split('\n')) {
    if (line[0] === 'p') {
      pid = Number(line.slice(1))
      if (!map.has(pid)) map.set(pid, { pid })
    } else if (line[0] === 'n' && pid) {
      map.get(pid).cwd = line.slice(1)
    }
  }

  const ps = await run('ps', ['-o', 'pid=,pgid=,etime=,command=', '-p', list], { timeout: 8000 })
  for (const line of ps.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const p = Number(m[1])
    if (!map.has(p)) map.set(p, { pid: p })
    Object.assign(map.get(p), { pgid: Number(m[2]), etime: m[3], command: m[4] })
  }
  return map
}

async function gitWorktrees() {
  const { stdout } = await git(REPO, 'worktree', 'list', '--porcelain')
  const out = []
  let cur = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, head: null, detached: false, prunable: false }
      out.push(cur)
    } else if (!cur) continue
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '')
    else if (line === 'detached') cur.detached = true
    else if (line.startsWith('prunable')) cur.prunable = true
  }
  return out
}

// git status is the slowest part of a poll, so it gets its own slower cadence.
const gitCache = new Map()
async function gitStatus(wtPath) {
  const hit = gitCache.get(wtPath)
  if (hit && Date.now() - hit.at < 8000) return hit.value
  const value = { dirty: 0, ahead: 0, behind: 0, upstream: null }
  const st = await git(wtPath, 'status', '--porcelain=v1')
  if (st.code === 0) value.dirty = st.stdout.split('\n').filter(Boolean).length
  const up = await git(wtPath, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  if (up.code === 0) {
    value.upstream = up.stdout.trim()
    const rl = await git(wtPath, 'rev-list', '--left-right', '--count', '@{u}...HEAD')
    if (rl.code === 0) {
      const [behind, ahead] = rl.stdout.trim().split(/\s+/).map(Number)
      value.behind = behind || 0
      value.ahead = ahead || 0
    }
  }
  gitCache.set(wtPath, { at: Date.now(), value })
  return value
}

async function dockerState() {
  const fmt = '{{.Name}}\t{{.State}}\t{{.Health}}\t{{.Publishers}}'
  const res = await run(
    'docker',
    ['compose', '-p', COMPOSE_PROJECT, 'ps', '--all', '--format', fmt],
    { cwd: REPO, timeout: 12000 },
  )
  const services = {}
  if (res.code === 0) {
    for (const line of res.stdout.split('\n').filter(Boolean)) {
      const [name, state, health, pubs] = line.split('\t')
      const key = name.replace(`${COMPOSE_PROJECT}-`, '').replace(/-\d+$/, '')
      // Publishers renders as Go structs: [{0.0.0.0 5432 5432 tcp} {:: 5432 5432 tcp}]
      const ports = [...String(pubs || '').matchAll(/\{\S*\s+(\d+)\s+\d+\s+\w+\}/g)].map((m) => m[1])
      services[key] = {
        name,
        state,
        health: health || '',
        port: ports.find((p) => p !== '0') || null,
      }
    }
  }
  return { ok: res.code === 0, error: res.code === 0 ? null : res.stderr.trim(), services }
}

async function backendHealth() {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/healthcheck`, { signal: ctrl.signal })
    clearTimeout(t)
    const body = await res.json().catch(() => ({}))
    return { reachable: true, status: body.status || (res.ok ? 'healthy' : 'unhealthy'), detail: body }
  } catch {
    return { reachable: false, status: 'down', detail: null }
  }
}

function assignPort(wtPath, taken) {
  if (store.ports[wtPath] && !taken.has(store.ports[wtPath])) return store.ports[wtPath]
  for (let p = VITE_PORT_MIN; p <= VITE_PORT_MAX; p++) {
    if (taken.has(p)) continue
    if (Object.values(store.ports).includes(p) && store.ports[wtPath] !== p) continue
    store.ports[wtPath] = p
    saveStore()
    return p
  }
  return null
}

let stateCache = { at: 0, value: null, inflight: null }

async function buildState() {
  const [wts, lis, docker, health] = await Promise.all([
    gitWorktrees(),
    listeners(),
    dockerState(),
    backendHealth(),
  ])
  const info = await procInfo([...new Set(lis.map((l) => l.pid))])

  const frontends = new Map() // worktree path -> proc
  let backend = null
  const orphans = []
  const takenPorts = new Set(lis.map((l) => l.port))

  for (const { pid, port } of lis) {
    const p = info.get(pid) || {}
    const cmd = p.command || ''
    const cwd = p.cwd || ''
    const isVite = /(^|\/)(vite|node)\b/.test(cmd) && /vite/.test(cmd) && port >= VITE_PORT_MIN
    const isUvicorn = /uvicorn/.test(cmd)

    if (isVite && path.basename(cwd) === 'frontend') {
      const wt = path.dirname(cwd)
      // uvicorn/vite can hold several fds; keep the lowest pid (the parent).
      const prev = frontends.get(wt)
      if (!prev || pid < prev.pid) {
        frontends.set(wt, { pid, pgid: p.pgid, port, etime: p.etime, cwd, command: cmd })
      }
    } else if (isUvicorn) {
      if (!backend || pid < backend.pid) {
        backend = {
          pid,
          pgid: p.pgid,
          port,
          etime: p.etime,
          cwd,
          worktree: path.basename(cwd) === 'backend' ? path.dirname(cwd) : cwd,
          command: cmd,
        }
      }
    }
  }

  const known = new Set(wts.map((w) => w.path))
  for (const [wt, proc] of frontends) {
    if (!known.has(wt)) orphans.push({ kind: 'frontend', worktree: wt, ...proc })
  }

  const worktrees = []
  for (const wt of wts) {
    const proc = frontends.get(wt.path) || null
    const exists = fs.existsSync(wt.path)
    const port = proc ? proc.port : assignPort(wt.path, takenPorts)
    if (proc && store.ports[wt.path] !== proc.port) {
      store.ports[wt.path] = proc.port
      saveStore()
    }
    worktrees.push({
      path: wt.path,
      display: tildeify(wt.path),
      name: path.basename(wt.path),
      branch: wt.branch,
      head: wt.head,
      detached: wt.detached,
      prunable: wt.prunable || !exists,
      exists,
      isPrimary: wt.path === REPO,
      hasNodeModules: exists && fs.existsSync(path.join(wt.path, 'frontend', 'node_modules')),
      hasFrontend: exists && fs.existsSync(path.join(wt.path, 'frontend', 'package.json')),
      hasBackend: exists && fs.existsSync(path.join(wt.path, 'backend', 'pyproject.toml')),
      port,
      url: proc ? `http://localhost:${proc.port}/` : null,
      running: !!proc,
      pid: proc?.pid ?? null,
      uptime: proc?.etime ?? null,
      adopted: proc ? !fs.existsSync(path.join(LOG_DIR, `fe-${path.basename(wt.path)}.log`)) : false,
      logKey: `fe-${path.basename(wt.path)}`,
      ownsBackend: !!backend && backend.worktree === wt.path,
      git: exists ? await gitStatus(wt.path) : null,
    })
  }

  return {
    repo: REPO,
    repoDisplay: tildeify(REPO),
    home: HOME,
    generatedAt: Date.now(),
    worktrees,
    orphans,
    backend: backend
      ? {
          running: true,
          pid: backend.pid,
          port: backend.port,
          uptime: backend.etime,
          worktree: backend.worktree,
          worktreeDisplay: tildeify(backend.worktree),
          worktreeName: path.basename(backend.worktree),
          health,
        }
      : { running: false, health },
    docker,
    editor: store.editor,
  }
}

async function getState({ fresh = false } = {}) {
  if (!fresh && stateCache.value && Date.now() - stateCache.at < 1200) return stateCache.value
  if (stateCache.inflight) return stateCache.inflight
  stateCache.inflight = buildState()
    .then((v) => {
      stateCache = { at: Date.now(), value: v, inflight: null }
      return v
    })
    .catch((e) => {
      stateCache.inflight = null
      throw e
    })
  return stateCache.inflight
}

// --------------------------------------------------------- process control ---

// Spawn detached in its own process group and hand it an append fd, so the
// server can be restarted without taking every dev server down with it, and
// so logs survive on disk either way.
function spawnDetached(cmd, cwd, key) {
  const file = logPath(key)
  const fd = fs.openSync(file, 'a')
  fs.writeSync(fd, `\n=== ${stamp()} :: ${cmd}\n=== cwd ${cwd}\n`)
  const child = spawn('/bin/zsh', ['-lc', cmd], {
    cwd,
    env: ENV,
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  fs.closeSync(fd)
  return child.pid
}

// Run to completion, streaming into a log the UI can watch live.
function runTask(cmd, cwd, key) {
  return new Promise((resolve) => {
    appendLog(key, `\n$ ${cmd}\n`)
    // CI=true: pnpm refuses to purge a modules dir interactively when there is
    // no TTY, and there never is one here.
    const child = spawn('/bin/zsh', ['-lc', cmd], { cwd, env: { ...ENV, CI: 'true' } })
    let out = ''
    const onData = (b) => {
      const s = b.toString()
      out += s
      appendLog(key, s)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => {
      appendLog(key, `[exit ${code}]\n`)
      resolve({ code: code ?? 1, output: out })
    })
    child.on('error', (err) => resolve({ code: 1, output: out + String(err) }))
  })
}

async function killGroup(proc) {
  const pgid = proc.pgid && proc.pgid > 1 ? proc.pgid : null
  const target = pgid && pgid !== process.pid ? -pgid : proc.pid
  try {
    process.kill(target, 'SIGTERM')
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      process.kill(proc.pid, 0)
    } catch {
      return true
    }
  }
  try {
    process.kill(target, 'SIGKILL')
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 400))
  return true
}

async function findProc({ worktree, kind }) {
  const st = await getState({ fresh: true })
  if (kind === 'backend') {
    if (!st.backend.running) return null
    const proc = { pid: st.backend.pid, port: st.backend.port }
    const info = await procInfo([st.backend.pid])
    proc.pgid = info.get(st.backend.pid)?.pgid
    return proc
  }
  const wt = st.worktrees.find((w) => w.path === worktree)
  if (!wt || !wt.running) return null
  const info = await procInfo([wt.pid])
  return { pid: wt.pid, port: wt.port, pgid: info.get(wt.pid)?.pgid }
}

async function startFrontend(worktree) {
  const st = await getState({ fresh: true })
  const wt = st.worktrees.find((w) => w.path === worktree)
  if (!wt) throw new HttpError(404, 'unknown worktree')
  if (wt.running) return { ok: true, note: 'already running', port: wt.port, logKey: wt.logKey }
  if (!wt.exists) throw new HttpError(409, 'worktree directory is missing')
  if (!wt.hasFrontend) throw new HttpError(409, 'no frontend/package.json in this worktree')
  if (!wt.hasNodeModules) {
    throw new HttpError(409, 'frontend/node_modules is missing — install dependencies first')
  }
  const port = wt.port
  if (!port) throw new HttpError(409, 'no free port in the 5173-5210 range')

  // The vite binary directly, not `pnpm exec vite`. pnpm runs a deps-status
  // check first and, when it decides node_modules is stale, tries to purge and
  // reinstall it — which aborts outright without a TTY, and would throw away a
  // freshly cloned tree if it ever succeeded.
  const bin = path.join(worktree, 'frontend', 'node_modules', '.bin', 'vite')
  if (!fs.existsSync(bin)) {
    throw new HttpError(409, 'node_modules/.bin/vite is missing — reinstall dependencies')
  }
  // --strictPort so the URL never silently drifts to the next free port.
  const cmd = `exec ${q(bin)} --port ${port} --strictPort`
  const pid = spawnDetached(cmd, path.join(worktree, 'frontend'), wt.logKey)
  const up = await waitForPort(port, 25000)
  stateCache.at = 0
  if (!up) {
    return {
      ok: false,
      error: `vite did not start listening on ${port} within 25s`,
      logKey: wt.logKey,
      tail: await tailLog(wt.logKey, 40),
    }
  }
  return { ok: true, pid, port, url: `http://localhost:${port}/`, logKey: wt.logKey }
}

async function stopFrontend(worktree) {
  const proc = await findProc({ worktree, kind: 'frontend' })
  if (!proc) return { ok: true, note: 'not running' }
  await killGroup(proc)
  stateCache.at = 0
  return { ok: true }
}

async function startBackend(worktree) {
  const st = await getState({ fresh: true })
  if (st.backend.running) {
    if (st.backend.worktree === worktree) return { ok: true, note: 'already running here' }
    throw new HttpError(409, `backend already running from ${tildeify(st.backend.worktree)}`)
  }
  const wt = st.worktrees.find((w) => w.path === worktree)
  if (!wt?.hasBackend) throw new HttpError(409, 'no backend/pyproject.toml in this worktree')

  const cmd = `exec poetry run uvicorn app.main:app --reload --port ${BACKEND_PORT}`
  const pid = spawnDetached(cmd, path.join(worktree, 'backend'), 'backend')
  const up = await waitForPort(BACKEND_PORT, 60000)
  stateCache.at = 0
  if (!up) {
    return {
      ok: false,
      error: `uvicorn did not start listening on ${BACKEND_PORT} within 60s`,
      logKey: 'backend',
      tail: await tailLog('backend', 40),
    }
  }
  return { ok: true, pid, port: BACKEND_PORT, logKey: 'backend' }
}

async function stopBackend() {
  const proc = await findProc({ kind: 'backend' })
  if (!proc) return { ok: true, note: 'not running' }
  await killGroup(proc)
  stateCache.at = 0
  return { ok: true }
}

// ------------------------------------------------------------- worktrees ---

const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/

function validBranch(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length < 200 &&
    BRANCH_RE.test(name) &&
    !name.includes('..') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock')
  )
}

function slugify(branch) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

async function listBranches() {
  const local = await run('git', [
    '-C', REPO, 'for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads',
  ])
  const remote = await run('git', [
    '-C', REPO, 'for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/remotes/origin',
  ])
  return {
    local: local.stdout.split('\n').filter(Boolean),
    remote: remote.stdout.split('\n').filter(Boolean).filter((b) => b !== 'origin/HEAD'),
  }
}

async function createWorktree({ branch, base, dirName, deps }) {
  const key = 'task'
  if (!validBranch(branch)) throw new HttpError(400, 'invalid branch name')
  if (!validBranch(base)) throw new HttpError(400, 'invalid base ref')

  const dir = dirName && dirName.trim() ? dirName.trim() : `arbiter-${slugify(branch)}`
  if (!/^[A-Za-z0-9._-]+$/.test(dir)) throw new HttpError(400, 'invalid directory name')
  const target = path.join(HOME, dir)
  if (fs.existsSync(target)) throw new HttpError(409, `${tildeify(target)} already exists`)

  appendLog(key, `\n================ ${stamp()} create ${branch} @ ${base} -> ${tildeify(target)}\n`)

  const fetched = await runTask('git fetch origin --prune --quiet', REPO, key)
  if (fetched.code !== 0) appendLog(key, '[warn] fetch failed, continuing with local refs\n')

  const exists = await run('git', ['-C', REPO, 'show-ref', '--verify', `refs/heads/${branch}`])
  const addCmd =
    exists.code === 0
      ? `git worktree add ${q(target)} ${q(branch)}`
      : `git worktree add -b ${q(branch)} ${q(target)} ${q(base)}`

  const added = await runTask(addCmd, REPO, key)
  if (added.code !== 0) {
    return { ok: false, error: 'git worktree add failed', logKey: key, tail: await tailLog(key, 30) }
  }

  const src = path.join(REPO, 'frontend', 'node_modules')
  const dst = path.join(target, 'frontend', 'node_modules')
  let depsNote = 'skipped'

  if (deps === 'clone' && fs.existsSync(src)) {
    // cp -Rc uses APFS clonefile: near-instant and near-zero disk for the
    // 561M pnpm tree, and -R copies the .pnpm symlinks as symlinks so the
    // relative links stay intact.
    const cloned = await runTask(`cp -Rc ${q(src)} ${q(dst)}`, REPO, key)
    if (cloned.code === 0) {
      depsNote = 'cloned (APFS)'
    } else {
      appendLog(key, '[warn] clone failed, falling back to pnpm install\n')
      await runTask(`rm -rf ${q(dst)}`, REPO, key)
      const inst = await runTask('pnpm install', path.join(target, 'frontend'), key)
      depsNote = inst.code === 0 ? 'pnpm install' : 'FAILED'
    }
  } else if (deps === 'install') {
    const inst = await runTask('pnpm install', path.join(target, 'frontend'), key)
    depsNote = inst.code === 0 ? 'pnpm install' : 'FAILED'
  }

  // Untracked-but-needed files a worktree never inherits.
  for (const rel of ['.env', 'backend/.env', 'frontend/.env.local']) {
    const from = path.join(REPO, rel)
    if (fs.existsSync(from)) {
      await runTask(`cp ${q(from)} ${q(path.join(target, rel))}`, REPO, key)
      appendLog(key, `copied ${rel}\n`)
    }
  }

  appendLog(key, `[done] ${tildeify(target)} — deps: ${depsNote}\n`)
  gitCache.clear()
  stateCache.at = 0
  return { ok: true, path: target, deps: depsNote, logKey: key }
}

async function deleteWorktree({ worktree, force, deleteBranch }) {
  const key = 'task'
  if (worktree === REPO) throw new HttpError(400, 'refusing to remove the primary worktree')
  const st = await getState({ fresh: true })
  const wt = st.worktrees.find((w) => w.path === worktree)
  if (!wt) throw new HttpError(404, 'unknown worktree')

  appendLog(key, `\n================ ${stamp()} delete ${tildeify(worktree)}\n`)

  if (wt.running) {
    appendLog(key, 'stopping vite\n')
    await stopFrontend(worktree)
  }
  if (wt.ownsBackend) {
    appendLog(key, 'stopping backend (it was running from this worktree)\n')
    await stopBackend()
  }

  const rm = await runTask(
    `git worktree remove ${force ? '--force ' : ''}${q(worktree)}`,
    REPO,
    key,
  )
  if (rm.code !== 0) {
    return { ok: false, error: 'git worktree remove failed', logKey: key, tail: await tailLog(key, 20) }
  }

  if (deleteBranch && wt.branch) {
    const br = await runTask(`git branch -D ${q(wt.branch)}`, REPO, key)
    if (br.code !== 0) appendLog(key, '[warn] branch delete failed\n')
  }

  await runTask('git worktree prune', REPO, key)
  delete store.ports[worktree]
  saveStore()
  gitCache.delete(worktree)
  stateCache.at = 0
  return { ok: true, logKey: key }
}

// ----------------------------------------------------------------- extras ---

const EDITORS = ['cursor', 'code', 'webstorm', 'zed', 'subl']

async function detectEditor() {
  if (store.editor) return store.editor
  for (const e of EDITORS) {
    const direct = await run('/bin/zsh', ['-lc', `command -v ${e}`])
    if (direct.code === 0 && direct.stdout.trim()) {
      store.editor = e
      saveStore()
      return e
    }
  }
  return null
}

async function openTarget({ worktree, target }) {
  if (!fs.existsSync(worktree)) throw new HttpError(404, 'path does not exist')
  if (target === 'terminal') {
    const r = await run('open', ['-a', 'Terminal', worktree])
    if (r.code !== 0) throw new HttpError(500, r.stderr || 'failed to open Terminal')
    return { ok: true }
  }
  if (target === 'finder') {
    await run('open', [worktree])
    return { ok: true }
  }
  if (target === 'vscode') {
    // `code <folder>` focuses the existing window for that folder if there is
    // one, and opens a new window otherwise — exactly the behavior we want.
    const r = await run('/bin/zsh', ['-lc', `code ${q(worktree)}`])
    if (r.code === 0) return { ok: true, editor: 'code' }
    // `code` CLI not on PATH (shell command never installed) — the app itself
    // deduplicates windows the same way when handed a folder.
    const fallback = await run('open', ['-a', 'Visual Studio Code', worktree])
    if (fallback.code !== 0) {
      throw new HttpError(409, 'VS Code not found — install it or add `code` to PATH')
    }
    return { ok: true, editor: 'open -a' }
  }
  const editor = await detectEditor()
  if (!editor) throw new HttpError(409, 'no supported editor found on PATH')
  const r = await run('/bin/zsh', ['-lc', `${editor} ${q(worktree)}`])
  if (r.code !== 0) throw new HttpError(500, r.stderr || 'editor launch failed')
  return { ok: true, editor }
}

async function killOrphan({ pid }) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 1) throw new HttpError(400, 'bad pid')
  const info = await procInfo([n])
  const p = info.get(n)
  if (!p) throw new HttpError(404, 'no such process')
  if (!/vite|uvicorn/.test(p.command || '')) {
    throw new HttpError(409, 'refusing to kill a process that is not vite or uvicorn')
  }
  await killGroup(p)
  stateCache.at = 0
  return { ok: true }
}

// ------------------------------------------------------------------ http ---

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length })
  res.end(buf)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1e6) reject(new HttpError(413, 'body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new HttpError(400, 'invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

// This process runs git, docker and shell commands. Localhost binding alone
// does not stop a page you have open in another tab from POSTing here, so
// mutations require a header that a simple form post cannot set, and the Host
// header is pinned to block DNS rebinding.
function guard(req) {
  const host = (req.headers.host || '').split(':')[0]
  if (host !== '127.0.0.1' && host !== 'localhost') throw new HttpError(403, 'bad host')
  if (req.method !== 'GET' && req.headers['x-arbiter-dash'] !== '1') {
    throw new HttpError(403, 'missing X-Arbiter-Dash header')
  }
}

function streamLog(req, res, key) {
  let file
  try {
    file = logPath(key)
  } catch {
    return json(res, 400, { error: 'bad log key' })
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  let offset = 0
  try {
    const size = fs.statSync(file).size
    const back = Math.min(size, 64 * 1024)
    offset = size - back
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(back)
    fs.readSync(fd, buf, 0, back, offset)
    fs.closeSync(fd)
    offset = size
    send('chunk', buf.toString('utf8'))
  } catch {
    send('chunk', '(no log yet — start the process to capture output)\n')
  }

  const tick = setInterval(() => {
    let size
    try {
      size = fs.statSync(file).size
    } catch {
      return
    }
    if (size < offset) offset = 0 // truncated
    if (size === offset) return
    try {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(size - offset)
      fs.readSync(fd, buf, 0, buf.length, offset)
      fs.closeSync(fd)
      offset = size
      send('chunk', buf.toString('utf8'))
    } catch {
      /* ignore */
    }
  }, 500)

  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  const close = () => {
    clearInterval(tick)
    clearInterval(ping)
  }
  req.on('close', close)
  res.on('error', close)
}

const ROUTES = {
  'POST /api/frontend/start': (b) => startFrontend(b.worktree),
  'POST /api/frontend/stop': (b) => stopFrontend(b.worktree),
  'POST /api/frontend/restart': async (b) => {
    await stopFrontend(b.worktree)
    return startFrontend(b.worktree)
  },
  'POST /api/backend/start': (b) => startBackend(b.worktree),
  'POST /api/backend/stop': () => stopBackend(),
  'POST /api/backend/move': async (b) => {
    await stopBackend()
    return startBackend(b.worktree)
  },
  'POST /api/docker/up': async () => {
    const r = await runTask(
      `docker compose -p ${COMPOSE_PROJECT} up -d postgres redis`,
      REPO,
      'docker',
    )
    stateCache.at = 0
    return r.code === 0
      ? { ok: true, logKey: 'docker' }
      : { ok: false, error: 'compose up failed', logKey: 'docker', tail: await tailLog('docker', 30) }
  },
  'POST /api/docker/stop': async () => {
    const r = await runTask(`docker compose -p ${COMPOSE_PROJECT} stop postgres redis`, REPO, 'docker')
    stateCache.at = 0
    return { ok: r.code === 0, logKey: 'docker' }
  },
  'POST /api/worktrees/create': (b) => createWorktree(b),
  'POST /api/worktrees/delete': (b) => deleteWorktree(b),
  'POST /api/worktrees/prune': async () => {
    const r = await runTask('git worktree prune -v', REPO, 'task')
    stateCache.at = 0
    return { ok: r.code === 0, logKey: 'task' }
  },
  'POST /api/open': (b) => openTarget(b),
  'POST /api/orphans/kill': (b) => killOrphan(b),
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const route = `${req.method} ${url.pathname}`

  try {
    guard(req)

    if (route === 'GET /api/state') return json(res, 200, await getState({ fresh: url.searchParams.get('fresh') === '1' }))
    if (route === 'GET /api/branches') return json(res, 200, await listBranches())

    const logStream = url.pathname.match(/^\/api\/logs\/([A-Za-z0-9._-]+)\/stream$/)
    if (req.method === 'GET' && logStream) return streamLog(req, res, logStream[1])

    const logTail = url.pathname.match(/^\/api\/logs\/([A-Za-z0-9._-]+)$/)
    if (req.method === 'GET' && logTail) {
      return json(res, 200, { text: await tailLog(logTail[1], Number(url.searchParams.get('n')) || 200) })
    }

    if (ROUTES[route]) {
      const body = await readBody(req)
      const out = await ROUTES[route](body)
      return json(res, out && out.ok === false ? 200 : 200, out)
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const file = path.join(__dirname, 'public', rel)
      if (!file.startsWith(path.join(__dirname, 'public'))) throw new HttpError(403, 'nope')
      const data = await fsp.readFile(file).catch(() => null)
      if (!data) throw new HttpError(404, 'not found')
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      return res.end(data)
    }

    throw new HttpError(404, 'not found')
  } catch (err) {
    const status = err.status || 500
    if (!res.headersSent) json(res, status, { ok: false, error: err.message || 'server error' })
    else res.end()
  }
})

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `arbiter control panel\n` +
      `  http://${HOST}:${PORT}\n` +
      `  repo    ${tildeify(REPO)}\n` +
      `  state   ${tildeify(STATE_DIR)}\n`,
  )
})
