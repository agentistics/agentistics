/**
 * DOCKER.AMBIENTES S2 — `agentop run --rm -- <cmd>` with the docker backend: one disposable container per command
 * (SPEC-r3 §3.3). The order is fixed and every step can refuse:
 *
 *   identity (§3.1) → admission (ledger, memory) → volumes with proven identity (§3.2) → catalogue image checked
 *   (§3.4) → masks recomputed (§5.2) → `docker create` (never started) → `docker inspect` against the plan
 *   → only then `docker start -a`.
 *
 * Nothing of the image executes before the inspect matched. A signal or the TTL ends the COMMAND by
 * `docker kill --signal TERM <id>`, 10 s, `docker kill <id>`: everything in the container dies (a `setsid` child
 * included — it is in the container's cgroup and pid namespace), and another command is another container. A dead
 * launcher is covered by the TTL that `exec-wrap` applies INSIDE.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { EnvImage } from '@agentistics/core'
import { buildCreateArgv, type ContainerPlan, type MountSpec } from './docker-argv'
import { docker, dockerAttached, parseJson, DockerRefusal } from './docker-cli'
import { containerEnv, envFileText } from './container-env'
import { imageForProfile, PROFILE_REL } from './env-profile'
import { containerProblems, imageProblems, nmWritableRefusal } from './inspect-check'
import { admissionRefusal, dockerDir, emptySession, installId, newAttemptId, readLedger, withLedger, type SessionEntry, type VolumeRecord } from './ledger'
import { maskMounts, MASK_TEXT_LIMIT, type WorktreeEntry } from './masks'
import { containerPlan, initPlan, nmSlots, nmSubdirs, readMarkerPlan, scratchSubdirs, type NmSlot, type SessionVolumes } from './plans'
import { EXEC_WRAP_SH, FWD_MJS, exitWords } from './scripts'
import { proposedSessionId, procReader, proveAncestry, structuredRoots, tmuxRoots, type ProcReader } from './session-proof'
import { afterCreate, beforeCreate, markerMatches } from './volume-identity'
import { DISK_WATCH_EVERY_MS, diskVerdict, SESSION_DISK_MAX_BYTES, DOCKER_FREE_FLOOR_BYTES, volumeSizes } from './disk-watch'

export const GIB = 1024 ** 3

export interface DockerRunInput {
  command: string[]
  cwd: string
  ttlSec: number
  dataDir: string
  env: Record<string, string | undefined>
  /** Overridable for tests. */
  self?: number
  read?: ProcReader
  tmuxPanes?: () => string
  memAvailable?: () => number | null
  memTotal?: () => number | null
  diskEveryMs?: number
  diskLimits?: { sessionMax: number; freeFloor: number }
  /** `cmd` (default) or one of the install phases. */
  kind?: 'cmd' | 'install-download' | 'install-scripts'
  sockDir?: string
  /** install-download: the host-generated staging directory mounted (read-only) in place of the worktree. */
  stagingDir?: string
  /** For install: the target nm generation and volume (created by the caller). */
  nmOverride?: string
  /** Lower the admitted memory (live proofs force an OOM with a small cap). Never raises it. */
  memoryBytes?: number
  log?: (line: string) => void
}

export type DockerRunOutcome =
  | { ran: true; code: number; sessionId: string; perRun: boolean; containerId: string }
  /** Did not run in Docker: the caller falls back to the namespace backend and prints `reason`. */
  | { ran: false; fallback: true; reason: string }
  /** Refused outright (memory, cleaning, identity of a volume): nothing ran. */
  | { ran: false; fallback: false; code: number; reason: string }

const prefixOf = (env: Record<string, string | undefined>) => {
  const p = env.AGENTISTICS_DOCKER_PREFIX || 'agentistics'
  return /^agentistics(-[a-z0-9-]+)?$/.test(p) ? p : 'agentistics'
}
const hex = (n: number) => randomBytes(n).toString('hex')

/** Any non-success of a git call (exit code, timeout, killed by the buffer limit) is `null` — never a partial stdout. */
function hostGit(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 })
  return r.status === 0 && !r.error && !r.signal ? r.stdout : null
}

