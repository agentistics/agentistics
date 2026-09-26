/**
 * journal/schema.ts — the journal's DDL, its pragma ORDER, its migration, and the refusal to open
 * on a network filesystem (master spec §19.2, research 15 §VERDICT).
 *
 * Every rule below was found by MEASUREMENT, not by reading, and each one says so where it lives:
 *
 *  1. `busy_timeout` is set BEFORE `journal_mode = WAL` on every connection. The other order killed
 *     a worker with an uncaught `SQLITE_BUSY_RECOVERY` when two processes raced to open a fresh
 *     file — first try on DrvFs, and structurally the same (narrower) race on ext4. Switching WAL on
 *     touches the file's locks, and a connection with no timeout yet fails instead of waiting.
 *  2. `journal_mode` is READ BACK. SQLite does not fail when a filesystem cannot do WAL: it answers
 *     with the mode it actually used (`delete`), silently. A journal that believes it is in WAL and
 *     is not has lost the property the concurrency measurement rested on, so that is a refusal.
 *  3. The directory must not be on a network filesystem. SQLite documents WAL as unsafe there on
 *     every OS (the `-shm` index is `mmap`ed shared memory, which does not survive a network
 *     boundary), and the measurement found DrvFs (`9p`, WSL's `/mnt/c`) 6–20x slower with a 3,2 s
 *     worst-case batch. Refusing, and saying why, beats running slowly until it corrupts. But ONLY
 *     on a determination: a type nobody could read is `unknown`, and `unknown` OPENS — refusing on a
 *     guess would switch the journal off on every machine whose mount table we failed to parse.
 *
 * The file is split pure/IO the way this repo splits everything: the parsers and the classifier
 * take text and a probe, `defaultPathProbe` is the only place that touches the OS, and nothing here
 * runs at import time.
 */
