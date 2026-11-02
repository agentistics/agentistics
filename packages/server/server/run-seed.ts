/**
 * AMBIENTE (F3b) — what a throwaway server may start with from the real store, and the guards around the HOME it runs in.
 *
 * C1: the old manual recipe was "cp -r ~/.agentistics", which carried `structured/` (live relays) into the throwaway and
 * killed the real fleet. Here the copy is an ALLOW list; everything else is never copied. `.db` files are snapshotted with
 * `VACUUM INTO` (a plain cp of a database with an open WAL is not consistent); a symlink anywhere in the source refuses.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The ONLY entries of the real data dir a `copia` seed carries. */
export const SEED_ALLOW: readonly string[] = [
  'journal.db', 'journal.db.stamps.json', 'journal.db.status.json', 'cache.db', 'git-stats.db', 'index', 'content', 'archive',
]
/** Documented and tested as never copied (live relays, sessions, credentials, other stores). Not consulted by the copy: SEED_ALLOW is. */
export const SEED_NEVER: readonly string[] = [
  'structured', 'run', 'heavy', 'flows', 'sessions', 'managed-sessions.json', 'session-roles.json', 'accounts.json', 'accounts',
  'login-env.json', 'vault', 'provider-keys', 'connections', 'event-subscriptions.json', 'workflows', 'voice', 'agentop-server.log',
]

export class SeedRefusal extends Error {}

function assertNoSymlinks(path: string): void {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) throw new SeedRefusal(`seed source contains a symlink: ${path}`)
  if (st.isDirectory()) for (const name of readdirSync(path)) assertNoSymlinks(join(path, name))
}

/** Consistent snapshot of one SQLite file. Injectable so tests do not need a real database engine. */
export type SnapshotDb = (src: string, dest: string) => void
const snapshotWithVacuum: SnapshotDb = (src, dest) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(src, { readonly: true })
  try { db.run(`VACUUM INTO '${dest.replace(/'/g, "''")}'`) } finally { db.close() }
}

/** Copy the allowed entries of `srcDataDir` into `stagingDataDir`. Returns what was copied. Throws SeedRefusal on a symlink. */
export function buildSeed(srcDataDir: string, stagingDataDir: string, snapshotDb: SnapshotDb = snapshotWithVacuum): string[] {
  const present = SEED_ALLOW.filter(name => existsSync(join(srcDataDir, name)) || isLink(join(srcDataDir, name)))
  for (const name of present) assertNoSymlinks(join(srcDataDir, name))
  mkdirSync(stagingDataDir, { recursive: true, mode: 0o700 })
  for (const name of present) {
    const from = join(srcDataDir, name)
    const to = join(stagingDataDir, name)
    if (name.endsWith('.db')) snapshotDb(from, to)
    else cpSync(from, to, { recursive: true, dereference: false, errorOnExist: false, force: true })
  }
  return present
}
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

/** Copy a staged seed into the run's data dir (before the server starts). Refuses a symlink in the staging. */
export function applySeed(stagingDataDir: string, homeDataDir: string): string[] {
  assertNoSymlinks(stagingDataDir)
  mkdirSync(homeDataDir, { recursive: true, mode: 0o700 })
  const copied: string[] = []
  for (const name of readdirSync(stagingDataDir)) {
    if (!SEED_ALLOW.includes(name)) throw new SeedRefusal(`seed entry not allowed: ${name}`)
    cpSync(join(stagingDataDir, name), join(homeDataDir, name), { recursive: true, dereference: false })
    copied.push(name)
  }
  return copied
}

/** I10: live relays must not exist in a throwaway store before the server spawns. Remove, then assert. */
export function ensureNoStructured(homeDataDir: string): void {
  rmSync(join(homeDataDir, 'structured'), { recursive: true, force: true })
  if (existsSync(join(homeDataDir, 'structured'))) throw new Error(`${join(homeDataDir, 'structured')} could not be removed; refusing to start`)
}

const HEAVY_LOCK = /agentistics-heavy[^/]*\.lock$/
/** Open file descriptors of `pid` pointing at a machine-wide heavy lock file (Linux; empty where unreadable). */
export function heavyLockFds(pid: number | 'self', procRoot = '/proc'): number[] {
  const dir = join(procRoot, String(pid), 'fd')
  const out: number[] = []
  let names: string[]
  try { names = readdirSync(dir) } catch { return out }
  for (const fd of names) {
    try { if (HEAVY_LOCK.test(readlinkSync(join(dir, fd)))) out.push(Number(fd)) } catch {}
  }
  return out
}
/** Same question for the whole /proc tree, restricted to the pids given. */
export function pidsHoldingHeavyLock(pids: number[], procRoot = '/proc'): number[] {
  return pids.filter(pid => heavyLockFds(pid, procRoot).length > 0)
}
