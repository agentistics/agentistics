import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionCostUSD, unpricedTokens } from '@agentistics/core'
import { loadOpencodeAny } from './opencode'
import { getOpencodeReadIssue, setOpencodeReadIssue } from './opencode-status'
import { createOpencodeV2Client, generationOfTables, loadOpencodeV2, opencodeStateDirFor, parseServiceRecord, rowsOfV2Messages, type Fetch } from './opencode-v2'
import { clearAdapterMemos } from './file-memo'
import type { HealthIssue } from '@agentistics/core'
import { analyzeOpencodeStatus } from '../health'

const FX = join(import.meta.dir, 'fixtures', 'opencode-v2.2.5')
const read = (f: string) => JSON.parse(readFileSync(join(FX, f), 'utf8'))
const sessionsBody = read('sessions.json'), messagesBody = read('messages-ses_e53f48c24ffeMy9oUiacfDl4ld.json')
const service = { url: 'http://127.0.0.1:1', password: 'pw' }

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); clearAdapterMemos(); setOpencodeReadIssue(null) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'oc2-')); dirs.push(d); return d }

/** The recorded 2.2.5 service: sessions list, per-session messages (the recorded ones for every session). */
function fakeFetch(seen: string[] = []): Fetch {
  return async (url, init) => {
    seen.push(url)
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`)
    const path = url.replace(service.url, '')
    const body = path.startsWith('/api/info') ? read('info.json')
      : path.startsWith('/api/session?') ? sessionsBody
        : messagesBody
    return { status: 200, ok: true, json: async () => body }
  }
}

test('generation: session_v2 wins over frozen 1.x tables; 1.x; unknown', () => {
  expect(generationOfTables(new Set(['session', 'message', 'part', 'session_v2']))).toBe('v2')
  expect(generationOfTables(new Set(['session', 'message', 'part']))).toBe('v1')
  expect(generationOfTables(new Set(['project']))).toBe('unknown')
})

test('state dir follows the account store; service record parses', () => {
  expect(opencodeStateDirFor('/h/a/.local/share/opencode/opencode.db', {})).toBe('/h/a/.local/state/opencode')
  expect(opencodeStateDirFor('/x/opencode.db', { XDG_STATE_HOME: '/s' })).toBe('/s/opencode')
  expect(parseServiceRecord('{"url":"http://127.0.0.1:5/","password":"p","pid":3}')).toEqual({ url: 'http://127.0.0.1:5', password: 'p', pid: 3 })
  expect(parseServiceRecord('{"url":"x"}')).toBeNull()
})

test('2.x through the API: tokens counted, stub provider is unpriced, OpenCode cost never claims it free', async () => {
  const seen: string[] = []
  const list = await loadOpencodeV2(service, {}, '', createOpencodeV2Client(service, { fetch: fakeFetch(seen) }))
  expect(list.length).toBeGreaterThan(0)
  const s = list[0]!
  expect(s.harness).toBe('opencode')
  expect(s.input_tokens).toBeGreaterThan(0)
  expect(s.model_usage).toBeDefined()
  expect(Object.keys(s.model_usage!)).toEqual(['stub/m1'])
  // fixture messages carry cost: 0 — still unpriced, not R$0 priced
  expect(sessionCostUSD(s)).toBeNull()
  expect(unpricedTokens(s)).toBeGreaterThan(0)
  expect(seen.some(u => u.includes('/api/session?') && u.includes('limit=200') && u.includes('order=desc'))).toBe(true)
})

test('2.x context gauge: latest settled assistant input + cache read + write; window from models.dev when known', () => {
  const msgs = [
    { id: 'm1', type: 'user', time: { created: 1000 }, text: 'hi' },
    { id: 'm2', type: 'assistant', time: { created: 1100, completed: 1200 }, model: { id: 'claude-sonnet-4-6', providerID: 'anthropic' }, finish: 'stop', content: [], tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 30 } } },
    { id: 'm3', type: 'assistant', time: { created: 1300 }, model: { id: 'claude-sonnet-4-6', providerID: 'anthropic' }, content: [], tokens: { input: 9999 } }, // still running
    { id: 'm4', type: 'idle', time: { created: 1400 } },
  ] as never
  const { messages, parts } = rowsOfV2Messages('s', msgs)
  expect(messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
  expect(parts.map(p => p.id)).toEqual(['m1:0'])
})

test('2.x context numbers through the adapter path', async () => {
  const { parseOpencodeSession } = await import('./opencode-parse')
  const msgs = [
    { id: 'm1', type: 'user', time: { created: 1793887700000 }, text: 'hi' },
    { id: 'm2', type: 'assistant', time: { created: 1793887700100, completed: 1793887700200 }, model: { id: 'claude-sonnet-4-6', providerID: 'anthropic' }, finish: 'stop', content: [], tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 30 } } },
  ] as never
  const { messages, parts } = rowsOfV2Messages('s', msgs)
  const row = { id: 's', directory: '/w', title: 't', time_created: 1793887700000, time_updated: 1793887700300 }
  const s = parseOpencodeSession(row, messages, parts, { anthropic: { models: { 'claude-sonnet-4-6': { limit: { context: 200000 } } } } })!
  expect(s.context_tokens).toBe(330); expect(s.context_window).toBe(200000)
  expect(s.output_tokens).toBe(15)
  const unknown = parseOpencodeSession(row, messages, parts, {})!
  expect(unknown.context_window).toBeUndefined()
})

test('a db with session_v2 but no reachable service reports an issue, not a silent empty', async () => {
  const dir = tmp(), db = join(dir, 'opencode.db')
  const d = new Database(db); d.run('CREATE TABLE session_v2 (id text)'); d.run('CREATE TABLE session (id text)'); d.run('CREATE TABLE message (id text)'); d.run('CREATE TABLE part (id text)'); d.close()
  const out = await loadOpencodeAny(db, join(dir, 'state'))
  expect(out).toEqual([])
  expect(getOpencodeReadIssue()).toContain('OpenCode 2.x: background service not found or not answering')
  const state = join(dir, 'state'); mkdirSync(state)
  writeFileSync(join(state, 'service.json'), JSON.stringify({ url: 'http://127.0.0.1:1', password: 'x' })) // nothing listens on port 1
  await loadOpencodeAny(db, state)
  expect(getOpencodeReadIssue()).toContain('not answering')
})

test('renamed tables produce a health issue, not a silent empty result', async () => {
  const dir = tmp(), db = join(dir, 'opencode.db')
  const d = new Database(db); d.run('CREATE TABLE renamed_session (id text)'); d.close()
  expect(await loadOpencodeAny(db, join(dir, 'state'))).toEqual([])
  expect(getOpencodeReadIssue()).toContain('neither the 1.x nor the 2.x tables')
  // 1.x tables whose columns changed: the SQL error is the sentence
  const db1 = join(dir, 'v1.db'), e = new Database(db1)
  e.run('CREATE TABLE session (id text)'); e.run('CREATE TABLE message (id text)'); e.run('CREATE TABLE part (id text)'); e.close()
  expect(await loadOpencodeAny(db1, join(dir, 'state'))).toEqual([])
  expect(getOpencodeReadIssue()).toContain('no longer answers the 1.x queries')
  // a healthy empty-but-correct 1.x store clears it
  const db2 = join(dir, 'ok.db'), f = new Database(db2)
  f.run('CREATE TABLE session (id text, directory text, title text, time_created integer, time_updated integer)')
  f.run('CREATE TABLE message (id text, session_id text, time_created integer, time_updated integer, data text)')
  f.run('CREATE TABLE part (id text, message_id text, session_id text, time_created integer, data text)'); f.close()
  await loadOpencodeAny(db2, join(dir, 'state'))
  expect(getOpencodeReadIssue()).toBeNull()
})

test('health shows the OpenCode issue (and nothing when there is none)', () => {
  const issues: HealthIssue[] = []
  analyzeOpencodeStatus(null, issues)
  expect(issues).toEqual([])
  analyzeOpencodeStatus('opencode.db has neither the 1.x nor the 2.x tables — test', issues)
  expect(issues).toHaveLength(1)
  expect(issues[0]!.title).toBe('OpenCode sessions cannot be read')
  expect(issues[0]!.description).toContain('neither')
})