import type { Database } from 'bun:sqlite'
import { realpathSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { posix } from 'node:path'
import type { JournalDisabledReason, PathClassification } from './types.ts'

// ─── A) DDL + migration ──────────────────────────────────────────────────────────────────────────

/** Stored in `PRAGMA user_version`. A file above this was written by a NEWER agentop. */
export const JOURNAL_DB_VERSION = 1

/**
 * The spec's DDL (§19.2), with ONE deliberate deviation: `AUTOINCREMENT` on the rowid.
 *
 * `rowid` is the cursor every projection resumes from (`readFrom(cursor)` reads `rowid > cursor`).
 * Without AUTOINCREMENT, SQLite hands a new row `max(rowid) + 1` — so once the rows at the TOP of
 * the table are deleted, their rowids are handed out AGAIN. Compaction (§19.3) is allowed to delete
 * rows; the day it deletes the tail (or everything), the next event is written under a rowid a
 * projection has already moved past, and that projection skips it FOREVER, with nothing anywhere
 * saying so. AUTOINCREMENT makes rowids strictly monotonic for the life of the file (the high-water
 * mark lives in `sqlite_sequence`), which is the only property a cursor needs. Its cost is one extra
 * row update per insert batch, which is noise beside the batch's own fsync.
 */
export const EVENTS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events (
  rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  schema          INTEGER NOT NULL,
  type            TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  session_id      TEXT,
  run_id          TEXT,
  agent_id        TEXT,
  task_id         TEXT,
  source_kind     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  source_version  TEXT,
  mode            TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  source_ref      TEXT,
  data            TEXT NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS events_run ON events(run_id, occurred_at)',
  'CREATE INDEX IF NOT EXISTS events_type ON events(type, occurred_at)',
]

/**
 * `MIGRATIONS[i]` takes a file from `user_version` i to i + 1. Its length IS the current version
 * (a test pins that), so adding version 2 is appending one entry, and a file at version 1 runs only
 * the step it is missing.
 */
const MIGRATIONS: readonly (readonly string[])[] = [EVENTS_DDL]

/** Why the journal could not be opened, as a code — the caller turns it into `JournalStatus`. */
export class JournalOpenError extends Error {
  constructor(readonly reason: JournalDisabledReason, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JournalOpenError'
  }
}

/**
 * Bring the file up to `JOURNAL_DB_VERSION`. Idempotent.
 *
 * `BEGIN IMMEDIATE` takes the write lock BEFORE `user_version` is read, so two processes migrating
 * a fresh file serialise: the second one waits (busy_timeout), then reads the version the first one
 * committed and does nothing. A deferred BEGIN would let both read 0 and both try to create.
 *
 * A file ABOVE our version is refused and left untouched: its tables may carry columns or meanings
 * this build does not know, and writing rows it thinks are complete into them is the silent version
 * of a crash.
 */
export function migrate(db: Database): void {
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (cause) {
    throw new JournalOpenError('migrate-failed', 'could not start the migration transaction', { cause })
  }
  try {
    const row = db.query('PRAGMA user_version').get() as { user_version?: unknown } | null
    const current = typeof row?.user_version === 'number' ? row.user_version : 0
    if (current > JOURNAL_DB_VERSION) {
      throw new JournalOpenError(
        'db-schema-too-new',
        `journal schema version ${current} is newer than this build's ${JOURNAL_DB_VERSION}`,
      )
    }
    if (current < JOURNAL_DB_VERSION) {
      for (let v = current; v < JOURNAL_DB_VERSION; v++) {
        for (const sql of MIGRATIONS[v] ?? []) db.exec(sql)
      }
      // An integer constant, never input — PRAGMA takes no bound parameters.
      db.exec(`PRAGMA user_version = ${JOURNAL_DB_VERSION}`)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* the failure may already have ended the transaction */ }
    if (err instanceof JournalOpenError) throw err
    throw new JournalOpenError('migrate-failed', 'could not create or migrate the journal schema', { cause: err })
  }
}

// ─── B) Pragma ORDER ─────────────────────────────────────────────────────────────────────────────

/**
 * 10 s, not the 5 s the measurement ran at. 5 s was never exceeded on ext4, but the DrvFs worst
 * case (3,2 s at 8 writers) already sat at 64 % of it, and the research recommends 10–15 s for any
 * machine whose data dir could land on a slow filesystem. Waiting longer costs nothing when there is
 * no contention; timing out costs a lost batch.
 */
export const BUSY_TIMEOUT_MS = 10_000

const BUSY_TIMEOUT_PRAGMA = `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`
const JOURNAL_MODE_PRAGMA = 'PRAGMA journal_mode = WAL'
const SYNCHRONOUS_PRAGMA = 'PRAGMA synchronous = NORMAL'

/**
 * In this order, on EVERY connection, every time. `busy_timeout` first — see rule 1 in the header.
 * `synchronous = NORMAL` is safe against a process crash (measured: SIGKILL mid-transaction always
 * recovered clean) and trades only the last transaction(s) on an OS power loss.
 */
export const CONNECTION_PRAGMAS: readonly string[] = [
  BUSY_TIMEOUT_PRAGMA,
  JOURNAL_MODE_PRAGMA,
  SYNCHRONOUS_PRAGMA,
]

/** The part of a connection `configureConnection` needs — small, so the ORDER is testable with a fake. */
export interface SqlConn {
  exec(sql: string): unknown
  query(sql: string): { get(): unknown }
}

/**
 * Apply `CONNECTION_PRAGMAS` in order. `journal_mode` goes through `query().get()` rather than
 * `exec` because its answer is the point: SQLite reports the mode it ACTUALLY used, and anything but
 * `wal` is a refusal (rule 2). A throw from SQLite itself propagates unchanged — the caller
 * (`openDatabase`) classifies it.
 */
export function configureConnection(db: SqlConn): void {
  for (const sql of CONNECTION_PRAGMAS) {
    if (sql !== JOURNAL_MODE_PRAGMA) {
      db.exec(sql)
      continue
    }
    const row = db.query(sql).get() as { journal_mode?: unknown } | null | undefined
    const mode = typeof row?.journal_mode === 'string' ? row.journal_mode : ''
    if (mode.toLowerCase() !== 'wal') {
      throw new JournalOpenError(
        'wal-unavailable',
        `SQLite answered journal_mode=${mode || '(nothing)'} instead of wal`,
      )
    }
  }
}

// ─── C) The network-filesystem refusal ───────────────────────────────────────────────────────────

/** Linux fs types (as `/proc/self/mountinfo` names them) where WAL is unsafe. `9p` is WSL's `/mnt/c`. */
export const NETWORK_FS_LINUX: ReadonlySet<string> = new Set([
  'nfs', 'nfs4', 'cifs', 'smb3', '9p', 'fuse.sshfs',
])

/** macOS fs type names (`f_fstypename`) where WAL is unsafe. */
export const NETWORK_FS_DARWIN: ReadonlySet<string> = new Set([
  'nfs', 'smbfs', 'afpfs', 'webdav',
])

export interface MountEntry {
  mountPoint: string
  fsType: string
}

/** mountinfo escapes these four bytes as a backslash plus three octal digits. */
function unescapeMountinfo(s: string): string {
  return s.replace(/\\(040|011|012|134)/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

/**
 * `/proc/self/mountinfo`: `id parent maj:min root MOUNTPOINT opts [optional fields…] - FSTYPE src
 * superopts`. The optional fields (`shared:1`, `master:3`) vary in number, so the fs type is found
 * after the lone `-` separator, never by position. A malformed line is skipped, not fatal.
 */
export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const fields = line.split(' ')
    const sep = fields.indexOf('-')
    const mountPoint = fields[4]
    const fsType = sep >= 0 ? fields[sep + 1] : undefined
    if (sep < 6 || !mountPoint || !fsType) continue
    out.push({ mountPoint: unescapeMountinfo(mountPoint), fsType })
  }
  return out
}

/**
 * `/sbin/mount` on macOS: `<source> on <mount point> (<fstype>, <flags…>)`. That first word in the
 * parentheses is `getmntinfo`'s `f_fstypename` — the same field `statfs(2)` reports, which Node's and
 * Bun's `statfs` do not expose. The mount point is taken up to the LAST ` (`, so one containing the
 * word "on" still parses.
 */
export function parseDarwinMount(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split('\n')) {
    const m = /^.*? on (.+) \(([^,()]+)(?:,[^()]*)?\)\s*$/.exec(line)
    const mountPoint = m?.[1]
    const fsType = m?.[2]?.trim()
    if (!mountPoint || !fsType) continue
    out.push({ mountPoint, fsType })
  }
  return out
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') || '/' : p
}

