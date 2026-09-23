'use strict'

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

// ------------------------------------------------------------------ theme ---

const prefersDark = matchMedia('(prefers-color-scheme: dark)')
function applyTheme(t) {
  document.documentElement.dataset.theme = t
  $('#theme-toggle').textContent = t === 'dark' ? 'LIGHT' : 'DARK'
  localStorage.setItem('arbiter-dash-theme', t)
}
applyTheme(localStorage.getItem('arbiter-dash-theme') || (prefersDark.matches ? 'dark' : 'light'))
$('#theme-toggle').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')

// ------------------------------------------------------------------- api ----

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body
      ? { 'content-type': 'application/json', 'x-arbiter-dash': '1' }
      : { 'x-arbiter-dash': '1' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}

// ps etime comes as [[dd-]hh:]mm:ss — too wide for a table cell.
function shortUptime(etime) {
  if (!etime) return ''
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return etime
  const [, d, h, mi] = m
  if (d) return `${Number(d)}d ${Number(h || 0)}h`
  if (h) return `${Number(h)}h ${Number(mi)}m`
  return `${Number(mi)}m`
}

function toast(text, kind = 'info', ms = 5000) {
  const t = el('div', `toast ${kind}`, text)
  $('#toasts').append(t)
  setTimeout(() => t.remove(), ms)
}

// ------------------------------------------------------------------ state ---

let state = null
const busy = new Set()
const openLogs = new Map() // key -> {wrap, pre, es}

async function refresh(fresh = false) {
  try {
    state = await api(`/api/state${fresh ? '?fresh=1' : ''}`)
    $('#pulse').classList.add('on')
    setTimeout(() => $('#pulse').classList.remove('on'), 300)
    render()
  } catch (err) {
    $('#pulse').classList.remove('on')
  }
}

// Wrap an action so the clicked button shows a spinner and the view refetches.
function act(btn, key, fn) {
  if (busy.has(key)) return
  busy.add(key)
  btn.classList.add('busy')
  btn.disabled = true
  Promise.resolve(fn())
    .then((r) => {
      if (r && r.ok === false) {
        toast(`${r.error}\n${(r.tail || '').split('\n').slice(-6).join('\n')}`.trim(), 'err', 12000)
        if (r.logKey) openLog(r.logKey)
      } else if (r && r.note) {
        toast(r.note, 'info')
      }
    })
    .catch((e) => toast(String(e.message || e), 'err', 9000))
    .finally(() => {
      busy.delete(key)
      refresh(true)
    })
}

// ------------------------------------------------------------------- logs ---

function makeLogDrawer(key, title) {
  const wrap = el('div', 'logwrap')
  const head = el('div', 'log-head')
  head.append(el('span', null, title))
  const spacer = el('span', 'spacer')
  head.append(spacer)

  const follow = el('button', 'btn btn-sm', 'FOLLOW: ON')
  let following = true
  follow.onclick = () => {
    following = !following
    follow.textContent = `FOLLOW: ${following ? 'ON' : 'OFF'}`
  }
  const close = el('button', 'btn btn-sm', 'CLOSE')
  close.onclick = () => closeLog(key)
  head.append(follow, close)

  const pre = el('pre', 'log')
  wrap.append(head, pre)

  const es = new EventSource(`/api/logs/${key}/stream`)
  es.addEventListener('chunk', (ev) => {
    pre.append(document.createTextNode(JSON.parse(ev.data)))
    // Cap the buffer so a chatty vite server does not grow the DOM forever.
    if (pre.textContent.length > 400000) pre.textContent = pre.textContent.slice(-200000)
    if (following) pre.scrollTop = pre.scrollHeight
  })
  es.onerror = () => {}

  return { wrap, pre, es }
}

function openLog(key, title) {
  if (openLogs.has(key)) return
  openLogs.set(key, makeLogDrawer(key, title || key))
  render()
}

function closeLog(key) {
  const d = openLogs.get(key)
  if (!d) return
  d.es.close()
  d.wrap.remove()
  openLogs.delete(key)
}

