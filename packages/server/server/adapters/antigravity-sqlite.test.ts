// Regression test for D2: reading agy's conversation DBs must not WRITE anything into the user's
// ~/.gemini directory. agy keeps them in WAL mode, and a plain `new Database(file, { readonly:
// true })` still makes SQLite create the `-shm` shared-memory index (plus an empty `-wal`) next to
// the user's file. The adapter therefore opens `file:<path>?immutable=1` with SQLITE_OPEN_URI.
//
// The test proves BOTH halves: the naive open really does create sidecars (so the guarantee is not
// vacuous), and the adapter's read path creates none.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'agy-sqlite-'))
const conversationsDir = join(root, 'conversations')

const CONV = 'conv-1'
const dbFile = join(conversationsDir, `${CONV}.db`)

/** Build a WAL-mode conversations/<id>.db exactly like agy writes one. */
function makeWalDb(): void {
  const db = new Database(dbFile, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE gen_metadata (id INTEGER PRIMARY KEY, data BLOB)')
  db.exec("INSERT INTO gen_metadata (data) VALUES (x'0a00')")
  db.close()
}

/** Sidecars sitting next to the DB right now. */
function sidecars(): string[] {
  return readdirSync(conversationsDir).filter(f => f !== `${CONV}.db`).sort()
}

beforeAll(() => {
  mkdirSync(conversationsDir, { recursive: true })
  makeWalDb()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

test('the NAIVE readonly open DOES create -shm/-wal sidecars (the bug being prevented)', () => {
  for (const f of sidecars()) rmSync(join(conversationsDir, f))
  expect(sidecars()).toEqual([])

  const db = new Database(dbFile, { readonly: true })
  db.query('SELECT count(*) FROM gen_metadata').all()
  db.close()

  // At least the shared-memory index appears — this is exactly what must never happen in ~/.gemini.
  expect(sidecars().length).toBeGreaterThan(0)
})

test('the adapter read path creates NO sidecar and leaves the DB byte-identical', async () => {
  for (const f of sidecars()) rmSync(join(conversationsDir, f))
  expect(sidecars()).toEqual([])
  const before = readFileSync(dbFile)

  const { readAntigravityTokensFromFile } = await import('./antigravity')
  const tokens = await readAntigravityTokensFromFile(dbFile)

  // The row is there (it decodes to nothing, which is fine — this test is about the filesystem).
  expect(tokens).not.toBeNull()
  expect(sidecars()).toEqual([])
  expect(Buffer.compare(before, readFileSync(dbFile))).toBe(0)

})

test('toSqliteUriPath escapes what would otherwise be URI syntax', async () => {
  const { toSqliteUriPath } = await import('./antigravity')
  expect(toSqliteUriPath('/home/u/.gemini/a.db')).toBe('/home/u/.gemini/a.db')
  expect(toSqliteUriPath('C:\\Users\\u\\a.db')).toBe('/C:/Users/u/a.db')
  expect(toSqliteUriPath('/tmp/we?rd#name.db')).toBe('/tmp/we%3frd%23name.db')
})