/**
 * The mount a path lives on is the LONGEST mount point that is a prefix of it at a path-SEGMENT
 * boundary — `/mnt/c` must not claim `/mnt/cx`. On equal length the LATER entry wins: mountinfo
 * lists an over-mount after the mount it hides, and the later one is what the path actually reaches.
 */
export function classifyByMounts(
  path: string,
  mounts: MountEntry[],
  network: ReadonlySet<string>,
): PathClassification {
  const target = stripTrailingSlash(path)
  let best: MountEntry | undefined
  for (const m of mounts) {
    const mp = stripTrailingSlash(m.mountPoint)
    const under = mp === '/' ? target.startsWith('/') : target === mp || target.startsWith(mp + '/')
    if (!under) continue
    if (!best || mp.length >= stripTrailingSlash(best.mountPoint).length) best = m
  }
  if (!best) return { kind: 'unknown' }
  return {
    kind: network.has(best.fsType) ? 'network' : 'local',
    fsType: best.fsType,
    mountPoint: best.mountPoint,
  }
}

/**
 * A Windows UNC path: `\\server\share\…`, or its long form `\\?\UNC\server\…`. NOT `\\?\C:\` (a
 * long-form local drive) and NOT `\\.\` (a device namespace). Forward slashes are accepted because
 * Windows accepts them. A mapped drive letter is NOT detectable here — that needs a native call — so
 * it stays `unknown` and opens.
 */
