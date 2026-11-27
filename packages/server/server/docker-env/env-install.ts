/**
 * DOCKER.AMBIENTES S2 — `agentop env install`: the FIXED dependency verb (SPEC-r3 §3.5). The profile only picks
 * WHICH manager; the argv is agentop's. It produces a new `nm` generation `g<n+1>`:
 *
 *  1. download — the only container with a way out (the egress proxy over a unix socket, §3.6):
 *     `--ignore-scripts --frozen-lockfile`, worktree READ-ONLY, `nm-g<n+1>` writable, the shared package cache
 *     writable, NO scratch (HOME and /tmp are the manager's own tmpfs). No repo code runs here.
 *  2. lifecycle scripts — `--network none`, worktree writable (husky/prisma write into it), `nm-g<n+1>` writable,
 *     scratch mounted, no cache. For bun this is an OFFLINE `install --frozen-lockfile` (P5b: `bun rebuild` does not
 *     exist and `pm trust` runs nothing); for npm, `npm rebuild`. Decision recorded: phase 2 has no egress (the
 *     spec says "network container"; P5b ran it offline) — a postinstall that downloads fails, in words.
 *  3. success ⇒ `nm` = g<n+1> and g<n> is removed (identity proven again); failure ⇒ g<n+1> removed, g<n> stays.
 *
 * Only a PROVEN session installs (a per-run environment would throw the result away).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { EGRESS_MAX_ALLOW } from './egress-policy'
import { startEgressProxy } from './egress-proxy'
import { imageForProfile, PROFILE_REL } from './env-profile'
import { createVolume, ensureImage, ensureVolumes, identify, liveMemory, makeCtx, memoryAdmission, readMem, removeOwnVolume, runCommand, verifyMarker, workspaceSlots, worktreeOf, type Ctx, type DockerRunInput } from './docker-run'
import { dockerDir, emptySession, readLedger, withLedger } from './ledger'
import { nmSubdirs } from './plans'
import { docker } from './docker-cli'

export const MACHINE_SID = '_machine'

const managerArgv = (m: string, rt: string) => ({
  download: m === 'bun' ? 'bun install --frozen-lockfile --ignore-scripts' : 'npm ci --ignore-scripts',
  scripts: m === 'bun' ? 'bun install --frozen-lockfile' : 'npm rebuild',
  runtime: rt,
})

const LOCKFILES: Record<string, string[]> = { bun: ['bun.lock', 'bun.lockb'], npm: ['package-lock.json'] }

/** The shared package cache of one manager: created once (identity like any volume), owned by the machine. */
function ensureCache(c: Ctx, manager: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = `${c.prefix}-${c.inst8}-cache-${manager}`
  withLedger(c.dataDir, l => { l.sessions[MACHINE_SID] ??= { ...emptySession(false, new Date().toISOString()), state: 'pronto' } })
  const rec = readLedger(c.dataDir).sessions[MACHINE_SID]!.volumes.find(v => v.name === name)
  if (rec) { const v = verifyMarker(c, MACHINE_SID, rec); return v.ok ? { ok: true, name } : { ok: false, reason: v.reason } }
  const made = createVolume(c, MACHINE_SID, { name, kind: 'cache' }, ['data'])
  return made.ok ? { ok: true, name } : { ok: false, reason: `${made.code}: ${made.reason}` }
}

