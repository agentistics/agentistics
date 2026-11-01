import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { opencodeActivityOf, opencodeSessionExists, opencodeTranscriptRef, readOpencodeTurns, searchOpencodeDb, splitOpencodeRef } from './opencode-store'
import { runTranscriptSearch } from './transcript-run'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const at = Date.parse('2026-10-30T12:00:00Z')

/** Real opencode column names (session / message / part), WAL like the real store. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-store-')); dirs.push(dir)
  const path = join(dir, 'opencode.db'), db = new Database(path)
  db.run('PRAGMA journal_mode=WAL')
  db.run('CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)')
  db.run('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
  db.run('CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
  const s = (id: string) => db.query('INSERT INTO session VALUES (?,?,?,?,?)').run(id, '/w/app', id, at, at)
  const m = (id: string, sid: string, role: string, off: number) => db.query('INSERT INTO message VALUES (?,?,?,?,?)').run(id, sid, at + off, at + off, JSON.stringify({ role }))
  const p = (id: string, mid: string, sid: string, off: number, d: object | string) =>
    db.query('INSERT INTO part VALUES (?,?,?,?,?,?)').run(id, mid, sid, at + off, at + off, typeof d === 'string' ? d : JSON.stringify(d))
  s('ses_a'); s('ses_b')
  m('m1', 'ses_a', 'user', 0); m('m2', 'ses_a', 'assistant', 10); m('m3', 'ses_b', 'user', 20)
  p('p1', 'm1', 'ses_a', 0, { type: 'text', text: 'Deploy the Docker image' })
  p('p2', 'm2', 'ses_a', 1, { type: 'reasoning', text: 'thinking about it' })
  p('p3', 'm2', 'ses_a', 2, { type: 'tool', tool: 'edit', state: { status: 'error', input: { filePath: '/w/app/a.ts' } } })
  p('p4', 'm2', 'ses_a', 3, { type: 'text', text: 'Done: 100% of it_s fine' })
  p('p5', 'm2', 'ses_a', 4, { type: 'text', text: 'secret docker plumbing', synthetic: true })
  p('p6', 'm3', 'ses_b', 5, { type: 'text', text: 'unrelated words' })
  p('p7', 'm3', 'ses_b', 6, '{broken json')
  p('p8', 'm3', 'ses_b', 7, { type: 'tool', tool: 'bash', state: { output: 'docker ps output' } })
  return { path, db }
}

test('search finds text and reasoning, case-insensitively, never plumbing/tool output/broken rows', () => {
  const { path, db } = fixture()
  expect(searchOpencodeDb(path, 'DOCKER')).toEqual(['ses_a'])
  expect(searchOpencodeDb(path, 'thinking')).toEqual(['ses_a'])
  expect(searchOpencodeDb(path, 'plumbing')).toEqual([])
  expect(searchOpencodeDb(path, 'unrelated')).toEqual(['ses_b'])
  db.close()
})

test('the query is data: % and _ are literal, empty query finds nothing, missing db is empty', () => {
  const { path, db } = fixture()
  expect(searchOpencodeDb(path, '100%')).toEqual(['ses_a'])
  expect(searchOpencodeDb(path, 'it_s')).toEqual(['ses_a'])
  expect(searchOpencodeDb(path, '%')).toEqual(['ses_a'])
  expect(searchOpencodeDb(path, 'x_x')).toEqual([])
  expect(searchOpencodeDb(path, '  ')).toEqual([])
  expect(searchOpencodeDb(join(tmpdir(), 'nope-opencode.db'), 'docker')).toEqual([])
  db.close()
})

test('reads are WAL-safe while the writer is open and leave no file behind', () => {
  const { path, db } = fixture()
  db.query('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p9', 'm3', 'ses_b', at + 9, at + 9, JSON.stringify({ type: 'text', text: 'late committed word' }))
  expect(searchOpencodeDb(path, 'late committed')).toEqual(['ses_b'])
  expect(readOpencodeTurns(path, 'ses_b').length).toBeGreaterThan(0)
  db.close()
  expect(existsSync(`${path}-journal`)).toBe(false)
})

test('turns: user text, assistant reasoning + failed write tool + text; plumbing dropped', () => {
  const { path, db } = fixture()
  const turns = readOpencodeTurns(path, 'ses_a')
  expect(turns.map(t => t.role)).toEqual(['user', 'assistant'])
  expect(turns[0]!.text).toBe('Deploy the Docker image')
  expect(turns[1]!.text).toBe('Done: 100% of it_s fine')
  expect(turns[1]!.thinking).toBe('thinking about it')
  expect(turns[1]!.tools).toEqual([{ name: 'edit', canonical: 'Edit', failed: true, detail: '/w/app/a.ts', writes: ['/w/app/a.ts'], ref: 'p3' }])
  expect(readOpencodeTurns(path, 'ses_missing')).toEqual([])
  db.close()
})

test('the store resolves only a session it holds and round-trips its ref', async () => {
  const { path, db } = fixture()
  expect(splitOpencodeRef(opencodeTranscriptRef(path, 'ses_a'))).toEqual({ dbPath: path, sessionId: 'ses_a' })
  expect(splitOpencodeRef('nohash')).toBeNull()
  expect(opencodeSessionExists(path, 'ses_a')).toBe(true)
  expect(opencodeSessionExists(path, 'ses_zzz')).toBe(false)
  expect(readOpencodeTurns(path, 'ses_a').length).toBe(2)
  db.close()
})

test('runTranscriptSearch covers opencode through SQL even without grep, and reports a failure', async () => {
  const base = { hasGrep: async () => false, dirExists: async () => false, grep: async () => '' }
  const ok = await runTranscriptSearch('docker', { ...base, opencode: { exists: async () => true, search: async () => ['ses_a'] } })
  expect([...ok.ids]).toEqual(['ses_a']); expect(ok.covered).toEqual(['opencode']); expect(ok.unavailable).toBeUndefined()
  const bad = await runTranscriptSearch('docker', { ...base, opencode: { exists: async () => true, search: async () => { throw new Error('x') } } })
  expect(bad.failed).toEqual(['opencode']); expect(bad.unavailable).toBe('no-grep')
  const none = await runTranscriptSearch('docker', { ...base, opencode: { exists: async () => false, search: async () => ['no'] } })
  expect(none.unavailable).toBe('no-grep'); expect(none.ids.size).toBe(0)
})

test('OPENCODE.RESTO: the newest message says what an opencode session is doing', () => {
  const m = (d: object) => ({ data: JSON.stringify(d) })
  expect(opencodeActivityOf(m({ role: 'user' }))).toBe('working')
  expect(opencodeActivityOf(m({ role: 'assistant', time: { created: 1 } }))).toBe('working')
  expect(opencodeActivityOf(m({ role: 'assistant', time: { created: 1, completed: 2 } }))).toBe('waiting')
  expect(opencodeActivityOf(m({ role: 'assistant', time: { created: 1 }, error: { name: 'APIError' } }))).toBe('waiting')
  expect(opencodeActivityOf(null)).toBeNull()
  expect(opencodeActivityOf({ data: 'not json' })).toBeNull()
})
