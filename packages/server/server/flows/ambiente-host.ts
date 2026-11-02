/**
 * AMBIENTE (F3b) — the host operations behind the engine's `ambiente-subir` / `ambiente-descer` flows.
 *
 * Every op is a mechanism with a refusal; the DECISIONS (order, gates, comments, notices) live in the engine flow. A refusal is
 * `{ refused: true, code, reason, missing }` and always means "nothing was changed by this op". Nothing here deletes a worktree
 * or a branch (only `limpeza-real` does), and nothing stops a process by name or argv: only pids whose environment carries the
 * run's own HOME (`runOwnedPids`). All IO is injected (`AmbienteDeps`) so the invariants are tested against fakes and against
 * `origin --bare` repositories in a tmpdir, never the real store, the real ports or the real configs.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { gitEnv } from '../backup/repo-probe'
import { mcpTargets, type McpTarget } from '../mcp-targets'
import { ancestorCmdlines, isRealAgentopPort, memAvailableBytes, readState, runOwnedPids, stopState, type ThrowawayState } from '../cli-run'
import { heavyLockFds, pidsHoldingHeavyLock, SEED_ALLOW, buildSeed } from '../run-seed'
import { insideHeavyLock, runMinAvailableBytes } from '../resources/mem-guard'

const exec = promisify(execFile)
type Input = Record<string, unknown>
export type AmbienteRefusal = { refused: true; code: string; reason: string; missing: string[] }
const refuse = (code: string, reason: string, missing: string[] = []): AmbienteRefusal => ({ refused: true, code, reason, missing })
const inputOf = (v: unknown): Input => v && typeof v === 'object' ? v as Input : {}
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** The ambiente name: it becomes a branch, a folder, a run name and a unit. */
export const AMBIENTE_NOME = /^[a-z0-9-]{3,32}$/
export const AMBIENTE_MAX = 2
export const AMBIENTE_STATE_WAIT_MS = 20_000
export const AMBIENTE_UP_WAIT_MS = 60_000

export interface AmbienteDeps {
  dataDir: string
  home: string
  env: NodeJS.ProcessEnv
  platform: string
  hasSystemdRun(): boolean
  git(cwd: string, args: string[], timeoutMs?: number): Promise<string>
  registry(): Promise<ReadonlyArray<{ id: string; cwd: string; endedAt?: string; repo?: { repo?: string; rootPath?: string; worktree?: boolean } }>>
  accountRoots(): Promise<ReadonlyArray<{ harness: string; root: string }>>
  memAvailable(): number | null
  ancestors(): string[]
  lockFds(): number[]
  runOwned(home: string): number[]
  pidsWithLock(pids: number[]): number[]
  readState(name: string): ThrowawayState | null
  stopRun(state: ThrowawayState): Promise<void>
  /** Launch `agentop run --rm --serve …` detached, output to `logPath`. Returns the launcher pid. */
  launch(argv: string[], env: NodeJS.ProcessEnv, logPath: string): number | undefined
  fetchVersionOk(port: number): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
}