export async function envInstall(i: Omit<DockerRunInput, 'command' | 'ttlSec'> & { ttlSec?: number }): Promise<{ code: number; message: string }> {
  const log = i.log ?? ((s: string) => console.error(s))
  const { root, gitDirInTree } = worktreeOf(i.cwd)
  const profileText = (() => { try { return readFileSync(join(root, PROFILE_REL), 'utf8') } catch { return null } })()
  const prof = imageForProfile(profileText)
  if (!prof.ok) return { code: 2, message: `${prof.reason}; the Docker install is not available for this project` }
  const manager = prof.profile.manager ?? prof.image.managers[0]!
  if (!['bun', 'npm'].includes(manager) || !prof.image.managers.includes(manager)) return { code: 2, message: `manager ${manager} is not supported by image ${prof.image.key} in this slice (bun, npm)` }
  if (!LOCKFILES[manager]!.some(f => existsSync(join(root, f)))) return { code: 2, message: `no ${LOCKFILES[manager]!.join(' / ')}: the install runs only with a lockfile (--frozen-lockfile)` }
  const who = identify({ ...i, command: [], ttlSec: 0 })
  if (who.perRun) return { code: 2, message: `agentop env install needs a proven session (${who.note})` }
  const mem = memoryAdmission((i.memAvailable ?? readMem('MemAvailable'))(), (i.memTotal ?? readMem('MemTotal'))(), liveMemory(i.dataDir))
  if (!mem.ok) return { code: 3, message: mem.reason }
  const c = makeCtx(i.dataDir, i.env, prof.image, log)
  try {
    const imgErr = ensureImage(c)
    if (imgErr) return { code: 4, message: imgErr }
    const slots = workspaceSlots(root)
    const vols = ensureVolumes(c, who.sid, false, slots)
    if (!vols.ok) return { code: 4, message: `${vols.code}: ${vols.reason}` }
    const cache = ensureCache(c, manager)
    if (!cache.ok) return { code: 4, message: cache.reason }
    const gen = vols.entry.nmGen + 1
    const next = `${c.prefix}-${c.inst8}-nm-${who.sid}-g${gen}`
    const made = createVolume(c, who.sid, { name: next, kind: 'nm', gen }, nmSubdirs(slots))
    if (!made.ok) return { code: 4, message: `${made.code}: ${made.reason}` }
    const dropNext = () => { const r = readLedger(i.dataDir).sessions[who.sid]?.volumes.find(v => v.name === next); if (r) removeOwnVolume(c, who.sid, r) }
    const argv = managerArgv(manager, prof.image.tools.includes('bun') ? 'bun' : 'node')
    // 1. download, through the egress proxy
    const sockDir = join(dockerDir(i.dataDir), 'run', who.sid, `egress-${randomBytes(4).toString('hex')}`)
    mkdirSync(sockDir, { recursive: true, mode: 0o700 })
    const allow = (prof.profile.network.allow.length ? prof.profile.network.allow : ['registry.npmjs.org']).filter(h => EGRESS_MAX_ALLOW.includes(h))
    const proxy = await startEgressProxy({ socketPath: join(sockDir, 'egress.sock'), allow, journal: join(dockerDir(i.dataDir), 'egress.jsonl') })
    let dl
    try {
      dl = await runCommand(c, { ...i, command: ['sh', '-c', `${argv.runtime} /opt/agentistics/fwd.mjs out 3128 /run/agentistics/egress.sock & sleep 0.5; ${argv.download}`], ttlSec: i.ttlSec ?? 900, kind: 'install-download', sockDir }, who, root, gitDirInTree, slots, { ...vols.volumes, nm: next, cache: cache.name }, mem.bytes, prof.profile.env)
    } finally { proxy.close(); rmSync(sockDir, { recursive: true, force: true }) }
    if (!dl.ran || dl.code !== 0) { dropNext(); return { code: 1, message: `download failed (${dl.ran ? `exit ${dl.code}` : dl.reason}); node_modules unchanged (g${gen - 1})` } }
    // 2. lifecycle scripts, no network, no cache, no grant
    const sc = await runCommand(c, { ...i, command: ['sh', '-c', argv.scripts], ttlSec: i.ttlSec ?? 900, kind: 'install-scripts' }, who, root, gitDirInTree, slots, { ...vols.volumes, nm: next }, mem.bytes, prof.profile.env)
    if (!sc.ran || sc.code !== 0) { dropNext(); return { code: 1, message: `lifecycle scripts failed (${sc.ran ? `exit ${sc.code}` : sc.reason}); they run without network — a script that downloads cannot work here. node_modules unchanged (g${gen - 1})` } }
    // 3. switch generation, drop the previous one
    const prev = withLedger(i.dataDir, l => { const s = l.sessions[who.sid]!; const old = s.volumes.find(v => v.kind === 'nm' && v.gen === s.nmGen); s.nmGen = gen; return old })
    if (prev) {
      removeOwnVolume(c, who.sid, prev)
      if (docker(['volume', 'inspect', prev.name], { env: i.env }).code !== 0) withLedger(i.dataDir, l => { const s = l.sessions[who.sid]!; s.volumes = s.volumes.filter(v => v.name !== prev.name) })
    }
    return { code: 0, message: `installed with ${manager}: node_modules generation g${gen}` }
  } finally { rmSync(c.scratchEnvFile, { force: true }) }
}
