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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
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

function lock(dataDir: string): () => void {
  ensureDir(dataDir)
  const p = join(dockerDir(dataDir), 'ledger.lock')
  for (let i = 0; i < 400; i++) {
    try {
      const fd = openSync(p, 'wx', 0o600)
      writeSync(fd, String(process.pid)); closeSync(fd)
      return () => rmSync(p, { force: true })
    } catch {
      try {
        const holder = Number(readFileSync(p, 'utf8'))
        const age = Date.now() - statSync(p).mtimeMs
        if (!holder || !alive(holder) || age > 30_000) { rmSync(p, { force: true }); continue }
      } catch { continue }
      sleepMs(25)
    }
  }
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

export const emptySession = (perRun: boolean, now: string): SessionEntry => ({ state: 'ausente', perRun, createdAt: now, nmGen: 0, volumes: [], containers: [], execs: {} })

export type AdmissionRefusal = 'AMB_LIMPANDO'

/** Admission (§3.2): a session being cleaned or already removed takes no new command. PURE. */
export function admissionRefusal(s: SessionEntry | undefined): AdmissionRefusal | null {
  return s && (s.state === 'limpando' || s.state === 'removido') ? 'AMB_LIMPANDO' : null
}

export const ledgerExists = (dataDir: string) => existsSync(ledgerPath(dataDir))
