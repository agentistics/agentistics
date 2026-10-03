import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { TMP_MARK, writePrivateAtomic, type SecretFs } from './atomic'
import { decideMigration, migrateFile, type MigrationItem, type Sealer } from './migrate'
import { newDataKey, openRecord, sealToBytes } from './seal'

class Crash extends Error {}

interface Node { data: Uint8Array; mode: number; mtimeMs: number }

/**
 * An in-memory filesystem whose every syscall is counted; `crashAt = n` throws on the n-th one —
 * the process dies there, and whatever was done before it is on "disk". Every byte any tmp file ever
 * held is recorded, so a test can prove no plaintext was ever written outside the original.
 */
function fakeFs(crashAt = Infinity) {
  const files = new Map<string, Node>()
  const tmpHistory: Uint8Array[] = []
  let n = 0
  let clock = 1000
  const tick = (what: string) => { if (++n === crashAt) throw new Crash(what) }
  const fs: SecretFs = {
    async mkdirp() { tick('mkdir') },
    async openExclusive(path, mode) {
      tick('open')
      if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      files.set(path, { data: new Uint8Array(), mode, mtimeMs: ++clock })
      return handle(path)
    },
    async openExisting(path) { tick('open-existing'); return handle(path) },
    async rename(a, b) { tick('rename'); const x = files.get(a)!; files.delete(a); files.set(b, x) },
    async chmod(p, mode) { tick('chmod'); files.get(p)!.mode = mode },
    async fsyncDir() { tick('fsync-dir') },
    async readFile(p) { tick('read'); return files.get(p)?.data ?? null },
    async unlink(p) { tick('unlink'); files.delete(p) },
    async lstat(p) { const x = files.get(p); return x ? { mode: x.mode, size: x.data.length, mtimeMs: x.mtimeMs } : null },
    async readdir(dir) { return [...files.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1)) },
    randomBytes: (k) => new Uint8Array(randomBytes(k)),
  }
  function handle(path: string) {
    return {
      async write(d: Uint8Array) {
        tick('write')
        const x = files.get(path)!
        x.data = new Uint8Array(d); x.mtimeMs = ++clock
        if (path.includes(TMP_MARK)) tmpHistory.push(new Uint8Array(d))
      },
      async sync() { tick('fsync') },
      async close() { tick('close') },
    }
  }
  return { fs, files, tmpHistory, reset(c = Infinity) { n = 0; crashAt = c } }
}

const PLAIN = new TextEncoder().encode(JSON.stringify({ token: 'TEST-NOT-A-SECRET-' + randomBytes(6).toString('hex') }))
const ITEM: MigrationItem = { purpose: 'github-backup', name: 'github-backup', plainPath: '/d/github-backup.json', sealedPath: '/d/github-backup.sealed' }

function sealer(): Sealer & { dek: Uint8Array; kid: string } {
  const { dek, kid } = newDataKey()
  return {
    dek, kid,
    seal: (purpose, name, plaintext) => sealToBytes({ dek, kid, purpose, name, plaintext }),
    open: (purpose, name, bytes) => openRecord({ dek, kid, purpose, name, bytes }),
  }
}

function containsPlain(b: Uint8Array): boolean {
  return Buffer.from(b).includes(Buffer.from(PLAIN))
}

describe('decideMigration — the recovery table', () => {
  it('maps every row', () => {
    expect(decideMigration(false, { state: 'absent' })).toEqual({ kind: 'nothing' })
    expect(decideMigration(false, { state: 'equal' })).toEqual({ kind: 'nothing' })
    expect(decideMigration(true, { state: 'absent' })).toEqual({ kind: 'migrate' })
    expect(decideMigration(true, { state: 'equal' })).toEqual({ kind: 'scrub' })
    expect(decideMigration(true, { state: 'differs' })).toEqual({ kind: 'conflict' })
    expect(decideMigration(true, { state: 'fails', code: 'tampered' })).toEqual({ kind: 'refuse', code: 'tampered' })
    expect(decideMigration(true, { state: 'fails', code: 'wrong-machine', kid: 'k' })).toEqual({ kind: 'refuse', code: 'wrong-machine', kid: 'k' })
  })
})

