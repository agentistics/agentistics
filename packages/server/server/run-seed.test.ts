import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { applySeed, buildSeed, ensureNoStructured, heavyLockFds, SEED_ALLOW, SEED_NEVER, SeedRefusal } from './run-seed'

const tmp = () => mkdtempSync(join(tmpdir(), 'ambseed-'))

function fakeStore(root: string) {
  for (const n of [...SEED_ALLOW, ...SEED_NEVER]) {
    const p = join(root, n)
    if (n.includes('.')) writeFileSync(p, n.endsWith('.db') ? '' : '{}')
    else { mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'x'), 'x') }
  }
  writeFileSync(join(root, 'foo.sealed'), 's')
}

describe('semente copia (I9, I11)', () => {
  test('I9 only SEED_ALLOW reaches the staging; every "never" item is absent', () => {
    const src = tmp(), stg = tmp()
    fakeStore(src)
    // real sqlite for the .db entries so the default snapshot works
    for (const n of ['journal.db', 'cache.db', 'git-stats.db']) { rmSync(join(src, n)); const d = new Database(join(src, n)); d.run('create table t(a)'); d.run('insert into t values (1)'); d.close() }
    const copied = buildSeed(src, stg)
    expect(copied.sort()).toEqual([...SEED_ALLOW].sort())
    const got = readdirSync(stg).sort()
    expect(got).toEqual([...SEED_ALLOW].sort())
    for (const never of [...SEED_NEVER, 'foo.sealed']) expect(existsSync(join(stg, never))).toBe(false)
  })
  test('I11 a database with an open WAL is copied consistently (VACUUM INTO), rows included', () => {
    const src = tmp(), stg = tmp()
    const db = new Database(join(src, 'journal.db'))
    db.run('pragma journal_mode=WAL'); db.run('create table t(a)'); for (let i = 0; i < 50; i++) db.run('insert into t values (?)', [i])
    expect(existsSync(join(src, 'journal.db-wal'))).toBe(true)
    buildSeed(src, stg)
    const copy = new Database(join(stg, 'journal.db'), { readonly: true })
    expect((copy.query('select count(*) c from t').get() as { c: number }).c).toBe(50)
    copy.close(); db.close()
  })
  test('I11 a symlink in the source refuses the whole seed and leaves nothing behind that matters', () => {
    const src = tmp(), stg = join(tmp(), 'out')
    mkdirSync(join(src, 'content'))
    writeFileSync(join(src, 'secret'), 'x')
    symlinkSync(join(src, 'secret'), join(src, 'content', 'link'))
    expect(() => buildSeed(src, stg)).toThrow(SeedRefusal)
    expect(existsSync(stg)).toBe(false)
  })
  test('applySeed refuses an entry that is not on the allow list', () => {
    const stg = tmp(), home = tmp()
    writeFileSync(join(stg, 'accounts.json'), '{}')
    expect(() => applySeed(stg, join(home, '.agentistics'))).toThrow(SeedRefusal)
    expect(existsSync(join(home, '.agentistics', 'accounts.json'))).toBe(false)
  })
})

describe('structured/ (I10)', () => {
  test('a planted structured/ is removed before the spawn and the assertion passes', () => {
    const d = tmp()
    mkdirSync(join(d, 'structured', 'relay'), { recursive: true })
    writeFileSync(join(d, 'structured', 'relay', 'live'), '1')
    ensureNoStructured(d)
    expect(existsSync(join(d, 'structured'))).toBe(false)
    ensureNoStructured(d) // idempotent
  })
})

describe('heavy lock fds (I16/I17 mechanism)', () => {
  test('finds a descriptor pointing at an agentistics-heavy lock, ignores other files', () => {
    const proc = tmp()
    mkdirSync(join(proc, '123', 'fd'), { recursive: true })
    symlinkSync('/tmp/agentistics-heavy.lock', join(proc, '123', 'fd', '9'))
    symlinkSync('/tmp/other.lock', join(proc, '123', 'fd', '10'))
    expect(heavyLockFds(123, proc)).toEqual([9])
    expect(heavyLockFds(999, proc)).toEqual([])
  })
})