/**
 * The worktree root (bind-mounted at the same absolute path) and whether a `.git` DIRECTORY sits inside it.
 * `null` when `cwd` is not inside a git worktree: the root would then be the cwd itself (or `~`), mounted with no
 * masks at all — never done; the caller stays in the namespace backend (SPEC §5.2: HOME and `~/.ssh` never enter).
 */
export function worktreeOf(cwd: string): { root: string; gitDirInTree: boolean } | null {
  const top = hostGit(cwd, ['rev-parse', '--show-toplevel'])?.trim()
  if (!top || !top.startsWith('/')) return null
  let gitDirInTree = false
  try { gitDirInTree = statSync(join(top, '.git')).isDirectory() } catch {}
  return { root: top, gitDirInTree }
}

/** The listing the masks depend on could not be produced: the command is refused, never run with an empty mask list. */
export class MaskListingError extends Error {}

/**
 * Untracked + ignored entries outside node_modules, with the head of small files (for the content rules), and the
 * directories `git ls-files --others` does not walk: nested repositories / nested worktrees (reported as `dir/`) and
 * submodules (gitlinks, mode 160000). A failed listing THROWS (fail closed).
 */
export function worktreeEntries(root: string): { entries: WorktreeEntry[]; foreignDirs: string[] } {
  const out = hostGit(root, ['ls-files', '--others', '-z', '--exclude=node_modules', '--', '.'])
  const staged = hostGit(root, ['ls-files', '--stage', '-z'])
  if (out === null || staged === null) throw new MaskListingError('git ls-files failed (exit, timeout or output limit): the credential masks cannot be computed')
  const foreignDirs = new Set<string>()
  for (const rec of staged.split('\0').filter(Boolean)) {
    const m = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(rec)
    if (m && existsSync(join(root, m[1]!))) foreignDirs.add(m[1]!)
  }
  const entries: WorktreeEntry[] = []
  for (const path of out.split('\0').filter(Boolean)) {
    if (path.endsWith('/')) { foreignDirs.add(path.replace(/\/+$/, '')); continue }
    if (path.split('/').includes('node_modules')) continue
    let head: string | undefined
    try {
      const st = statSync(join(root, path))
      if (st.isFile() && st.size <= MASK_TEXT_LIMIT) head = readFileSync(join(root, path), 'utf8')
    } catch {}
    entries.push({ path, head })
  }
  return { entries, foreignDirs: [...foreignDirs].sort() }
}

export const nodeModulesPath = (root: string, s: NmSlot): string => join(root, s.rel, 'node_modules')

/**
 * r4 cut #1: every `node_modules` that becomes a mount point must be ABSENT or EMPTY on the host (lstat, symlinks
 * are never followed). Anything else — files, a symlink, a directory with entries — would be hidden by the volume
 * and later looked at by a cleanup as "only a mount point": `nm_host_nao_vazio`, the worktree stays in the
 * namespace backend. Nothing is created unless every point passed; what is created is returned for the ledger.
 */
export function admitMountPoints(root: string, slots: readonly NmSlot[]): { ok: true; created: string[] } | { ok: false; code: 'nm_host_nao_vazio'; path: string } {
  const toCreate: string[] = []
  for (const s of slots) {
    const p = nodeModulesPath(root, s)
    let st
    try { st = lstatSync(p) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { toCreate.push(p); continue }
      return { ok: false, code: 'nm_host_nao_vazio', path: p }
    }
    if (!st.isDirectory() || st.isSymbolicLink() || readdirSync(p).length > 0) return { ok: false, code: 'nm_host_nao_vazio', path: p }
  }
  const created: string[] = []
  for (const p of toCreate) { mkdirSync(p); created.push(p) }
  return { ok: true, created }
}

/** Admission of the worktree for the docker backend; records the mount points agentop created (ledger `mountpoints`). */
export function admitWorktree(dataDir: string, sid: string, perRun: boolean, root: string, slots: readonly NmSlot[]): string | null {
  const a = admitMountPoints(root, slots)
  if (!a.ok) return `nm_host_nao_vazio: ${a.path} has content on the host and a volume would hide it. This worktree stays in the isolated namespace.`
  if (a.created.length) withLedger(dataDir, l => {
    const s = l.sessions[sid] ??= emptySession(perRun, new Date().toISOString())
    s.mountpoints = [...new Set([...(s.mountpoints ?? []), ...a.created])]
  })
  return null
}