describe('migrateFile — correct at every crash point', () => {
  // Count the syscalls of one clean run, then crash at each of them in turn.
  const probe = fakeFs()
  probe.files.set(ITEM.plainPath, { data: PLAIN, mode: 0o644, mtimeMs: 1 })
  let total = 0
  it('a clean run migrates', async () => {
    const s = sealer()
    let counted = 0
    const counting: SecretFs = new Proxy(probe.fs, { get: (t, k) => { const v = (t as any)[k]; return typeof v === 'function' && k !== 'randomBytes' && k !== 'lstat' && k !== 'readdir' ? (...a: unknown[]) => { counted++; return v.apply(t, a) } : v } })
    const audit: unknown[] = []
    expect(await migrateFile(counting, s, ITEM, e => audit.push(e))).toEqual({ status: 'migrated' })
    expect(audit).toEqual([{ type: 'vault.migrated', purpose: 'github-backup', name: 'github-backup' }])
    expect(probe.files.has(ITEM.plainPath)).toBe(false)
    total = counted + 6 // handle calls (write/sync/close ×2) are counted inside the fake
  })

  for (let at = 1; at <= 30; at++) {
    it(`crash at syscall ${at}, then restart → sealed only, reads back equal, original gone, no plaintext tmp`, async () => {
      const s = sealer()
      const f = fakeFs(at)
      f.files.set(ITEM.plainPath, { data: PLAIN, mode: 0o664, mtimeMs: 1 })
      try { await migrateFile(f.fs, s, ITEM) } catch (e) { if (!(e instanceof Crash)) throw e }
      f.reset()
      const second = await migrateFile(f.fs, s, ITEM)
      expect(['migrated', 'finished', 'nothing']).toContain(second.status)
      expect(f.files.has(ITEM.plainPath)).toBe(false)
      expect([...f.files.keys()].filter(k => k.includes(TMP_MARK))).toEqual([])
      const sealed = f.files.get(ITEM.sealedPath)
      expect(sealed).toBeDefined()
      expect(sealed!.mode).toBe(0o600)
      const o = s.open(ITEM.purpose, ITEM.name, sealed!.data)
      expect(o.ok && Buffer.from(o.plaintext).equals(Buffer.from(PLAIN))).toBe(true)
      expect(f.tmpHistory.some(containsPlain)).toBe(false)
      for (const node of f.files.values()) expect(containsPlain(node.data)).toBe(false)
    })
  }

  it('idempotent: a second run does nothing', async () => {
    const s = sealer()
    const f = fakeFs()
    f.files.set(ITEM.plainPath, { data: PLAIN, mode: 0o600, mtimeMs: 1 })
    expect((await migrateFile(f.fs, s, ITEM)).status).toBe('migrated')
    const before = Buffer.from(f.files.get(ITEM.sealedPath)!.data).toString()
    expect(await migrateFile(f.fs, s, ITEM)).toEqual({ status: 'nothing' })
    expect(Buffer.from(f.files.get(ITEM.sealedPath)!.data).toString()).toBe(before)
  })

  it('sealed + plain that differ: BOTH are kept, nothing scrubbed, whichever is newer', async () => {
    for (const plainNewer of [true, false]) {
      const s = sealer()
      const f = fakeFs()
      f.files.set(ITEM.plainPath, { data: PLAIN, mode: 0o600, mtimeMs: 1 })
      await writePrivateAtomic(f.fs, ITEM.sealedPath, s.seal(ITEM.purpose, ITEM.name, new TextEncoder().encode('other')))
      f.files.get(ITEM.plainPath)!.mtimeMs = plainNewer ? 1e9 : 0
      const sealedBefore = Buffer.from(f.files.get(ITEM.sealedPath)!.data).toString()
      expect(await migrateFile(f.fs, s, ITEM)).toEqual({ status: 'conflict' })
      expect(f.files.get(ITEM.plainPath)!.data).toEqual(PLAIN)
      expect(Buffer.from(f.files.get(ITEM.sealedPath)!.data).toString()).toBe(sealedBefore)
    }
  })

  it('sealed + plain where the sealed one does not open: both left, nothing used', async () => {
    const s = sealer()
    const other = sealer()
    const f = fakeFs()
    f.files.set(ITEM.plainPath, { data: PLAIN, mode: 0o600, mtimeMs: 1 })
    await writePrivateAtomic(f.fs, ITEM.sealedPath, other.seal(ITEM.purpose, ITEM.name, PLAIN))
    const r = await migrateFile(f.fs, s, ITEM)
    expect(r).toEqual({ status: 'refused', code: 'wrong-machine', kid: other.kid })
    expect(f.files.has(ITEM.plainPath)).toBe(true)
    f.files.get(ITEM.sealedPath)!.data = new TextEncoder().encode('{"junk":1}')
    expect(await migrateFile(f.fs, s, ITEM)).toEqual({ status: 'refused', code: 'tampered' })
    expect(f.files.has(ITEM.plainPath)).toBe(true)
  })

  it('a stray tmp from a crash inside step 1 is unlinked', async () => {
    const s = sealer()
    const f = fakeFs()
    f.files.set(ITEM.sealedPath + TMP_MARK + 'abcdef', { data: s.seal('github-backup', 'b', new Uint8Array(1)), mode: 0o600, mtimeMs: 1 })
    expect(await migrateFile(f.fs, s, ITEM)).toEqual({ status: 'nothing' })
    expect([...f.files.keys()]).toEqual([])
  })

  it('a failed write leaves the original untouched', async () => {
    const s = sealer()
    const f = fakeFs()
    f.files.set(ITEM.plainPath, { data: PLAIN, mode: 0o600, mtimeMs: 1 })
    const broken: SecretFs = { ...f.fs, openExclusive: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) } }
    expect(await migrateFile(broken, s, ITEM)).toEqual({ status: 'failed', reason: 'ENOSPC' })
    expect(f.files.get(ITEM.plainPath)!.data).toEqual(PLAIN)
  })
})