function toggleLog(key, title) {
  openLogs.has(key) ? closeLog(key) : openLog(key, title)
}

// --------------------------------------------------------------- rendering ---

// Simple Icons "Visual Studio Code" glyph; fill follows currentColor so the
// busy-spinner state (color: transparent) hides it along with the label.
const VSCODE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>'

function btn(label, cls, onClick, opts = {}) {
  const b = el('button', `btn btn-sm ${cls || ''}`.trim(), label)
  if (opts.icon) b.insertAdjacentHTML('afterbegin', opts.icon)
  if (opts.title) b.title = opts.title
  if (opts.disabled) b.disabled = true
  if (busy.has(opts.key)) {
    b.classList.add('busy')
    b.disabled = true
  }
  b.onclick = () => act(b, opts.key || label, onClick)
  return b
}

function renderLivebar() {
  const bar = $('#livebar')
  bar.textContent = ''
  const live = state.worktrees.filter((w) => w.running)

  if (state.backend?.running) {
    const h = state.backend.health
    const chip = el('span', 'chip')
    chip.append(
      el('span', `dot ${h.status === 'healthy' ? 'ok' : h.reachable ? 'warn' : 'err'}`),
      el('b', null, 'api'),
      el('span', 'port', `:${state.backend.port}`),
      el('span', null, state.backend.worktreeName),
    )
    chip.title = `uvicorn --reload from ${state.backend.worktreeDisplay}/backend`
    bar.append(chip)
  }

  if (!live.length) {
    bar.append(el('span', 'chip-empty', 'no frontends running'))
    return
  }
  for (const w of live) {
    const a = el('a', 'chip')
    a.href = w.url
    a.target = '_blank'
    a.rel = 'noreferrer'
    a.append(el('span', 'dot ok'), el('b', null, w.name), el('span', 'port', `:${w.port}`))
    a.title = `${w.display} — pid ${w.pid}, up ${w.uptime}`
    bar.append(a)
  }
}

function renderServices() {
  const host = $('#services')
  host.textContent = ''

  // --- backend ---
  const be = state.backend
  const row = el('div', 'svc')
  const name = el('div', 'svc-name')
  const h = be.health
  name.append(
    el('span', `dot ${be.running ? (h.status === 'healthy' ? 'ok' : 'warn') : ''}`),
    el('span', null, 'backend'),
  )
  row.append(name)
  row.append(
    el(
      'span',
      `state ${be.running ? (h.status === 'healthy' ? 'ok' : 'warn') : ''}`,
      be.running ? (h.status === 'healthy' ? 'healthy' : h.reachable ? h.status : 'starting') : 'stopped',
    ),
  )
  row.append(
    el(
      'span',
      'svc-meta',
      be.running
        ? `uvicorn --reload :${be.port} · ${be.worktreeDisplay}/backend · pid ${be.pid} · up ${shortUptime(be.uptime)}`
        : `not running — start it from a worktree below; every vite proxies /api to :8000`,
    ),
  )
  const beActions = el('div', 'svc-actions')
  if (be.running) {
    beActions.append(btn('STOP', '', () => api('/api/backend/stop', {}), { key: 'be-stop' }))
  }
  beActions.append(
    btn('LOGS', 'btn-ghost', () => toggleLog('backend', 'backend · uvicorn'), { key: 'be-logs' }),
  )
  row.append(beActions)
  host.append(row)
  if (openLogs.has('backend')) host.append(openLogs.get('backend').wrap)

  // --- docker ---
  const d = state.docker
  for (const svc of ['postgres', 'redis']) {
    const s = d.services[svc]
    const up = s && s.state === 'running'
    const r = el('div', 'svc')
    const n = el('div', 'svc-name')
    n.append(el('span', `dot ${up ? (s.health === 'unhealthy' ? 'warn' : 'ok') : ''}`), el('span', null, svc))
    r.append(n)
    r.append(el('span', `state ${up ? 'ok' : ''}`, s ? s.state : 'absent'))
    r.append(
      el(
        'span',
        'svc-meta',
        s
          ? `${s.name}${s.port ? ` · :${s.port}` : ''}${s.health ? ` · ${s.health}` : ''}`
          : `no container in compose project "arbiter"`,
      ),
    )
    r.append(el('div', 'svc-actions'))
    host.append(r)
  }

  const ctl = el('div', 'svc')
  const ctlName = el('div', 'svc-name')
  ctlName.append(el('span', 'dot'), el('span', 'muted', 'compose'))
  ctl.append(ctlName, el('span', 'state'), el('span', 'svc-meta',
    d.ok ? `-p arbiter · always run from ${state.repoDisplay}` : `docker error: ${d.error || 'unavailable'}`))
  const dActions = el('div', 'svc-actions')
  dActions.append(
    btn('UP', 'btn-primary', () => api('/api/docker/up', {}), { key: 'dk-up', title: 'docker compose -p arbiter up -d postgres redis' }),
    btn('STOP', '', () => api('/api/docker/stop', {}), { key: 'dk-stop' }),
    btn('LOGS', 'btn-ghost', () => toggleLog('docker', 'docker compose'), { key: 'dk-logs' }),
  )
  ctl.append(dActions)
  host.append(ctl)
  if (openLogs.has('docker')) host.append(openLogs.get('docker').wrap)
  if (openLogs.has('task')) host.append(openLogs.get('task').wrap)
}