/** The `node_modules` slots: root + each workspace directory that exists (globs ending in `/*` expanded). */
export function workspaceSlots(root: string): NmSlot[] {
  let ws: string[] = []
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const raw = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : []
    for (const w of raw as string[]) {
      if (typeof w !== 'string' || w.includes('..')) continue
      if (w.endsWith('/*')) {
        const base = w.slice(0, -2)
        try { for (const d of readdirSync(join(root, base), { withFileTypes: true })) if (d.isDirectory() && existsSync(join(root, base, d.name, 'package.json'))) ws.push(`${base}/${d.name}`) } catch {}
      } else if (!/[*?]/.test(w) && existsSync(join(root, w, 'package.json'))) ws.push(w)
    }
  } catch {}
  return nmSlots(ws)
}

/** Write agentop's own helpers (exec-wrap, fwd.mjs) to `<dataDir>/docker/opt`, mounted read-only. */
export function ensureOpt(dataDir: string): string {
  const dir = join(dockerDir(dataDir), 'opt')
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  chmodSync(dir, 0o755)
  for (const [name, body] of [['exec-wrap', EXEC_WRAP_SH], ['fwd.mjs', FWD_MJS]] as const) {
    const p = join(dir, name)
    let same = false
    try { same = readFileSync(p, 'utf8') === body } catch {}
    if (!same) { try { chmodSync(p, 0o644) } catch {}; writeFileSync(p, body) }
    chmodSync(p, 0o555)
  }
  return dir
}

/** §11.2: M = min(6 GiB, MemAvailable − 3 GiB); M < 2 GiB refuses; our live containers + M ≤ MemTotal − 4 GiB. */
export function memoryAdmission(available: number | null, total: number | null, liveSum: number): { ok: true; bytes: number } | { ok: false; reason: string } {
  if (available === null || total === null) return { ok: false, reason: 'AMB_MEMORIA: cannot read the machine memory' }
  const m = Math.min(6 * GIB, available - 3 * GIB)
  if (m < 2 * GIB) return { ok: false, reason: `AMB_MEMORIA: only ${(available / GIB).toFixed(1)} GB available; a container needs 2 GB plus 3 GB kept free` }
  if (liveSum + m > total - 4 * GIB) return { ok: false, reason: 'AMB_MEMORIA: the environments already running hold the memory budget' }
  return { ok: true, bytes: Math.floor(m / (1024 * 1024)) * 1024 * 1024 }
}

export const readMem = (key: string) => (): number | null => { try { const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(readFileSync('/proc/meminfo', 'utf8')); return m ? Number(m[1]) * 1024 : null } catch { return null } }

function registryAlive(dataDir: string, id: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, 'managed-sessions.json'), 'utf8'))
    const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.sessions) ? j.sessions : []
    const row = list.find(s => s?.id === id)
    return !!row && !row.endedAt
  } catch { return false }
}