export function isUncPath(p: string): boolean {
  const s = p.replace(/\//g, '\\')
  if (/^\\\\\?\\UNC\\[^\\]+/i.test(s)) return true
  if (s.startsWith('\\\\?\\') || s.startsWith('\\\\.\\')) return false
  return /^\\\\[^\\?]+/.test(s)
}

/** The OS reads `classifyJournalPath` needs. Every method answers `null` rather than throwing. */
export interface PathProbe {
  platform: NodeJS.Platform
  realpath(p: string): string | null
  readMountinfo(): string | null
  readDarwinMounts(): string | null
}

/**
 * Resolve through the NEAREST EXISTING ancestor and re-append the part that does not exist yet: the
 * journal's directory is created on first open, so it often is not there when we ask — and a symlink
 * that points into an NFS mount must be judged by where it LEADS, not by where it sits.
 */
function resolveThroughAncestor(dir: string, probe: PathProbe): string {
  let p = stripTrailingSlash(posix.resolve('/', dir))
  const tail: string[] = []
  for (;;) {
    const real = probe.realpath(p)
    if (real !== null) return tail.length ? posix.join(real, ...tail.reverse()) : real
    const parent = posix.dirname(p)
    if (parent === p) return posix.resolve('/', dir)
    tail.push(posix.basename(p))
    p = parent
  }
}

/** Is the journal's directory local, network, or undeterminable? PURE given the probe. */
export function classifyJournalPath(dir: string, probe: PathProbe): PathClassification {
  switch (probe.platform) {
    case 'linux': {
      const text = probe.readMountinfo()
      if (text === null) return { kind: 'unknown' }
      return classifyByMounts(resolveThroughAncestor(dir, probe), parseMountinfo(text), NETWORK_FS_LINUX)
    }
    case 'darwin': {
      const text = probe.readDarwinMounts()
      if (text === null) return { kind: 'unknown' }
      return classifyByMounts(resolveThroughAncestor(dir, probe), parseDarwinMount(text), NETWORK_FS_DARWIN)
    }
    case 'win32':
      // The RAW path: resolving a mapped drive could not reveal a share anyway, and a UNC path is
      // already its own answer.
      return isUncPath(dir) ? { kind: 'network' } : { kind: 'unknown' }
    default:
      return { kind: 'unknown' }
  }
}

/** The real IO behind `PathProbe`. Every failure is `null`, which classifies as `unknown` and opens. */
export function defaultPathProbe(): PathProbe {
  return {
    platform: process.platform,
    realpath(p) {
      try { return realpathSync.native(p) } catch { return null }
    },
    readMountinfo() {
      try { return readFileSync('/proc/self/mountinfo', 'utf8') } catch { return null }
    },
    readDarwinMounts() {
      try {
        return execFileSync('/sbin/mount', [], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        return null
      }
    },
  }
}

// ─── D) Open ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Open (creating if needed), configure, migrate. Any failure closes the handle before rethrowing —
 * a half-configured connection left open would keep a lock on a file nobody is going to write. A
 * SQLite failure inside `configureConnection` (not a `JournalOpenError`) is `open-failed`.
 * The network-filesystem check is the CALLER's (it must run before the file is created at all).
 */
export function openDatabase(Ctor: typeof Database, path: string): Database {
  let db: Database
  try {
    db = new Ctor(path, { create: true })
  } catch (cause) {
    throw new JournalOpenError('open-failed', `could not open ${path}`, { cause })
  }
  try {
    try {
      configureConnection(db)
    } catch (err) {
      if (err instanceof JournalOpenError) throw err
      throw new JournalOpenError('open-failed', `could not configure ${path}`, { cause: err })
    }
    migrate(db)
    return db
  } catch (err) {
    try { db.close() } catch { /* already gone */ }
    throw err
  }
}
