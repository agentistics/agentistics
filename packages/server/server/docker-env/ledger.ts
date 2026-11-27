/**
 * DOCKER.AMBIENTES S2 — the ledger (SPEC-r3 §3.2): `<dataDir>/docker/ledger.json`, 0600, atomic write + fsync,
 * one writer at a time across processes (an O_EXCL lock file naming its pid; a dead holder or one older than
 * 30 s is taken over). Per session: `ausente → preparando → pronto → limpando → removido`.
 *
 * Every resource is preceded by an INTENT `{attemptId (128 bits), kind, name, createdAfter}` written with fsync
 * before it is created; the resource carries `agentistics.attempt=<attemptId>`. Every container records whether
 * it mounted `node_modules` WRITABLE (S3's D6b reads it: only install kinds may). The engine lease
 * (`acquireLease`) is S3's: the cleanup lives in the engine. Here the lock serialises admission and the state.
 */
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export type SessionState = 'ausente' | 'preparando' | 'pronto' | 'limpando' | 'removido'

export interface VolumeRecord { name: string; kind: 'scratch' | 'nm' | 'cache'; gen?: number; attemptId: string; nonce: string; createdAfter: string; createdAt?: string }
export interface ContainerRecord { attemptId: string; name: string; kind: string; id?: string; nmWritable: boolean; at: string }
export interface ExecRecord { execId: string; kind: string; launcherPid: number; launcherStart: number | null; containerAttempt: string; startedAt: string; ttlSec: number; containerId?: string; memoryBytes?: number }

export interface SessionEntry {
  state: SessionState
  /** true = no proven session: throwaway volumes created and removed by the run itself. */
  perRun: boolean
  createdAt: string
  nmGen: number
  volumes: VolumeRecord[]
  containers: ContainerRecord[]
  execs: Record<string, ExecRecord>
  /** Absolute `node_modules` mount points the AGENTOP created (empty at creation). Only these may ever be excluded from a snapshot (S3, r4 #1). */
  mountpoints?: string[]
  /** Generations reserved for an install in flight (`g<n>` in use + `g<n+1>`), and `g<n>` volumes whose removal is pending (r4 #6). */
  reservedGens?: number[]
  pendingGens?: string[]
}

export interface Ledger { version: 1; installId: string; sessions: Record<string, SessionEntry> }

export const dockerDir = (dataDir: string) => join(dataDir, 'docker')
export const ledgerPath = (dataDir: string) => join(dockerDir(dataDir), 'ledger.json')

export const newAttemptId = (): string => randomBytes(16).toString('hex')

function ensureDir(dataDir: string) { mkdirSync(dockerDir(dataDir), { recursive: true, mode: 0o700 }) }

/** `<dataDir>/docker/install-id`: 128 random bits, created once. `inst8` names every resource. */
export function installId(dataDir: string): string {
  ensureDir(dataDir)
  const p = join(dockerDir(dataDir), 'install-id')
  try { const v = readFileSync(p, 'utf8').trim(); if (/^[0-9a-f]{32}$/.test(v)) return v } catch {}
  const id = newAttemptId()
  writeAtomic(p, id + '\n')
  return id
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
}

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

/**
 * The lock file is created ALREADY holding its pid: the pid goes into a private temp file and `link(2)` publishes it
 * under the lock name (atomic, fails with EEXIST while someone holds it). `open(wx)` + a later write left a window
 * where a reader saw an empty file, read the owner as `0` and deleted a live lock (QA 27/11: 650/900 updates kept).
 * An EMPTY or unreadable lock is never a stale one: it is waited on (and only the 30 s age takes it over).
 */
function lock(dataDir: string): () => void {
  ensureDir(dataDir)
  const p = join(dockerDir(dataDir), 'ledger.lock')
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, String(process.pid)); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    for (let i = 0; i < 800; i++) {
      try {
        linkSync(tmp, p)
        return () => rmSync(p, { force: true })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      try {
        const ino = statSync(p).ino
        const holder = Number(readFileSync(p, 'utf8'))
        const age = Date.now() - statSync(p).mtimeMs
        // Taken over only when the SAME file (same inode) names a dead pid, or it is older than 30 s.
        if ((holder > 0 && !alive(holder)) || age > 30_000) { if (statSync(p).ino === ino) rmSync(p, { force: true }); continue }
      } catch { continue }
      sleepMs(10)
    }
  } finally { rmSync(tmp, { force: true }) }
  throw new Error('the Docker environment ledger is locked by another process')
}