/** §3.1: who is asking. A proven session reuses its own volumes; anything else is a per-run environment. */
export function identify(i: DockerRunInput): { sid: string; perRun: boolean; note: string } {
  const read = i.read ?? procReader()
  const self = i.self ?? process.pid
  const environ = (pid: number) => { try { return readFileSync(`/proc/${pid}/environ`, 'utf8') } catch { return null } }
  const claimed = proposedSessionId(i.env, self, read, environ)
  if (process.platform === 'linux' && claimed && /^[A-Za-z0-9_-]{1,64}$/.test(claimed) && registryAlive(i.dataDir, claimed)) {
    const panes = (() => { try { return i.tmuxPanes ? i.tmuxPanes() : (spawnSync('tmux', ['-L', 'agentop', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'], { encoding: 'utf8', timeout: 5000 }).stdout ?? '') } catch { return '' } })()
    const roots = [...tmuxRoots(panes, claimed), ...structuredRoots(i.dataDir, claimed)]
    const proof = proveAncestry(claimed, roots, self, read)
    if (proof.proven) return { sid: claimed, perRun: false, note: `session ${claimed} (proven by ancestry)` }
    return { sid: `run-${hex(6)}`, perRun: true, note: `session ${claimed} not proven (${proof.reason}): this run gets its own throwaway volumes` }
  }
  return { sid: `run-${hex(6)}`, perRun: true, note: claimed ? `session ${claimed} is not a live managed session: per-run volumes` : 'no session: per-run volumes' }
}

export interface Ctx { prefix: string; inst: string; inst8: string; dataDir: string; env: Record<string, string | undefined>; image: EnvImage; uid: number; gid: number; optDir: string; scratchEnvFile: string; log: (s: string) => void }

const labelsFor = (c: Ctx, sid: string, kind: string, attempt: string): Record<string, string> =>
  ({ 'agentistics.install': c.inst, 'agentistics.session': sid, 'agentistics.kind': kind, 'agentistics.attempt': attempt })

/** create → inspect → (start) a container from a plan. Refuses (and removes by id) when the inspect differs. */
function createChecked(c: Ctx, plan: ContainerPlan, sid: string): { id: string } | { error: string } {
  const nm = nmWritableRefusal(plan, `${c.prefix}-${c.inst8}-nm-`)
  if (nm) return { error: nm }
  const r = docker(buildCreateArgv(plan), { env: c.env })
  if (r.code !== 0) return { error: `docker create failed: ${r.stderr.trim().slice(0, 300)}` }
  const id = r.stdout.trim().split('\n').pop()!.trim()
  if (!/^[0-9a-f]{12,64}$/.test(id)) return { error: 'docker create returned no container id' }
  withLedger(c.dataDir, l => { const s = l.sessions[sid]; const rec = s?.containers.find(x => x.name === plan.name); if (rec) rec.id = id })
  const ins = docker(['inspect', id], { env: c.env })
  const problems = containerProblems(parseJson<any[]>(ins.stdout)?.[0] ?? null, plan)
  if (problems.length) {
    docker(['rm', '-f', id], { env: c.env })
    return { error: `the container did not match its plan, removed: ${problems.join('; ')}` }
  }
  return { id }
}

function recordContainer(c: Ctx, sid: string, plan: ContainerPlan, attempt: string) {
  withLedger(c.dataDir, l => {
    l.sessions[sid]?.containers.push({ attemptId: attempt, name: plan.name, kind: plan.kind, nmWritable: plan.kind === 'install-download' || plan.kind === 'install-scripts' || plan.kind === 'init', at: new Date().toISOString() })
  })
}

/** Run a short helper container to completion and return its stdout (init / marker read). */
function runHelper(c: Ctx, sid: string, plan: ContainerPlan, attempt: string): { code: number; stdout: string; error?: string } {
  recordContainer(c, sid, plan, attempt)
  const made = createChecked(c, plan, sid)
  if ('error' in made) return { code: 1, stdout: '', error: made.error }
  const r = docker(['start', '-a', made.id], { env: c.env, timeoutMs: 120_000 })
  return { code: r.code, stdout: r.stdout, error: r.code === 0 ? undefined : r.stderr.trim().slice(0, 300) }
}

/** §3.2: create ONE volume with proven identity (inspect-before, labels+CreatedAt after, marker written and read back). */
export function createVolume(c: Ctx, sid: string, rec: Omit<VolumeRecord, 'attemptId' | 'nonce' | 'createdAfter'>, subdirs: readonly string[]): { ok: true; rec: VolumeRecord } | { ok: false; code: string; reason: string } {
  const attempt = newAttemptId()
  const nonce = hex(16)
  const createdAfter = new Date().toISOString()
  const full: VolumeRecord = { ...rec, attemptId: attempt, nonce, createdAfter }
  const labels = labelsFor(c, sid, rec.kind, attempt)
  const before = docker(['volume', 'inspect', rec.name], { env: c.env })
  const pre = beforeCreate(before.code, before.stderr)
  if (!pre.ok) return { ok: false, code: pre.code, reason: `${rec.name}: ${pre.detail}` }
  withLedger(c.dataDir, l => { l.sessions[sid]!.volumes.push(full) })
  const args = ['volume', 'create']
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`)
  args.push(rec.name)
  const made = docker(args, { env: c.env })
  if (made.code !== 0) return { ok: false, code: 'volume_create_failed', reason: made.stderr.trim().slice(0, 200) }
  const after = afterCreate(parseJson<any[]>(docker(['volume', 'inspect', rec.name], { env: c.env }).stdout)?.[0] ?? null, { name: rec.name, attemptId: attempt, labels, createdAfter })
  if (!after.ok) return { ok: false, code: after.code, reason: `${rec.name}: ${after.detail}` }
  const createdAt = parseJson<any[]>(docker(['volume', 'inspect', rec.name], { env: c.env }).stdout)?.[0]?.CreatedAt
  withLedger(c.dataDir, l => { const v = l.sessions[sid]!.volumes.find(x => x.attemptId === attempt); if (v) v.createdAt = createdAt })
  const marker = JSON.stringify({ attemptId: attempt, nonce })
  const initAttempt = newAttemptId()
  const init = runHelper(c, sid, initPlan({ name: `${c.prefix}-${c.inst8}-${sid}-init-${hex(3)}`, image: c.image.ref, volume: rec.name, subdirs, uid: c.uid, gid: c.gid, marker, envFile: c.scratchEnvFile, labels: labelsFor(c, sid, 'init', initAttempt), optDir: c.optDir, memoryBytes: 256 * 1024 * 1024 }), initAttempt)
  if (init.code !== 0) return { ok: false, code: 'volume_init_failed', reason: init.error ?? 'init container failed' }
  const v = verifyMarker(c, sid, full)
  return v.ok ? { ok: true, rec: full } : { ok: false, code: 'volume_nao_nosso', reason: v.reason }
}

export function verifyMarker(c: Ctx, sid: string, rec: VolumeRecord): { ok: true } | { ok: false; reason: string } {
  const a = newAttemptId()
  const r = runHelper(c, sid, readMarkerPlan({ name: `${c.prefix}-${c.inst8}-${sid}-read-${hex(3)}`, image: c.image.ref, volume: rec.name, envFile: c.scratchEnvFile, labels: labelsFor(c, sid, 'read', a), optDir: c.optDir, memoryBytes: 256 * 1024 * 1024 }), a)
  const m = markerMatches(r.code === 0 ? r.stdout.trim() : null, rec.attemptId, rec.nonce)
  return m.ok ? { ok: true } : { ok: false, reason: `${rec.name}: ${m.detail}` }
}

/** Remove a per-run volume, only after its identity is proven again (labels + marker). */
export function removeOwnVolume(c: Ctx, sid: string, rec: VolumeRecord) {
  const ins = parseJson<any[]>(docker(['volume', 'inspect', rec.name], { env: c.env }).stdout)?.[0] ?? null
  const labels = labelsFor(c, sid, rec.kind, rec.attemptId)
  const ok = afterCreate(ins, { name: rec.name, attemptId: rec.attemptId, labels, createdAfter: rec.createdAfter }).ok && verifyMarker(c, sid, rec).ok
  if (!ok) { c.log(`agentop run: kept volume ${rec.name}: its identity could not be proven again`); return }
  const r = docker(['volume', 'rm', rec.name], { env: c.env })
  if (r.code !== 0) c.log(`agentop run: could not remove volume ${rec.name}: ${r.stderr.trim().slice(0, 160)}`)
}

const volumeNames = (c: Ctx, sid: string, gen: number): SessionVolumes => ({
  scratch: `${c.prefix}-${c.inst8}-scratch-${sid}`,
  nm: `${c.prefix}-${c.inst8}-nm-${sid}-g${gen}`,
})

/** Make sure the session's volumes exist and are ours; state `preparando → pronto`. */
export function ensureVolumes(c: Ctx, sid: string, perRun: boolean, slots: readonly NmSlot[]): { ok: true; volumes: SessionVolumes; entry: SessionEntry } | { ok: false; code: string; reason: string } {
  const pre = withLedger(c.dataDir, l => {
    const s = l.sessions[sid] ??= emptySession(perRun, new Date().toISOString())
    const refusal = admissionRefusal(s)
    if (refusal) return { refusal }
    if (s.state === 'ausente') s.state = 'preparando'
    return { s: JSON.parse(JSON.stringify(s)) as SessionEntry }
  })
  if ('refusal' in pre) return { ok: false, code: pre.refusal!, reason: 'AMB_LIMPANDO: this environment is being cleaned; no new command is admitted' }
  const s = pre.s
  const names = volumeNames(c, sid, s.nmGen)
  for (const [kind, name, subdirs] of [['scratch', names.scratch, scratchSubdirs(slots)], ['nm', names.nm, nmSubdirs(slots)]] as const) {
    const have = s.volumes.find(v => v.name === name)
    if (have) {
      // Existing volume: re-prove (labels + marker). New workspaces since creation are a reinstall away.
      const v = verifyMarker(c, sid, have)
      if (!v.ok) return { ok: false, code: 'volume_nao_nosso', reason: v.reason }
      continue
    }
    const made = createVolume(c, sid, { name, kind, ...(kind === 'nm' ? { gen: s.nmGen } : {}) }, subdirs)
    if (!made.ok) return made
  }
  const entry = withLedger(c.dataDir, l => { const e = l.sessions[sid]!; if (e.state === 'preparando') e.state = 'pronto'; return JSON.parse(JSON.stringify(e)) as SessionEntry })
  return { ok: true, volumes: names, entry }
}

export function ensureImage(c: Ctx): string | null {
  const look = () => parseJson<any[]>(docker(['image', 'inspect', c.image.ref], { env: c.env }).stdout)?.[0] ?? null
  let ins = look()
  if (!ins) {
    c.log(`agentop run: pulling ${c.image.key} by its catalogue digest`)
    const p = docker(['pull', c.image.ref], { env: c.env, timeoutMs: 600_000 })
    if (p.code !== 0) return `could not pull ${c.image.ref}: ${p.stderr.trim().slice(0, 200)}`
    ins = look()
  }
  const problems = imageProblems(ins, c.image)
  return problems.length ? `image refused: ${problems.join('; ')}` : null
}

function hostAndDockerDisk(c: Ctx, names: SessionVolumes, bindDirs: string[]): { sessionBytes: number; dockerFreeBytes: number | null } {
  const df = docker(['system', 'df', '-v', '--format', '{{json .}}'], { env: c.env, timeoutMs: 20_000 })
  const sizes = volumeSizes(df.stdout)
  let bytes = (sizes.get(names.scratch) ?? 0) + (sizes.get(names.nm) ?? 0)
  for (const d of bindDirs) {
    const r = spawnSync('du', ['-sb', d], { encoding: 'utf8', timeout: 20_000 })
    const n = Number((r.stdout ?? '').split(/\s/)[0])
    if (Number.isFinite(n)) bytes += n
  }
  const root = docker(['version', '--format', '{{.Server.Os}}'], { env: c.env }) // reachability only
  let free: number | null = null
  if (root.code === 0) {
    const info = spawnSync('df', ['-B1', '--output=avail', c.env.AGENTISTICS_DOCKER_ROOT || '/var/lib/docker'], { encoding: 'utf8', timeout: 10_000 })
    const n = Number((info.stdout ?? '').trim().split('\n').pop())
    free = Number.isFinite(n) && n > 0 ? n : null
  }
  return { sessionBytes: bytes, dockerFreeBytes: free }
}

export function makeCtx(dataDir: string, env: Record<string, string | undefined>, image: EnvImage, log: (s: string) => void): Ctx {
  const inst = installId(dataDir)
  const runDir = join(dockerDir(dataDir), 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const scratchEnvFile = join(runDir, `helper-${process.pid}.env`)
  writeFileSync(scratchEnvFile, envFileText({ HOME: '/tmp', CI: '1' }), { mode: 0o600 })
  return { prefix: prefixOf(env), inst, inst8: inst.slice(0, 8), dataDir, env, image, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, optDir: ensureOpt(dataDir), scratchEnvFile, log }
}

/** The whole §3.3 path. */
export async function runInDocker(i: DockerRunInput): Promise<DockerRunOutcome> {
  const log = i.log ?? ((s: string) => console.error(s))
  const wt = worktreeOf(i.cwd)
  if (!wt) return { ran: false, fallback: true, reason: 'this folder is not inside a git worktree: Docker would have to mount it with no credential masks. This run uses the isolated namespace.' }
  const { root, gitDirInTree } = wt
  const profileText = (() => { try { return readFileSync(join(root, PROFILE_REL), 'utf8') } catch { return null } })()
  const prof = imageForProfile(profileText)
  if (!prof.ok) return { ran: false, fallback: true, reason: `${prof.reason}. This run uses the isolated namespace.` }
  const who = identify(i)
  log(`agentop run: Docker environment — ${who.note}`)
  const mem = memoryAdmission((i.memAvailable ?? readMem('MemAvailable'))(), (i.memTotal ?? readMem('MemTotal'))(), liveMemory(i.dataDir))
  if (!mem.ok) return { ran: false, fallback: false, code: 3, reason: mem.reason }
  const c = makeCtx(i.dataDir, i.env, prof.image, log)
  const cleanupCtx = () => rmSync(c.scratchEnvFile, { force: true })
  try {
    const imgErr = ensureImage(c)
    if (imgErr) return { ran: false, fallback: true, reason: `${imgErr}. This run uses the isolated namespace.` }
    const slots = workspaceSlots(root)
    const nmRefusal = admitWorktree(i.dataDir, who.sid, who.perRun, root, slots)
    if (nmRefusal) return { ran: false, fallback: true, reason: nmRefusal }
    const vols = ensureVolumes(c, who.sid, who.perRun, slots)
    if (!vols.ok) return { ran: false, fallback: false, code: 4, reason: `${vols.code}: ${vols.reason}` }
    const volumes = i.nmOverride ? { ...vols.volumes, nm: i.nmOverride } : vols.volumes
    try {
      return await runCommand(c, i, who, root, gitDirInTree, slots, volumes, i.memoryBytes ? Math.min(i.memoryBytes, mem.bytes) : mem.bytes, prof.profile.env)
    } finally {
      if (who.perRun) {
        const entry = readLedger(i.dataDir).sessions[who.sid]
        for (const v of entry?.volumes ?? []) removeOwnVolume(c, who.sid, v)
        withLedger(i.dataDir, l => { const e = l.sessions[who.sid]; if (e) e.state = 'removido' })
      }
    }
  } catch (e) {
    if (e instanceof DockerRefusal) return { ran: false, fallback: false, code: 5, reason: `refused: ${e.message}` }
    throw e
  } finally { cleanupCtx() }
}

export function liveMemory(dataDir: string): number {
  let sum = 0
  for (const s of Object.values(readLedger(dataDir).sessions)) for (const e of Object.values(s.execs)) if (e.memoryBytes && launcherAlive(e)) sum += e.memoryBytes
  return sum
}
function launcherAlive(e: { launcherPid: number; launcherStart: number | null }): boolean {
  const l = procReader()(e.launcherPid)
  return !!l && (e.launcherStart === null || l.start === e.launcherStart)
}

export async function runCommand(c: Ctx, i: DockerRunInput, who: { sid: string; perRun: boolean }, root: string, gitDirInTree: boolean, slots: readonly NmSlot[], volumes: SessionVolumes, memoryBytes: number, profileEnv: Record<string, string>): Promise<DockerRunOutcome> {
  const kind = i.kind ?? 'cmd'
  // The download container never sees the worktree (r4 #2): only the host-generated staging, so no repo file is read there.
  const download = kind === 'install-download'
  if (download && !i.stagingDir) return { ran: false, fallback: false, code: 4, reason: 'install_exige_arquivo_do_repo: the download container needs a host-generated staging directory, never the worktree' }
  let masks: { mounts: MountSpec[]; masked: string[] } = { mounts: [], masked: [] }
  if (!download) {
    // r4 #1: the mount points must be absent or EMPTY on the host (nothing is hidden), and r4 fail-closed masks (§5.2).
    const nmRefusal = admitWorktree(c.dataDir, who.sid, who.perRun, root, slots)
    if (nmRefusal) return { ran: false, fallback: true, reason: nmRefusal }
    try {
      const w = worktreeEntries(root)
      masks = maskMounts(root, w.entries, { gitDirInTree, foreignDirs: w.foreignDirs })
    } catch (e) {
      if (e instanceof MaskListingError) return { ran: false, fallback: false, code: 4, reason: `refused: ${e.message}` }
      throw e
    }
  }
  const execId = hex(8)
  const execDir = join(dockerDir(c.dataDir), 'run', who.sid, execId)
  mkdirSync(execDir, { recursive: true, mode: 0o700 })
  const saidaDir = join(dockerDir(c.dataDir), 'saida', who.sid)
  mkdirSync(saidaDir, { recursive: true, mode: 0o700 })
  if (masks.masked.length) c.log(`agentop run: masked ${masks.masked.length} credential-shaped file(s) or nested repositor(ies) of the worktree`)
  const envFile = join(execDir, 'env')
  const extra: Record<string, string> = download ? { BUN_INSTALL_CACHE_DIR: '/cache/bun', npm_config_cache: '/cache/npm' } : {}
  writeFileSync(envFile, envFileText(containerEnv({ host: i.env, sid: who.sid, profile: profileEnv, extra, proxy: kind === 'install-download' ? 'http://127.0.0.1:3128' : undefined })), { mode: 0o600 })
  const attempt = newAttemptId()
  const plan = containerPlan({
    kind, name: `${c.prefix}-${c.inst8}-${who.sid}-${kind}-${hex(3)}`, image: c.image.ref, uid: c.uid, gid: c.gid, memoryBytes,
    root, cwd: i.cwd, envFile, labels: labelsFor(c, who.sid, kind, attempt), volumes, nm: slots, masks: masks.mounts as MountSpec[],
    optDir: c.optDir, saidaDir, sockDir: i.sockDir, stagingDir: download ? i.stagingDir : undefined, ttlSec: i.ttlSec, argv: i.command,
  })
  const self = procReader()(process.pid)
  withLedger(c.dataDir, l => {
    const s = l.sessions[who.sid]!
    s.execs[execId] = { execId, kind, launcherPid: process.pid, launcherStart: self?.start ?? null, containerAttempt: attempt, startedAt: new Date().toISOString(), ttlSec: i.ttlSec, memoryBytes }
  })
  recordContainer(c, who.sid, plan, attempt)
  let made: { id: string } | { error: string }
  try { made = createChecked(c, plan, who.sid) } finally { rmSync(envFile, { force: true }) }
  const dropExec = () => withLedger(c.dataDir, l => { delete l.sessions[who.sid]?.execs[execId] })
  if ('error' in made) { dropExec(); rmSync(execDir, { recursive: true, force: true }); return { ran: false, fallback: false, code: 4, reason: made.error } }
  const id = made.id
  withLedger(c.dataDir, l => { const e = l.sessions[who.sid]?.execs[execId]; if (e) e.containerId = id })

  let watchdog: string | null = null
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    docker(['kill', '--signal', 'TERM', id], { env: c.env })
    const t = setTimeout(() => { docker(['kill', id], { env: c.env }) }, 10_000)
    t.unref?.()
  }
  const run = dockerAttached(['start', '-a', id], { env: c.env })
  const onSig = () => stop()
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig); process.on('SIGHUP', onSig)
  const ttlTimer = setTimeout(stop, (i.ttlSec + 15) * 1000)
  const every = i.diskEveryMs ?? DISK_WATCH_EVERY_MS
  const limits = { sessionMax: i.diskLimits?.sessionMax ?? SESSION_DISK_MAX_BYTES, freeFloor: i.diskLimits?.freeFloor ?? DOCKER_FREE_FLOOR_BYTES, everyMs: every }
  const disk = setInterval(() => {
    if (stopping) return
    const v = diskVerdict(hostAndDockerDisk(c, volumes, [saidaDir]), limits)
    if (v.kill) { watchdog = v.message; stop() }
  }, every)
  disk.unref?.()
  const code = await run.done
  clearTimeout(ttlTimer); clearInterval(disk)
  process.off('SIGINT', onSig); process.off('SIGTERM', onSig); process.off('SIGHUP', onSig)
  // --rm removes it; if the daemon did not (it was never started, or the daemon went away), remove by id.
  docker(['rm', '-f', id], { env: c.env })
  dropExec()
  rmSync(execDir, { recursive: true, force: true })
  const words = exitWords(code, { ttlSec: i.ttlSec, memoryBytes, watchdog })
  if (words) c.log(words)
  return { ran: true, code, sessionId: who.sid, perRun: who.perRun, containerId: id }
}