function renderWorktrees() {
  const host = $('#worktrees')
  host.textContent = ''

  for (const w of state.worktrees) {
    const row = el('div', `row${w.running ? ' is-running' : ''}${w.exists ? '' : ' is-missing'}`)

    // name
    const nameCell = el('div', 'wt-name')
    nameCell.append(el('span', `dot ${w.running ? 'ok' : ''}`))
    const b = el('b', null, w.name)
    b.title = w.display
    nameCell.append(b)
    if (w.isPrimary) nameCell.append(el('span', 'tag accent', 'primary'))
    if (w.ownsBackend) nameCell.append(el('span', 'tag ok', 'api'))
    if (!w.exists) nameCell.append(el('span', 'tag', 'missing'))
    else if (w.prunable) nameCell.append(el('span', 'tag', 'prunable'))
    row.append(nameCell)

    // branch
    row.append(el('div', 'wt-branch', w.detached ? `detached @ ${w.head}` : w.branch || w.head))

    // git
    const g = el('div', 'wt-git')
    if (w.git) {
      g.append(el('span', w.git.dirty ? 'dirty' : '', w.git.dirty ? `●${w.git.dirty}` : 'clean'))
      if (w.git.ahead) g.append(el('span', 'ahead', `↑${w.git.ahead}`))
      if (w.git.behind) g.append(el('span', 'behind', `↓${w.git.behind}`))
      if (!w.git.upstream) g.append(el('span', '', 'no upstream'))
    }
    row.append(g)

    // frontend
    const fe = el('div', 'wt-fe')
    if (w.running) {
      const a = el('a', null, `localhost:${w.port}`)
      a.href = w.url
      a.target = '_blank'
      a.rel = 'noreferrer'
      const up = el('span', 'uptime', shortUptime(w.uptime))
      up.title = `pid ${w.pid} · up ${w.uptime}`
      fe.append(a, up)
      if (w.adopted) {
        const t = el('span', 'tag', 'ext')
        t.title = 'Started outside the dashboard — no captured logs. Restart to capture them.'
        fe.append(t)
      }
    } else if (!w.exists) {
      fe.append(el('span', 'off', 'directory gone'))
    } else if (!w.hasNodeModules) {
      fe.append(el('span', 'off', 'no node_modules'))
    } else {
      fe.append(el('span', 'off', `stopped · :${w.port ?? '—'}`))
    }
    row.append(fe)

    // actions
    const acts = el('div', 'wt-actions')
    if (w.exists && w.hasFrontend) {
      if (w.running) {
        acts.append(
          btn('STOP', '', () => api('/api/frontend/stop', { worktree: w.path }), { key: `stop-${w.path}` }),
          btn('RESTART', '', () => api('/api/frontend/restart', { worktree: w.path }), { key: `re-${w.path}` }),
        )
      } else {
        acts.append(
          btn('RUN', 'btn-primary', () => api('/api/frontend/start', { worktree: w.path }), {
            key: `run-${w.path}`,
            disabled: !w.hasNodeModules,
            title: w.hasNodeModules ? `pnpm exec vite --port ${w.port} --strictPort` : 'install dependencies first',
          }),
        )
      }
      acts.append(
        btn('LOGS', 'btn-ghost', () => toggleLog(w.logKey, `${w.name} · vite`), { key: `log-${w.path}` }),
      )
    }
    if (w.exists && w.hasBackend && !w.ownsBackend) {
      acts.append(
        btn(state.backend.running ? 'API HERE' : 'START API', 'btn-ghost', () =>
          api(state.backend.running ? '/api/backend/move' : '/api/backend/start', { worktree: w.path }),
        { key: `api-${w.path}`, title: state.backend.running
            ? `stop uvicorn in ${state.backend.worktreeName} and restart it here`
            : 'poetry run uvicorn app.main:app --reload' }),
      )
    }
    if (w.exists) {
      acts.append(
        btn('VS CODE', 'btn-vscode', () => api('/api/open', { worktree: w.path, target: 'vscode' }), {
          key: `vs-${w.path}`,
          icon: VSCODE_ICON,
          title: 'Open in VS Code — focuses the existing window for this folder, or opens a new one',
        }),
        btn('EDIT', 'btn-ghost', () => api('/api/open', { worktree: w.path, target: 'editor' }), { key: `ed-${w.path}` }),
        btn('TERM', 'btn-ghost', () => api('/api/open', { worktree: w.path, target: 'terminal' }), { key: `tm-${w.path}` }),
      )
    }
    if (!w.isPrimary) {
      const del = el('button', 'btn btn-sm btn-danger', 'DEL')
      del.onclick = () => askDelete(w)
      acts.append(del)
    }
    row.append(acts)

    host.append(row)

    if (openLogs.has(w.logKey)) {
      const lr = el('div', 'logrow')
      lr.append(openLogs.get(w.logKey).wrap)
      host.append(lr)
    }
  }
}

