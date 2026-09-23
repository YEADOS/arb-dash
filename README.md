# arbiter-dash

A local control panel for the arbiter worktrees: run a vite dev server per
worktree, run one shared backend + postgres + redis, and create or delete
worktrees.

```
./start.sh            # http://127.0.0.1:7777
```

No dependencies, no build step — plain Node and a static page. It lives outside
the repo on purpose, so branch switching in any worktree can never touch it.

## What it does

**Status bar** — every live frontend as a clickable chip, plus which worktree
the backend is serving from and whether it is healthy.

**Frontends** — `RUN` / `STOP` / `RESTART` per worktree, each pinned to a stable
port via `--strictPort` so bookmarks stay valid. `LOGS` opens an inline drawer
streaming that server's output.

**Shared services** — one backend and one database, reused by every worktree.
Vite proxies `/api` to `localhost:8000` (see `frontend/vite.config.ts`), so
nothing needs wiring per worktree. `API HERE` moves the backend to a different
worktree; `UP` brings up postgres and redis.

**Worktrees** — create with a branch, a base ref and a dependency strategy;
delete behind a confirmation that reports what you would lose.

## Things worth knowing

**It shows reality, not its own records.** Every poll derives state from `lsof`,
`git worktree list` and `docker compose ps`. Servers you started by hand in a
terminal show up as running and are labelled `EXT`, meaning the panel has no
captured logs for them — restart from here to get logs.

**Dev servers outlive the panel.** Children are spawned detached in their own
process group with output going to a file, so restarting or killing the panel
leaves your dev servers alone. On boot it re-adopts them.

**Compose is pinned to `-p arbiter`.** Compose otherwise names the project after
the working directory, so `docker compose up` from a worktree would build a
second postgres that fails to bind 5432. Every compose call here runs from
`~/arbiter` with the project name fixed.

**The backend is worktree-bound.** `uvicorn --reload` only watches the `backend/`
of the worktree it was launched from. If you edit backend code somewhere else,
nothing reloads — hence the `api` tag in the table and the `API HERE` button.

**Vite is invoked directly, not via pnpm.** `pnpm exec vite` runs a deps-status
check first and, when it decides `node_modules` is stale, tries to purge and
reinstall it — which aborts without a TTY and would destroy a cloned tree. The
panel runs `node_modules/.bin/vite`.

**node_modules cloning uses APFS.** `cp -Rc` from `~/arbiter/frontend` is
copy-on-write: the 561M pnpm tree copies in about a second and costs no extra
disk, and `-R` keeps the `.pnpm` symlinks as symlinks. Falls back to
`pnpm install` if the clone fails.

**Readiness probes check both stacks.** Vite binds `localhost`, which resolves to
`::1` here, so the probe tries `127.0.0.1` and `::1` before declaring failure.

## Safety

Bound to `127.0.0.1` only. This process runs git, docker and shell commands, so
mutations additionally require an `X-Arbiter-Dash: 1` header (which a plain
cross-origin form post cannot set) and the `Host` header is pinned to block DNS
rebinding. Deleting the primary worktree at `~/arbiter` is refused outright.

To reach it from another machine on the tailnet, front it with
`tailscale serve 7777` rather than changing the bind address — that keeps
tailnet ACLs in charge of who gets in.

## Layout

```
server.js          state discovery, process control, HTTP API
public/index.html  markup and the two dialogs
public/app.js      polling, rendering, log streaming
public/style.css   theme tokens; square corners, one muted steel accent
~/.arbiter-dash/   state.json (port assignments, editor) and logs/
```

Overrides: `ARBITER_REPO` (default `~/arbiter`), `ARBITER_DASH_PORT`
(default `7777`).