export function readLedger(dataDir: string): Ledger {
  const id = installId(dataDir)
  try {
    const j = JSON.parse(readFileSync(ledgerPath(dataDir), 'utf8')) as Ledger
    if (j && j.version === 1 && j.sessions) return j
  } catch {}
  return { version: 1, installId: id, sessions: {} }
}

/** Read-modify-write under the cross-process lock. `fn` may mutate the ledger and return a value. */
export function withLedger<T>(dataDir: string, fn: (l: Ledger) => T): T {
  const release = lock(dataDir)
  try {
    const l = readLedger(dataDir)
    const out = fn(l)
    writeAtomic(ledgerPath(dataDir), JSON.stringify(l, null, 2))
    return out
  } finally { release() }
}

export const emptySession = (perRun: boolean, now: string): SessionEntry => ({ state: 'ausente', perRun, createdAt: now, nmGen: 0, volumes: [], containers: [], execs: {}, mountpoints: [], reservedGens: [], pendingGens: [] })

export type AdmissionRefusal = 'AMB_LIMPANDO'

/** Admission (§3.2): a session being cleaned or already removed takes no new command. PURE. */
export function admissionRefusal(s: SessionEntry | undefined): AdmissionRefusal | null {
  return s && (s.state === 'limpando' || s.state === 'removido') ? 'AMB_LIMPANDO' : null
}

/** The disk envelope's unit (SPEC §11.1): one `nm` generation is budgeted at 4 GiB; the default budget is 16 GiB. */
export const GEN_BUDGET_BYTES = 4 * 1024 ** 3
export const GEN_ENVELOPE_BYTES = 16 * 1024 ** 3

/** PURE: generations held in the envelope = those reserved by installs in flight + `g<n>_pendente` ones, over every session. */
export function heldGenerations(l: Ledger): number {
  return Object.values(l.sessions).reduce((n, s) => n + (s.reservedGens?.length ?? 0) + (s.pendingGens?.length ?? 0), 0)
}

/**
 * r4 #6: an install needs TWO generations at its peak (`g<n>` in use + `g<n+1>`). Reserved BEFORE the download; no
 * budget left ⇒ `disco_cheio` with the reservation that is in the way. Released on success and on failure.
 */
export function reserveGenerations(dataDir: string, sid: string, gens: number[]): { ok: true } | { ok: false; reason: string } {
  return withLedger(dataDir, l => {
    if ((heldGenerations(l) + gens.length) * GEN_BUDGET_BYTES > GEN_ENVELOPE_BYTES) {
      const holders = Object.entries(l.sessions).filter(([, s]) => (s.reservedGens?.length ?? 0) + (s.pendingGens?.length ?? 0) > 0).map(([id, s]) => `${id}: ${[...(s.reservedGens ?? []).map(g => `g${g}`), ...(s.pendingGens ?? []).map(g => `${g}_pendente`)].join(',')}`)
      return { ok: false as const, reason: `disco_cheio: an install holds 2 node_modules generations at its peak and the ${GEN_ENVELOPE_BYTES / 1024 ** 3} GiB envelope is full (held: ${holders.join('; ') || 'none'})` }
    }
    const s = l.sessions[sid] ??= emptySession(false, new Date().toISOString())
    s.reservedGens = gens
    return { ok: true as const }
  })
}
export function releaseGenerations(dataDir: string, sid: string): void {
  withLedger(dataDir, l => { const s = l.sessions[sid]; if (s) s.reservedGens = [] })
}

/** PURE: `docker ps -a --filter volume=<name> -q` empty (and the call worked) ⇒ the generation may be removed; else it stays `g<n>_pendente`. */
export function generationRemoval(psExit: number, psStdout: string): 'remove' | 'pending' {
  return psExit === 0 && psStdout.trim() === '' ? 'remove' : 'pending'
}

export const ledgerExists = (dataDir: string) => existsSync(ledgerPath(dataDir))