function renderOrphans() {
  const panel = $('#orphan-panel')
  const host = $('#orphans')
  host.textContent = ''
  const list = state.orphans || []
  panel.hidden = list.length === 0
  for (const o of list) {
    const r = el('div', 'orphan')
    r.append(el('span', 'dot warn'))
    r.append(el('span', 'path', `${o.worktree} · :${o.port} · pid ${o.pid} · up ${o.etime}`))
    r.append(btn('KILL', 'btn-danger', () => api('/api/orphans/kill', { pid: o.pid }), { key: `orph-${o.pid}` }))
    host.append(r)
  }
}

function render() {
  if (!state) return
  renderLivebar()
  renderServices()
  renderWorktrees()
  renderOrphans()
}

// ------------------------------------------------------------- create form ---

const dlgCreate = $('#dlg-create')
let branches = { local: [], remote: [] }

$('#btn-new').onclick = async () => {
  try {
    branches = await api('/api/branches')
  } catch {
    branches = { local: [], remote: [] }
  }
  $('#branch-list').textContent = ''
  for (const b of branches.local) $('#branch-list').append(new Option(b))
  $('#base-list').textContent = ''
  for (const b of [...branches.remote, ...branches.local]) $('#base-list').append(new Option(b))
  $('#f-branch').value = ''
  $('#f-dir').value = ''
  $('#f-base').value = branches.remote.includes('origin/main') ? 'origin/main' : 'main'
  $('#f-deps').value = 'clone'
  updateCreateHints()
  dlgCreate.showModal()
  $('#f-branch').focus()
}

