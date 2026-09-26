import { describe, expect, test, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUSY_TIMEOUT_MS,
  CONNECTION_PRAGMAS,
  EVENTS_DDL,
  JOURNAL_DB_VERSION,
  JournalOpenError,
  NETWORK_FS_DARWIN,
  NETWORK_FS_LINUX,
  classifyByMounts,
  classifyJournalPath,
  configureConnection,
  defaultPathProbe,
  isUncPath,
  migrate,
  openDatabase,
  parseDarwinMount,
  parseMountinfo,
  type PathProbe,
  type SqlConn,
} from './schema.ts'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'journal-schema-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof JournalOpenError ? e.reason : `not a JournalOpenError: ${String(e)}`
  }
  return undefined
}

// ─── B) pragmas ──────────────────────────────────────────────────────────────────────────────────

class RecordingConn implements SqlConn {
  calls: string[] = []
  constructor(private readonly mode: string) {}
  exec(sql: string) { this.calls.push(`exec:${sql}`) }
  query(sql: string) {
    this.calls.push(`query:${sql}`)
    return { get: () => ({ journal_mode: this.mode }) }
  }
}

describe('connection pragmas', () => {
  test('busy_timeout precedes journal_mode, which precedes synchronous', () => {
    expect(CONNECTION_PRAGMAS).toEqual([
      'PRAGMA busy_timeout = 10000',
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
    ])
    const bt = CONNECTION_PRAGMAS.findIndex(s => s.includes('busy_timeout'))
    const jm = CONNECTION_PRAGMAS.findIndex(s => s.includes('journal_mode'))
    expect(bt).toBeGreaterThanOrEqual(0)
    expect(bt).toBeLessThan(jm)
    expect(BUSY_TIMEOUT_MS).toBe(10_000)
  })

  test('configureConnection runs them in that exact order, reading journal_mode back', () => {
    const conn = new RecordingConn('wal')
    configureConnection(conn)
    expect(conn.calls).toEqual([
      'exec:PRAGMA busy_timeout = 10000',
      'query:PRAGMA journal_mode = WAL',
      'exec:PRAGMA synchronous = NORMAL',
    ])
  })

  test('journal_mode compared case-insensitively', () => {
    expect(reasonOf(() => configureConnection(new RecordingConn('WAL')))).toBeUndefined()
  })

  test('a silent downgrade to another journal_mode is wal-unavailable', () => {
    const conn = new RecordingConn('delete')
    expect(reasonOf(() => configureConnection(conn))).toBe('wal-unavailable')
    // synchronous is never set on a connection that was refused
    expect(conn.calls.some(c => c.includes('synchronous'))).toBe(false)
  })

  test('a real bun:sqlite file ends up with the configured values', () => {
    const db = new Database(join(tempDir(), 'j.db'), { create: true })
    try {
      configureConnection(db)
      // SQLite names this column `timeout`, not `busy_timeout` — read it positionally
      const bt = Object.values(db.query('PRAGMA busy_timeout').get() as Record<string, number>)[0]
      expect(bt).toBe(10000)
      expect((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
      expect((db.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(1)
    } finally {
      db.close()
    }
  })
})

// ─── A) migration ────────────────────────────────────────────────────────────────────────────────

function openRaw(): Database {
  const db = new Database(join(tempDir(), 'j.db'), { create: true })
  configureConnection(db)
  return db
}
function names(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all() as { name: string }[])
    .map(r => r.name)
}
function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

const insert =
  'INSERT OR IGNORE INTO events (event_id, schema, type, occurred_at, recorded_at, source_kind, ' +
  "source_id, mode, confidence, adapter_version, data) VALUES (?, 1, 't', 'a', 'b', 'k', 'i', 'm', 'c', 'v', '{}')"

describe('migrate', () => {
  test('one DDL step per version', () => {
    expect(JOURNAL_DB_VERSION).toBe(1)
    expect(EVENTS_DDL.length).toBe(3)
  })

  test('a fresh file gets the table, both indexes, and user_version 1', () => {
    const db = openRaw()
    try {
      migrate(db)
      const n = names(db)
      expect(n).toContain('events')
      expect(n).toContain('events_run')
      expect(n).toContain('events_type')
      expect(userVersion(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  test('running twice is a no-op', () => {
    const db = openRaw()
    try {
      migrate(db)
      db.query(insert).run('e1')
      const before = names(db)
      migrate(db)
      expect(names(db)).toEqual(before)
      expect(userVersion(db)).toBe(1)
      expect((db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
    }
  })

  test('a newer user_version is refused and nothing is created', () => {
    const db = openRaw()
    try {
      db.exec('PRAGMA user_version = 2')
      expect(reasonOf(() => migrate(db))).toBe('db-schema-too-new')
      expect(names(db)).toEqual([])
      expect(userVersion(db)).toBe(2)
      // and the transaction was rolled back: a new one can start
      db.exec('BEGIN IMMEDIATE')
      db.exec('COMMIT')
    } finally {
      db.close()
    }
  })

  test('a duplicate event_id is ignored, structurally', () => {
    const db = openRaw()
    try {
      migrate(db)
      expect(db.query(insert).run('dup').changes).toBe(1)
      expect(db.query(insert).run('dup').changes).toBe(0)
    } finally {
      db.close()
    }
  })

  test('rowids are never reused after the tail is deleted (AUTOINCREMENT)', () => {
    const db = openRaw()
    try {
      migrate(db)
      db.query(insert).run('a')
      db.query(insert).run('b')
      const top = (db.query('SELECT MAX(rowid) AS m FROM events').get() as { m: number }).m
      db.exec('DELETE FROM events')
      db.query(insert).run('c')
      const next = (db.query("SELECT rowid AS r FROM events WHERE event_id = 'c'").get() as { r: number }).r
      expect(next).toBeGreaterThan(top)
    } finally {
      db.close()
    }
  })

  test('a SQLite failure inside the migration is migrate-failed', () => {
    const db = openRaw()
    try {
      db.exec('CREATE VIEW events_run AS SELECT 1') // name clash with the index
      expect(reasonOf(() => migrate(db))).toBe('migrate-failed')
      expect(userVersion(db)).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('openDatabase', () => {
  test('opens, configures and migrates', () => {
    const db = openDatabase(Database, join(tempDir(), 'j.db'))
    try {
      expect(userVersion(db)).toBe(1)
      expect((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    } finally {
      db.close()
    }
  })

  test('an unopenable path is open-failed', () => {
    const path = join(tempDir(), 'missing', 'deeper', 'j.db')
    expect(reasonOf(() => openDatabase(Database, path))).toBe('open-failed')
  })

  test('a file from a newer build is refused', () => {
    const path = join(tempDir(), 'j.db')
    const pre = new Database(path, { create: true })
    pre.exec('PRAGMA user_version = 7')
    pre.close()
    expect(reasonOf(() => openDatabase(Database, path))).toBe('db-schema-too-new')
  })
})

// ─── C) network filesystems ──────────────────────────────────────────────────────────────────────

const WSL_MOUNTINFO = [
  '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw,discard,errors=remount-ro,data=ordered',
  '76 58 0:48 / /mnt/c rw,noatime - 9p C:\\134 rw,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5',
  '53 58 0:31 / /mnt/wsl rw,relatime shared:1 - tmpfs none rw',
  '90 58 0:60 / /srv/my\\040share rw,relatime - nfs4 host:/export rw,vers=4.2',
  '91 58 0:61 / /home/u/remote rw,nosuid shared:5 master:2 - fuse.sshfs u@h:/ rw,user_id=1000',
  '92 58 0:62 / /media/win rw - cifs //srv/win rw,vers=3.0',
  'garbage line',
  '',
].join('\n')

describe('parseMountinfo', () => {
  test('reads the mount point and the fs type after the separator', () => {
    const m = parseMountinfo(WSL_MOUNTINFO)
    expect(m).toEqual([
      { mountPoint: '/', fsType: 'ext4' },
      { mountPoint: '/mnt/c', fsType: '9p' },
      { mountPoint: '/mnt/wsl', fsType: 'tmpfs' },
      { mountPoint: '/srv/my share', fsType: 'nfs4' },
      { mountPoint: '/home/u/remote', fsType: 'fuse.sshfs' },
      { mountPoint: '/media/win', fsType: 'cifs' },
    ])
  })

  test('unescapes tab, newline and backslash too', () => {
    const m = parseMountinfo('1 2 0:1 / /a\\011b\\012c\\134d rw - ext4 x rw')
    expect(m).toEqual([{ mountPoint: '/a\tb\nc\\d', fsType: 'ext4' }])
  })
})

describe('classifyByMounts', () => {
  const mounts = parseMountinfo(WSL_MOUNTINFO)
  const c = (p: string) => classifyByMounts(p, mounts, NETWORK_FS_LINUX)

  test('WSL /mnt/c is network (9p); the VM disk is local ext4', () => {
    expect(c('/mnt/c/Users/x')).toEqual({ kind: 'network', fsType: '9p', mountPoint: '/mnt/c' })
    expect(c('/home/x')).toEqual({ kind: 'local', fsType: 'ext4', mountPoint: '/' })
  })

  test('matches at a segment boundary only', () => {
    expect(c('/mnt/cx/y').fsType).toBe('ext4')
    expect(c('/mnt/c').kind).toBe('network')
    expect(c('/mnt/c/').kind).toBe('network')
  })

  test('longest prefix wins', () => {
    expect(c('/mnt/wsl/z')).toEqual({ kind: 'local', fsType: 'tmpfs', mountPoint: '/mnt/wsl' })
  })

  test('sshfs, nfs4 and cifs are network', () => {
    expect(c('/home/u/remote/.agentistics').fsType).toBe('fuse.sshfs')
    expect(c('/home/u/remote/.agentistics').kind).toBe('network')
    expect(c('/srv/my share/j').kind).toBe('network')
    expect(c('/media/win/a').kind).toBe('network')
  })

  test('on equal mount points the later (over-mount) entry wins', () => {
    const over = [
      { mountPoint: '/data', fsType: 'nfs' },
      { mountPoint: '/data', fsType: 'ext4' },
    ]
    expect(classifyByMounts('/data/j', over, NETWORK_FS_LINUX).kind).toBe('local')
  })

  test('no match is unknown', () => {
    expect(classifyByMounts('/x', [{ mountPoint: '/y', fsType: 'nfs' }], NETWORK_FS_LINUX)).toEqual({ kind: 'unknown' })
  })
})

const DARWIN_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)',
  '//u@srv/share on /Volumes/share (smbfs, nodev, nosuid, mounted by u)',
  'srv:/export on /Volumes/nfs on thing (nfs, nodev, nosuid)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
].join('\n')

describe('parseDarwinMount', () => {
  test('reads mount point and f_fstypename', () => {
    expect(parseDarwinMount(DARWIN_MOUNT)).toEqual([
      { mountPoint: '/', fsType: 'apfs' },
      { mountPoint: '/System/Volumes/Data', fsType: 'apfs' },
      { mountPoint: '/Volumes/share', fsType: 'smbfs' },
      { mountPoint: '/Volumes/nfs on thing', fsType: 'nfs' },
      { mountPoint: '/System/Volumes/Data/home', fsType: 'autofs' },
    ])
  })

  test('smbfs is network, apfs local', () => {
    const m = parseDarwinMount(DARWIN_MOUNT)
    expect(classifyByMounts('/Volumes/share/x', m, NETWORK_FS_DARWIN).kind).toBe('network')
    expect(classifyByMounts('/Users/u/.agentistics', m, NETWORK_FS_DARWIN)).toEqual({ kind: 'local', fsType: 'apfs', mountPoint: '/' })
  })
})

describe('isUncPath', () => {
  const cases: [string, boolean][] = [
    ['\\\\server\\share\\dir', true],
    ['\\\\server\\share', true],
    ['//server/share/dir', true],
    ['\\\\?\\UNC\\server\\share\\x', true],
    ['\\\\?\\unc\\server\\share', true],
    ['\\\\?\\C:\\Users\\x', false],
    ['\\\\.\\PhysicalDrive0', false],
    ['C:\\Users\\x', false],
    ['Z:\\mapped', false],
    ['/home/x', false],
  ]
  for (const [p, want] of cases) test(`${p} → ${want}`, () => expect(isUncPath(p)).toBe(want))
})

function fakeProbe(over: Partial<PathProbe>): PathProbe {
  return {
    platform: 'linux',
    realpath: p => p,
    readMountinfo: () => WSL_MOUNTINFO,
    readDarwinMounts: () => DARWIN_MOUNT,
    ...over,
  }
}

describe('classifyJournalPath', () => {
  test('a nonexistent tail is resolved through its nearest existing ancestor', () => {
    const seen: string[] = []
    const probe = fakeProbe({
      realpath: p => {
        seen.push(p)
        return p === '/home/u' ? '/mnt/c/Users/u' : null // /home/u is a symlink into DrvFs
      },
    })
    expect(classifyJournalPath('/home/u/.agentistics/journal', probe)).toEqual({
      kind: 'network', fsType: '9p', mountPoint: '/mnt/c',
    })
    expect(seen).toEqual(['/home/u/.agentistics/journal', '/home/u/.agentistics', '/home/u'])
  })

  test('nothing resolvable still classifies the raw path', () => {
    expect(classifyJournalPath('/home/x/j', fakeProbe({ realpath: () => null })).kind).toBe('local')
  })

  test('unreadable mountinfo is unknown', () => {
    expect(classifyJournalPath('/mnt/c/x', fakeProbe({ readMountinfo: () => null }))).toEqual({ kind: 'unknown' })
  })

  test('darwin uses mount output', () => {
    expect(classifyJournalPath('/Volumes/share/j', fakeProbe({ platform: 'darwin' })).kind).toBe('network')
    expect(classifyJournalPath('/x', fakeProbe({ platform: 'darwin', readDarwinMounts: () => null })).kind).toBe('unknown')
  })

  test('win32: UNC is network, anything else unknown, and realpath is never asked', () => {
    const probe = fakeProbe({ platform: 'win32', realpath: () => { throw new Error('must not be called') } })
    expect(classifyJournalPath('\\\\srv\\share\\agentistics', probe)).toEqual({ kind: 'network' })
    expect(classifyJournalPath('C:\\Users\\u\\.agentistics', probe)).toEqual({ kind: 'unknown' })
  })

  test('an unsupported platform is unknown', () => {
    expect(classifyJournalPath('/x', fakeProbe({ platform: 'aix' }))).toEqual({ kind: 'unknown' })
  })

  test.skipIf(process.platform !== 'linux')('the real tmpdir on this machine is local', () => {
    expect(classifyJournalPath(tmpdir(), defaultPathProbe()).kind).toBe('local')
  })

  test.skipIf(process.platform !== 'linux')('a real symlink is judged by its target', () => {
    const d = tempDir()
    mkdirSync(join(d, 'real'))
    symlinkSync(join(d, 'real'), join(d, 'link'))
    const probe = defaultPathProbe()
    expect(probe.realpath(join(d, 'link'))).toBe(probe.realpath(join(d, 'real')))
    expect(classifyJournalPath(join(d, 'link', 'not-yet'), probe).kind).toBe('local')
  })
})

test('schema.ts does not touch the OS at import time', () => {
  const src = readFileSync(join(import.meta.dir, 'schema.ts'), 'utf8')
  // defaultPathProbe is the only caller of the IO primitives, and it is a function
  expect(src).not.toMatch(/^(?:const|let|export const)\s+\w+\s*=\s*defaultPathProbe\(/m)
})
