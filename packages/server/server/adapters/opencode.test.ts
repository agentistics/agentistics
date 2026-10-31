import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_CAPABILITIES, sessionCostUSD, unpricedTokens } from '@agentistics/core'
import { loadOpencodeDb } from './opencode'
import { parseOpencodeSession, opencodeModel } from './opencode-parse'
import { toConversation } from '../sessions/conversations'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const at = Date.parse('2026-10-30T12:00:00Z')
const session = { id: 'ses_fixture', directory: '/workspace/app', title: 'Synthetic metrics', time_created: at, time_updated: at + 60000 }
const message = (id: string, data: object, offset = 1000) => ({ id, session_id: session.id, time_created: at + offset, time_updated: at + offset + 100, data: JSON.stringify(data) })
const user = message('msg_user', { role: 'user' }, 0)
const response = (id = 'msg_a', extra: object = {}, offset = 1000) => message(id, {
  role: 'assistant', finish: 'stop', modelID: 'claude-sonnet-4-6', providerID: 'anthropic',
  tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 30 } }, ...extra,
}, offset)

/** Minimal real columns from the read-only OpenCode 1.17.9 schema dump. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-metrics-')); dirs.push(dir)
  const path = join(dir, 'opencode.db'), db = new Database(path)
  db.run('PRAGMA journal_mode=WAL')
  db.run('CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, cost real DEFAULT 0 NOT NULL)')
  db.run('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
  db.run('CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
  db.query('INSERT INTO session (id,directory,title,time_created,time_updated,tokens_input,cost) VALUES (?,?,?,?,?,999999,999)').run(session.id, session.directory, session.title, at, at + 60000)
  const add = (m: ReturnType<typeof message>) => db.query('INSERT INTO message VALUES (?,?,?,?,?)').run(m.id, m.session_id, m.time_created, m.time_updated, m.data)
  add(user); add(response())
  db.query('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_usage', 'msg_a', session.id, at, at, JSON.stringify({ type: 'step-finish', tokens: { input: 999999 } }))
  db.query('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_bad', 'msg_user', session.id, at, at, '{')
  db.query('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_text', 'msg_user', session.id, at, at, JSON.stringify({ type: 'text', text: 'Synthetic prompt' }))
  return { path, db, add }
}

test('WAL snapshot counts message usage once, never session totals or step-finish parts; feeds fleet/footer', () => {
  const { path, db, add } = fixture()
  try {
    const models = { anthropic: { models: { 'claude-sonnet-4-6': { limit: { context: 200000 } } } } }
    const before = readFileSync(path)
    const [s] = loadOpencodeDb(path, models)
    expect(readFileSync(path)).toEqual(before)
    expect(s!.input_tokens).toBe(100); expect(s!.output_tokens).toBe(15)
    expect(s!.cache_read_input_tokens).toBe(200); expect(s!.cache_creation_input_tokens).toBe(30)
    expect(s!.first_prompt).toBe('Synthetic prompt'); expect(s!.project_path).toBe('/workspace/app')
    expect(s!.context_tokens).toBe(330); expect(s!.context_window).toBe(200000)
    expect(toConversation(s!).tokens).toBe(345)
    expect(toConversation(s!).contextTokens).toBe(330)
    expect(toConversation(s!).costUSD).toBeGreaterThan(0)
    add(response('msg_b', { tokens: { input: 10, output: 2 } }, 2000))
    const next = loadOpencodeDb(path, models)[0]!
    expect(next.input_tokens).toBe(110); expect(next.context_tokens).toBe(10)
    expect(next.session_id).toBe('ses_fixture')
  } finally { db.close() }
})

test('mixed models keep their own price; OpenCode free and local models cost zero, unknown routes have no price', () => {
  const free = response('msg_free', { providerID: 'opencode', modelID: 'minimax-m2.5-free' })
  const s = parseOpencodeSession(session, [user, free])!
  expect(sessionCostUSD(s)).toBe(0)
  expect(sessionCostUSD(parseOpencodeSession(session, [user, response('pickle', { providerID: 'opencode', modelID: 'big-pickle' })])!)).toBe(0)
  expect(sessionCostUSD(parseOpencodeSession(session, [user, response('missing-provider', { providerID: undefined })])!)).toBeNull()
  expect(toConversation(s).costUSD).toBe(0)
  const unknown = parseOpencodeSession(session, [user, response('msg_x', { providerID: 'custom-vendor' })])!
  expect(sessionCostUSD(unknown)).toBeNull(); expect(unpricedTokens(unknown)).toBe(345)
  expect(toConversation(unknown).costUSD).toBeUndefined()
  const local = parseOpencodeSession(session, [user, response('msg_l', { providerID: 'ollama' })])!
  expect(sessionCostUSD(local)).toBe(0)
  const mixed = parseOpencodeSession(session, [user, response(), free])!
  expect(Object.keys(mixed.model_usage!)).toHaveLength(2)
  expect(sessionCostUSD(mixed)).toBe(sessionCostUSD(parseOpencodeSession(session, [user, response()])!))
  expect(opencodeModel('claude-sonnet-4-6', 'custom-vendor')).toBe('custom-vendor/claude-sonnet-4-6')
})

test('latest settled response by time supplies context; pending rows and malformed JSON cannot erase it', () => {
  const pending = message('msg_pending', { role: 'assistant', tokens: { input: 0 } }, 3000)
  const s = parseOpencodeSession(session, [pending, response('new', { tokens: { input: 12 } }, 2000), user, response()])!
  expect(s.context_tokens).toBe(12); expect(s.context_window).toBeUndefined()
  expect(parseOpencodeSession(session, [user, pending])!.tokens_unavailable).toBe(true)
  expect(parseOpencodeSession(session, [{ ...user, data: '{' }])).toBeNull()
  expect(parseOpencodeSession({ ...session, time_created: NaN }, [user])).toBeNull()
  expect(HARNESS_CAPABILITIES.opencode.tokens).toBe(true)
  expect(HARNESS_CAPABILITIES.opencode.contextWindow).toBe(true)
})

test('missing and incompatible stores fail closed without creating a database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-missing-')); dirs.push(dir)
  const path = join(dir, 'absent.db')
  expect(loadOpencodeDb(path)).toEqual([]); expect(existsSync(path)).toBe(false)
  const db = new Database(path); db.close()
  expect(loadOpencodeDb(path)).toEqual([])
})

test('live OpenCode refresh uses the exact SQLite session ID and bypasses the transcript resolver', async () => {
  const { refreshConversationContexts } = await import('../sessions/conversation-context')
  const meta = parseOpencodeSession(session, [user, response()])!
  let loads = 0
  const rows = [{ harness: 'opencode' as const, cwd: session.directory, conversationId: session.id }]
  const refreshed = await refreshConversationContexts([], [...rows, ...rows], () => { throw new Error('SQLite has no transcript') }, async () => { loads++; return [meta] })
  expect(loads).toBe(1); expect(refreshed).toHaveLength(1)
  expect(refreshed[0]!.sessionId).toBe('ses_fixture')
  expect(refreshed[0]!.tokens).toBe(345)
  expect(refreshed[0]!.contextTokens).toBe(330)
  expect(refreshed[0]!.costUSD).toBeGreaterThan(0)
  const unknownWindow = parseOpencodeSession(session, [user, response('msg_unknown', { providerID: 'custom' })])!
  const next = await refreshConversationContexts(refreshed, rows, () => null, async () => [unknownWindow])
  expect(next[0]!.contextWindow).toBeUndefined()
  expect(next[0]!.costUSD).toBeUndefined()
})