export function defaultAmbienteDeps(): AmbienteDeps {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return {
    dataDir: process.env.AGENTISTICS_DATA_DIR || join(home, '.agentistics'),
    home,
    env: process.env,
    platform: process.platform,
    hasSystemdRun: () => !!Bun.which('systemd-run'),
    git: async (cwd, args, timeoutMs = 60_000) => (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { timeout: timeoutMs, env: gitEnv() })).stdout,
    registry: async () => (await import('../sessions/registry')).readRegistry(),
    accountRoots: async () => {
      try {
        const doc = JSON.parse(readFileSync(join(process.env.AGENTISTICS_DATA_DIR || join(home, '.agentistics'), 'accounts.json'), 'utf8')) as { accounts?: Array<{ harness?: string; root?: string }> }
        return (doc.accounts ?? []).flatMap(a => a.harness && a.root ? [{ harness: a.harness, root: a.root }] : [])
      } catch { return [] }
    },
    memAvailable: memAvailableBytes,
    ancestors: ancestorCmdlines,
    lockFds: () => heavyLockFds('self'),
    runOwned: h => runOwnedPids(h),
    pidsWithLock: pidsHoldingHeavyLock,
    readState,
    stopRun: stopState,
    launch: (argv, env, logPath) => {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
      const fd = openSync(logPath, 'a', 0o600)
      try {
        const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', fd, fd], detached: true })
        child.unref()
        return child.pid
      } finally { closeSync(fd) }
    },
    fetchVersionOk: async port => { try { return (await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false } },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}

const ambDir = (d: AmbienteDeps, id: string) => join(d.dataDir, 'flows', 'ambientes', id)
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const readOrNull = (p: string): Buffer | null => { try { return readFileSync(p) } catch { return null } }

/** The `ambienteId` of an ambiente name — also the run name. */
export const ambienteId = (nome: string): string => `amb-${nome}`

export function ambienteHostOps(deps: AmbienteDeps = defaultAmbienteDeps()) {
  return {
    /** repo name → its root path, from the registry's recorded repositories (I1: no input is a path). */
    'ambiente-repo': async (value: unknown) => {
      const repo = str(inputOf(value).repo)
      if (!repo) return refuse('AMB_REPO', 'repo is required', ['repo'])
      const rows = await deps.registry().catch(() => [])
      const hit = rows.find(r => r.repo?.repo === repo && r.repo.rootPath)
      if (!hit) return refuse('AMB_REPO', `unknown repository ${repo}`, ['known repository'])
      try { return { ok: true, repo, rootPath: realpathSync(hit.repo!.rootPath!) } } catch { return refuse('AMB_REPO', `repository ${repo} is gone from disk`, ['existing repository']) }
    },

    /** Steps 4–6: ceiling, memory and inherited heavy lock — all before anything is created. */
    'ambiente-preflight': async (value: unknown) => {
      const noAr = Number(inputOf(value).noAr ?? 0)
      if (deps.platform !== 'linux' || !deps.env.XDG_RUNTIME_DIR || !deps.hasSystemdRun()) return refuse('AMB_SEM_TETO', 'no systemd-run scope: the memory ceiling cannot be applied', ['systemd-run --user scope'])
      const avail = deps.memAvailable()
      if (avail !== null && avail < runMinAvailableBytes()) return refuse('AMB_MEMORIA', `only ${(avail / 1024 ** 3).toFixed(1)} GB available`, ['3 GB available memory'])
      if (noAr >= AMBIENTE_MAX) return refuse('AMB_LIMITE', `${noAr} ambientes are already up`, ['a free ambiente slot'])
      if (insideHeavyLock(deps.env, deps.ancestors()) || deps.lockFds().length) return refuse('AMB_LOCK', 'the request came from inside a heavy job', ['request from outside heavy'])
      return { ok: true, availableBytes: avail }
    },

    /** Step 7: B must be an ancestor of origin/main as `ls-remote` reports it now (never a local ref). */
    'ambiente-base': async (value: unknown) => {
      const i = inputOf(value)
      const root = str(i.root)
      const base = str(i.base)
      if (!root) return refuse('AMB_ENTRADA', 'root is required', ['root'])
      if (base && base !== 'main' && !/^[0-9a-f]{7,40}$/i.test(base)) return refuse('AMB_BASE', `${base} is not a sha or main`, ['sha or main'])
      let main: string
      try {
        const out = (await deps.git(root, ['ls-remote', 'origin', 'refs/heads/main'], 30_000)).trim()
        main = out.split(/\s+/)[0] ?? ''
        if (!/^[0-9a-f]{40}$/.test(main)) throw new Error('no main')
        await deps.git(root, ['fetch', 'origin', 'main'], 60_000)
      } catch { return refuse('AMB_REMOTO', 'could not confirm origin/main', ['reachable origin']) }
      let sha: string
      try { sha = (await deps.git(root, ['rev-parse', '--verify', `${!base || base === 'main' ? main : base}^{commit}`])).trim() } catch { return refuse('AMB_BASE', `${base} is not a commit here`, ['existing commit']) }
      try { await deps.git(root, ['merge-base', '--is-ancestor', sha, main]) } catch { return refuse('AMB_BASE', `${sha.slice(0, 9)} is not on main`, ['commit contained in origin/main']) }
      return { ok: true, sha, main, baseEmMain: { ref: 'refs/heads/main', sha: main } }
    },

    /** Step 8: a NEW branch amb/<nome> on a NEW folder, at exactly B. */
    'ambiente-worktree': async (value: unknown) => {
      const i = inputOf(value)
      const root = str(i.root), nome = str(i.nome), sha = str(i.sha)
      if (!root || !AMBIENTE_NOME.test(nome) || !/^[0-9a-f]{40}$/.test(sha)) return refuse('AMB_ENTRADA', 'root, nome and a full sha are required', ['root', 'nome', 'sha'])
      const branch = `amb/${nome}`
      let realRoot: string
      try { realRoot = realpathSync(root) } catch { return refuse('AMB_REPO', 'the repository root is gone', ['existing repository']) }
      const path = join(realRoot, '.worktrees', ambienteId(nome))
      try { await deps.git(realRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return refuse('AMB_BRANCH', `branch ${branch} already exists`, ['unused branch name']) } catch {}
      if (existsSync(path)) return refuse('AMB_PASTA', `${path} already exists`, ['unused folder'])
      try { await deps.git(realRoot, ['worktree', 'add', '-b', branch, path, sha], 120_000) } catch (e) { return refuse('AMB_PASTA', `git could not create the worktree: ${String(e).slice(0, 200)}`, ['creatable worktree']) }
      const listed = await deps.git(realRoot, ['worktree', 'list', '--porcelain']).catch(() => '')
      let realPath: string
      try { realPath = realpathSync(path) } catch { return refuse('AMB_PASTA', 'worktree folder missing after add', ['created worktree']) }
      const head = (await deps.git(realPath, ['rev-parse', 'HEAD']).catch(() => '')).trim()
      if (!inside(realPath, join(realRoot, '.worktrees')) || head !== sha || !listed.split('\n').some(l => l === `worktree ${realPath}`)) return refuse('AMB_PASTA', 'the created worktree does not match the request', ['worktree at base'])
      return { ok: true, worktree: realPath, branch, head, rootPath: realRoot }
    },

    /** Step 9: allow-list copy of the REAL store into a staging dir under the ambiente's own folder. */
    'ambiente-semente': async (value: unknown) => {
      const id = str(inputOf(value).id)
      if (!/^amb-[a-z0-9-]{3,32}$/.test(id)) return refuse('AMB_ENTRADA', 'bad ambiente id', ['id'])
      const staging = join(ambDir(deps, id), 'semente')
      try {
        const copied = buildSeed(deps.dataDir, join(staging, '.agentistics'))
        return { ok: true, staging, copied, allow: [...SEED_ALLOW] }
      } catch (e) { rmSync(staging, { recursive: true, force: true }); return refuse('AMB_SEMENTE', String(e instanceof Error ? e.message : e), ['seed without symlinks']) }
    },

    /** Step 10: copy + sha256 of every config the boot may rewrite (real HOME, real account roots). */
    'ambiente-mcp-antes': async (value: unknown) => {
      const id = str(inputOf(value).id)
      if (!/^amb-[a-z0-9-]{3,32}$/.test(id)) return refuse('AMB_ENTRADA', 'bad ambiente id', ['id'])
      const dir = join(ambDir(deps, id), 'mcp-antes')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const targets = mcpTargets(deps.home, { env: deps.env, accountRoots: await deps.accountRoots() })
      const files = targets.map((t, n) => {
        const buf = readOrNull(t.path)
        if (buf) writeFileSync(join(dir, `${n}.copy`), buf, { mode: 0o600 })
        return { ...t, n, sha256: buf ? sha256(buf) : null }
      })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files }, null, 2), { mode: 0o600 })
      return { ok: true, watched: files.length }
    },

    /** Step 11–12: launch the server, wait for it, and run the checks that must hold once it is up. */
    'ambiente-run': async (value: unknown) => {
      const i = inputOf(value)
      const id = str(i.id), worktree = str(i.worktree), ttl = str(i.ttl) || '2h'
      const nome = id.replace(/^amb-/, '')
      if (!AMBIENTE_NOME.test(nome) || !worktree) return refuse('AMB_ENTRADA', 'id and worktree are required', ['id', 'worktree'])
      const portOffset = i.portOffset === undefined || i.portOffset === null ? null : Number(i.portOffset)
      if (portOffset !== null && (!Number.isInteger(portOffset) || portOffset < 0 || isRealAgentopPort(47291 + portOffset) || isRealAgentopPort(47292 + portOffset))) return refuse('AMB_PORTA', 'that port offset lands on the real agentop ports', ['safe port offset'])
      const comando = Array.isArray(i.comando) ? i.comando.filter((x): x is string => typeof x === 'string') : []
      const staging = i.semente === 'copia' ? join(ambDir(deps, id), 'semente') : null
      const script = process.argv[1]
      const head = script?.endsWith('.ts') || script?.endsWith('.js') ? [process.execPath, script] : [process.execPath]
      const argv = [...head, 'run', '--rm', '--serve', '--name', id, '--ttl', ttl, ...(portOffset !== null ? ['--port-offset', String(portOffset)] : []),
        ...(staging ? ['--seed-from', staging] : []), '--cwd', worktree, ...(comando.length ? ['--', ...comando] : [])]
      const out = join(deps.dataDir, 'flows', 'ambientes', id, 'saida')
      mkdirSync(out, { recursive: true, mode: 0o700 })
      const logPath = join(ambDir(deps, id), 'run.log')
      const env: NodeJS.ProcessEnv = { ...deps.env, AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_AMBIENTE: id, AGENTISTICS_AMBIENTE_OUT: out }
      delete env.AGENTISTICS_HEAVY_JOB
      const launcher = deps.launch(argv, env, logPath)
      const stop = async (s: ThrowawayState | null) => { if (s) await deps.stopRun(s).catch(() => {}) }
      const t0 = deps.now()
      let state: ThrowawayState | null = null
      while (deps.now() - t0 < AMBIENTE_STATE_WAIT_MS && !(state = deps.readState(id))) await deps.sleep(250)
      if (!state) return refuse('AMB_SUBIR', `the run did not register in ${AMBIENTE_STATE_WAIT_MS / 1000}s; see ${logPath}`, ['run state'])
      if (isRealAgentopPort(state.apiPort) || isRealAgentopPort(state.webPort)) { await stop(state); return refuse('AMB_PORTA', `the run got a real agentop port (${state.apiPort}/${state.webPort})`, ['own ports']) }
      let up = false
      while (deps.now() - t0 < AMBIENTE_UP_WAIT_MS && !(up = await deps.fetchVersionOk(state.apiPort))) await deps.sleep(500)
      if (!up) { await stop(state); return refuse('AMB_SUBIR', `the server did not answer in ${AMBIENTE_UP_WAIT_MS / 1000}s; see ${logPath}`, ['responding server']) }
      if (existsSync(join(state.home, '.agentistics', 'structured'))) { await stop(state); return refuse('AMB_STRUCTURED', 'live relays exist in the ambiente store', ['no structured/ dir']) }
      if (deps.pidsWithLock(deps.runOwned(state.home)).length) { await stop(state); return refuse('AMB_LOCK', 'a process of the run holds the heavy lock', ['no heavy lock fd']) }
      return { ok: true, run: { name: state.name, home: state.home, apiPort: state.apiPort, webPort: state.webPort, unit: state.unit ?? null, pid: state.pid ?? launcher ?? null, tmp: state.tmp ?? null }, saida: out, log: logPath }
    },

    /** Step 12 (MCP): rehash; a file that now carries the ambiente's port is restored byte for byte and the run stopped. */
    'ambiente-mcp-depois': async (value: unknown) => {
      const i = inputOf(value)
      const id = str(i.id), apiPort = Number(i.apiPort)
      const waitMs = Math.min(Math.max(Number(i.waitMs ?? 0), 0), 30_000)
      if (!/^amb-[a-z0-9-]{3,32}$/.test(id) || !Number.isInteger(apiPort)) return refuse('AMB_ENTRADA', 'id and apiPort are required', ['id', 'apiPort'])
      const dir = join(ambDir(deps, id), 'mcp-antes')
      let manifest: { files: Array<McpTarget & { n: number; sha256: string | null }> }
      try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) } catch { return refuse('AMB_MCP', 'no sentinel snapshot for this ambiente', ['mcp-antes']) }
      if (waitMs) await deps.sleep(waitMs)
      const restored: string[] = [], changedByOthers: string[] = []
      for (const f of manifest.files) {
        const now = readOrNull(f.path)
        if ((now ? sha256(now) : null) === f.sha256) continue
        if (now && now.toString('utf8').includes(String(apiPort))) {
          if (f.sha256 === null) rmSync(f.path, { force: true })
          else { const tmp = `${f.path}.amb-${process.pid}`; writeFileSync(tmp, readFileSync(join(dir, `${f.n}.copy`)), { mode: 0o600 }); renameSync(tmp, f.path) }
          restored.push(`${f.harness}:${f.path}`)
        } else changedByOthers.push(`${f.harness}:${f.path}`)
      }
      if (changedByOthers.length) { try { writeFileSync(join(ambDir(deps, id), 'diario.log'), `${new Date(deps.now()).toISOString()} changed by others: ${changedByOthers.join(', ')}\n`, { flag: 'a', mode: 0o600 }) } catch {} }
      if (restored.length) {
        const s = deps.readState(id)
        if (s) await deps.stopRun(s).catch(() => {})
        return { ...refuse('AMB_MCP', `the ambiente rewrote real configs: ${restored.join(', ')} (restored)`, ['untouched real configs']), restored, alertOwner: true }
      }
      return { ok: true, restored, changedByOthers }
    },

    /** descer step 5: stop ONLY the registered run (by the name in the engine's record), then confirm. */
    'ambiente-parar': async (value: unknown) => {
      const id = str(inputOf(value).id)
      if (!/^amb-[a-z0-9-]{3,32}$/.test(id)) return refuse('AMB_ENTRADA', 'bad ambiente id', ['id'])
      const s = deps.readState(id)
      if (!s) return { ok: true, servidor: 'ja-parado', porta: [] as number[] }
      await deps.stopRun(s)
      if (deps.runOwned(s.home).length) return refuse('AMB_PARAR', 'processes of the run are still alive', ['stopped run'])
      return { ok: true, servidor: 'parado', porta: [s.apiPort, s.webPort] }
    },

    /** Is the registered run still up? (subir idempotence: `jaNoAr` vs `AMB_ORFAO`.) */
    'ambiente-estado': async (value: unknown) => {
      const id = str(inputOf(value).id)
      if (!/^amb-[a-z0-9-]{3,32}$/.test(id)) return refuse('AMB_ENTRADA', 'bad ambiente id', ['id'])
      const s = deps.readState(id)
      if (!s) return { ok: true, alive: false }
      return { ok: true, alive: await deps.fetchVersionOk(s.apiPort), apiPort: s.apiPort, webPort: s.webPort, home: s.home }
    },

    /** descer gate 3: how many of the RUN's own processes have their cwd inside the worktree (the server itself may), so the gate can discount them. */
    'ambiente-processos-do-run': async (value: unknown) => {
      const i = inputOf(value)
      const home = str(i.home), wt = str(i.worktree)
      if (!home || !wt) return refuse('AMB_ENTRADA', 'home and worktree are required', ['home', 'worktree'])
      const base = (() => { try { return realpathSync(wt) } catch { return wt } })()
      const count = deps.runOwned(home).filter(pid => { try { return inside(realpathSync(`/proc/${pid}/cwd`), base) } catch { return false } }).length
      return { ok: true, count }
    },

    /** Sessions whose cwd is inside the worktree, with their end marks (descer gate 2). */
    'ambiente-sessoes': async (value: unknown) => {
      const wt = str(inputOf(value).worktree)
      if (!wt) return refuse('AMB_ENTRADA', 'worktree is required', ['worktree'])
      const base = (() => { try { return realpathSync(wt) } catch { return wt } })()
      const rows = await deps.registry().catch(() => null)
      if (!rows) return refuse('AMB_PORTOES', 'the session registry could not be read', ['readable registry'])
      const sessions = rows.filter(r => { try { return inside(realpathSync(r.cwd), base) } catch { return inside(r.cwd, base) } }).map(r => ({ id: r.id, ...(r.endedAt ? { endedAt: r.endedAt } : {}) }))
      return { ok: true, sessions }
    },

    /** descer gate 4: a .git directory inside the ambiente HOME (depth ≤ 4) means somebody cloned there. */
    'ambiente-home-sem-repo': async (value: unknown) => {
      const home = str(inputOf(value).home)
      if (!home || !existsSync(home)) return { ok: true }
      const find = (dir: string, depth: number): string | null => {
        if (depth > 4) return null
        let names: string[] = []
        try { names = readdirSync(dir) } catch { return null }
        for (const n of names) {
          const p = join(dir, n)
          if (n === '.git') return p
          try { if (lstatSync(p).isDirectory()) { const hit = find(p, depth + 1); if (hit) return hit } } catch {}
        }
        return null
      }
      const hit = find(home, 0)
      return hit ? refuse('AMB_REPO_NO_HOME', `a git repository lives inside the ambiente home (${hit})`, ['repository saved elsewhere']) : { ok: true }
    },
  }
}