function slugify(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function updateCreateHints() {
  const branch = $('#f-branch').value.trim()
  const exists = branches.local.includes(branch)
  $('#f-branch-note').textContent = !branch
    ? 'A new branch. Type an existing name to check it out instead.'
    : exists
      ? 'Branch already exists — it will be checked out, base ignored.'
      : `New branch, created from the base below.`
  $('#f-dir-note').textContent = `~/${$('#f-dir').value.trim() || `arbiter-${slugify(branch) || '<branch>'}`}`
  $('#f-create').disabled = !branch
}
$('#f-branch').addEventListener('input', updateCreateHints)
$('#f-dir').addEventListener('input', updateCreateHints)

dlgCreate.addEventListener('close', async () => {
  if (dlgCreate.returnValue !== 'ok') return
  const payload = {
    branch: $('#f-branch').value.trim(),
    base: $('#f-base').value.trim() || 'origin/main',
    dirName: $('#f-dir').value.trim(),
    deps: $('#f-deps').value,
  }
  if (!payload.branch) return
  openLog('task', 'worktree task')
  toast(`creating ${payload.branch}…`, 'info', 3000)
  try {
    const r = await api('/api/worktrees/create', payload)
    if (r.ok) toast(`created ${r.path}\ndeps: ${r.deps}`, 'ok', 8000)
    else toast(`${r.error}\n${(r.tail || '').split('\n').slice(-6).join('\n')}`, 'err', 14000)
  } catch (e) {
    toast(String(e.message || e), 'err', 10000)
  }
  refresh(true)
})

// ------------------------------------------------------------- delete form ---

const dlgDelete = $('#dlg-delete')
let deleteTarget = null

function askDelete(w) {
  deleteTarget = w
  $('#d-target').textContent = `${w.display}  ·  ${w.branch || w.head}`
  $('#d-branch-name').textContent = w.branch || '(detached)'
  $('#d-confirm-name').textContent = w.name
  $('#d-force').checked = false
  $('#d-branch').checked = false
  $('#d-branch').disabled = !w.branch
  $('#d-confirm').value = ''

  const warn = $('#d-warn')
  warn.textContent = ''
  const notes = []
  if (w.git?.dirty) notes.push(`${w.git.dirty} uncommitted change(s) will be lost — force required.`)
  if (w.git?.ahead) notes.push(`${w.git.ahead} commit(s) not pushed to ${w.git.upstream || 'any remote'}.`)
  if (!w.git?.upstream) notes.push('Branch has no upstream — commits exist only here.')
  if (w.running) notes.push(`vite on :${w.port} will be stopped first.`)
  if (w.ownsBackend) notes.push('The backend is running from this worktree and will be stopped.')
  for (const n of notes) warn.append(el('div', 'warnbox', n))

  updateDeleteGate()
  dlgDelete.showModal()
}

function updateDeleteGate() {
  if (!deleteTarget) return
  const risky = !!deleteTarget.git?.dirty || !!deleteTarget.git?.ahead
  const wrap = $('#d-confirm-wrap')
  wrap.hidden = !risky
  const typed = $('#d-confirm').value.trim() === deleteTarget.name
  const forced = !deleteTarget.git?.dirty || $('#d-force').checked
  $('#d-go').disabled = (risky && !typed) || !forced
}
$('#d-confirm').addEventListener('input', updateDeleteGate)
$('#d-force').addEventListener('change', updateDeleteGate)

dlgDelete.addEventListener('close', async () => {
  if (dlgDelete.returnValue !== 'ok' || !deleteTarget) return
  const w = deleteTarget
  openLog('task', 'worktree task')
  try {
    const r = await api('/api/worktrees/delete', {
      worktree: w.path,
      force: $('#d-force').checked,
      deleteBranch: $('#d-branch').checked,
    })
    if (r.ok) toast(`removed ${w.name}`, 'ok')
    else toast(`${r.error}\n${(r.tail || '').split('\n').slice(-6).join('\n')}`, 'err', 14000)
  } catch (e) {
    toast(String(e.message || e), 'err', 10000)
  }
  deleteTarget = null
  refresh(true)
})

$('#btn-prune').onclick = (ev) =>
  act(ev.currentTarget, 'prune', async () => {
    openLog('task', 'worktree task')
    return api('/api/worktrees/prune', {})
  })

// ------------------------------------------------------------------- boot ---

refresh(true)
setInterval(() => {
  if (!document.hidden) refresh()
}, 2500)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh(true)
})
