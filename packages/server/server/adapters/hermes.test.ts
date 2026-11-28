import { afterAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MODEL_PRICING, sessionCostUSD, sessionTokenTotal, unpricedTokens } from '@agentistics/core'
import { readHermesDb } from './hermes'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

type Row = Record<string, string | number | null>

/** A throwaway state.db with the columns the reader selects (hermes_state_common.py SCHEMA_SQL v31). */
function store(sessions: Row[], messages: Row[], version = 31, drop?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-adapter-'))
  dirs.push(dir)
  const path = join(dir, 'state.db')
  const db = new Database(path)
  db.run('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  db.run('INSERT INTO schema_version VALUES (?)', [version])
  db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, parent_session_id TEXT, model_config TEXT, cwd TEXT, title TEXT,
    started_at REAL, ended_at REAL, last_activity_at REAL, api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT,
    billing_provider TEXT, billing_base_url TEXT)`)
  db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,
    tool_calls TEXT, tool_name TEXT, timestamp REAL, message_uid TEXT, _compressed_summary INTEGER DEFAULT 0)`)
  for (const [table, rows] of [['sessions', sessions], ['messages', messages]] as const) {
    for (const r of rows) {
      const keys = Object.keys(r)
      db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => r[k]!))
    }
  }
  if (drop) db.run(`ALTER TABLE sessions DROP COLUMN ${drop}`)
  db.close()
  return path
}

const session = (id: string, extra: Row = {}): Row => ({
  id, source: 'acp', model: 'anthropic:claude-sonnet-4-5', cwd: '/work', started_at: 1000, ended_at: 1120, api_call_count: 2,
  input_tokens: 1000, output_tokens: 50, cache_read_tokens: 200, cache_write_tokens: 30, ...extra,
})
const msg = (session_id: string, role: string, timestamp: number, extra: Row = {}): Row => ({ session_id, role, timestamp, content: role === 'user' ? 'do it' : null, ...extra })
const one = (path: string, id: string) => readHermesDb(path, existsSync).sessions.find(s => s.session_id === id)!

describe('hermes adapter', () => {
  it('reads the session row counters, the model and a table price when Hermes states none', () => {
    const s = one(store([session('a', { cost_status: 'unknown', estimated_cost_usd: 0 })], [msg('a', 'user', 1001), msg('a', 'assistant', 1002)]), 'a')
    expect(s.harness).toBe('hermes')
    expect(s.model).toBe('claude-sonnet-4-5')
    expect(sessionTokenTotal(s)).toBe(1280)
    expect(s.model_usage).toBeUndefined()
    expect(sessionCostUSD(s)).toBeGreaterThan(0)
    expect([s.user_message_count, s.assistant_message_count, s.first_prompt]).toEqual([1, 1, 'do it'])
    expect(s.duration_minutes).toBe(2)
  })

  it('a stated cost wins over the table: actual first, then estimated, marked as the harness\'s own', () => {
    const path = store([
      session('actual', { cost_status: 'actual', estimated_cost_usd: 0.4, actual_cost_usd: 0.5 }),
      session('estimated', { cost_status: 'estimated', estimated_cost_usd: 0.0123 }),
      session('included', { cost_status: 'included', estimated_cost_usd: 0 }),
    ], [])
    expect(sessionCostUSD(one(path, 'actual'))).toBe(0.5)
    expect(sessionCostUSD(one(path, 'estimated'))).toBe(0.0123)
    expect(sessionCostUSD(one(path, 'included'))).toBe(0)
    expect(Object.values(one(path, 'actual').model_usage!).map(u => u.costSource)).toEqual(['harness'])
  })

  it('an unknown model with no stated cost has NO cost, never 0', () => {
    const s = one(store([session('u', { model: 'nous:hermes-4-405b', cost_status: 'unknown', estimated_cost_usd: 0 })], []), 'u')
    expect(sessionCostUSD(s)).toBeNull()
    expect(unpricedTokens(s)).toBe(1280)
  })

  it('does not count a branch\'s copied history again', () => {
    const copied = (id: string) => [msg(id, 'user', 1001), msg(id, 'assistant', 1002, { tool_calls: '[{"id":"t1"}]' })]
    const path = store(
      [session('parent'), session('child', { parent_session_id: 'parent', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, api_call_count: 1 })],
      [...copied('parent'), ...copied('child'), msg('child', 'user', 1500)],
    )
    expect([one(path, 'parent').user_message_count, one(path, 'parent').assistant_message_count]).toEqual([1, 1])
    expect([one(path, 'child').user_message_count, one(path, 'child').assistant_message_count]).toEqual([1, 0])
  })

  it('a delegated subagent keeps its spend but states no person message', () => {
    const s = one(store([session('d', { model_config: '{"_delegate_from":"p"}' })], [msg('d', 'user', 1001), msg('d', 'assistant', 1002)]), 'd')
    expect([s.user_message_count, s.first_prompt]).toEqual([0, ''])
    expect(sessionTokenTotal(s)).toBe(1280)
  })

  it('counts each tool call once and claims no tool error', () => {
    const calls = JSON.stringify([
      { id: 't1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'git commit -m x && git push' }) } },
      { id: 't2', function: { name: 'write_file', arguments: JSON.stringify({ path: '/work/a.ts', content: 'x' }) } },
    ])
    const s = one(store([session('t')], [
      msg('t', 'user', 1000),
      msg('t', 'assistant', 1010, { tool_calls: calls }),
      msg('t', 'tool', 1011, { tool_call_id: 't1', tool_name: 'terminal' }),
      msg('t', 'assistant', 1012, { tool_calls: calls }),
      msg('t', 'tool', 1013, { tool_call_id: 'orphan', tool_name: 'delegate_task' }),
    ]), 't')
    expect(s.tool_counts).toEqual({ Bash: 1, Write: 1, Task: 1 })
    expect([s.git_commits, s.git_pushes, s.files_modified, s.tool_errors, s.uses_task_agent]).toEqual([1, 1, 1, 0, true])
    expect([s.lines_added, s.lines_removed]).toEqual([0, 0])
  })

  it('active time runs from a prompt to the last row of its turn; the idle gap does not count', () => {
    const rows = [msg('a', 'user', 1000), msg('a', 'assistant', 1120), msg('a', 'user', 1500), msg('a', 'assistant', 1560)]
    const s = one(store([session('a')], rows), 'a')
    expect(s.active_minutes).toBe(3)
    expect(s.user_response_times).toEqual([380])
  })

  it('an automation run bounds active time but states no person message', () => {
    for (const source of ['cron', 'kanban', 'tool', 'a2a', 'subagent']) {
      const s = one(store([session('c', { source })], [msg('c', 'user', 1000), msg('c', 'assistant', 1060)]), 'c')
      expect([source, s.user_message_count, s.active_minutes, s.user_response_times]).toEqual([source, 0, 1, []])
    }
  })

  it('a session with no usage says unavailable, and one that never did anything is dropped', () => {
    const none = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, api_call_count: 0 }
    const path = store([session('asked', none), session('empty', none)], [msg('asked', 'user', 1001)])
    expect(one(path, 'asked').tokens_unavailable).toBe(true)
    expect(readHermesDb(path, existsSync).sessions.map(s => s.session_id)).toEqual(['asked'])
  })

  it('refuses a newer schema and a missing column in words', () => {
    expect(readHermesDb(store([session('a')], [], 32), existsSync)).toEqual({ sessions: [], error: expect.stringContaining('schema 32') })
    expect(readHermesDb(store([session('a')], [], 31, 'cost_status'), existsSync)).toEqual({ sessions: [], error: expect.stringContaining('sessions.cost_status') })
  })

  it('a schema older than 22 is refused', () => {
    expect(readHermesDb(store([session('a')], [], 21), existsSync)).toEqual({ sessions: [], error: expect.stringContaining('schema 21') })
    expect(readHermesDb(store([session('a')], [], 22), existsSync).error).toBeUndefined()
  })

  // Hermes writes the model without its provider, so only the billing columns say whether a tag was free.
  const billed: [string | null, string | null, string, number | null][] = [
    ['custom', 'http://localhost:11434/v1', 'unpriced/llama3:8b', null],
    ['lmstudio', 'http://127.0.0.1:1234/v1', 'lmstudio/llama3:8b', 0],
    ['local', null, 'local/llama3:8b', 0],
    ['ollama', null, 'ollama/llama3:8b', 0],
    ['ollama-cloud', 'https://ollama.com/v1', 'ollama-cloud/llama3:8b', null],
    ['custom', 'https://gpu.example.com/v1', 'unpriced/llama3:8b', null],
    ['custom', null, 'unpriced/llama3:8b', null],
    ['somebody', 'http://localhost:11434/v1', 'unpriced/llama3:8b', null],
    ['', null, 'unpriced/llama3:8b', null],
    [null, null, 'unpriced/llama3:8b', null],
  ]
  const priced = (fn: () => void) => {
    MODEL_PRICING['llama3-8b-instruct'] = { input: 0.2, output: 0.2, cacheRead: 0.2, cacheWrite: 0.2, cacheWrite1h: 0.2 }
    try { fn() } finally { delete MODEL_PRICING['llama3-8b-instruct'] }
  }
  const unstated = { model: 'llama3:8b', cost_status: 'unknown', estimated_cost_usd: 0 }

  it('only a local billing provider makes a tag free; any other is unpriced, never 0 nor the community price', () => priced(() => {
    const path = store(billed.map(([billing_provider, billing_base_url], i) => session(`l${i}`, { ...unstated, billing_provider, billing_base_url })), [])
    const got = new Map(readHermesDb(path, existsSync).sessions.map(s => [s.session_id, s]))
    billed.forEach(([provider, url, model, cost], i) => {
      const s = got.get(`l${i}`)!
      expect([provider, url, s.model, sessionCostUSD(s)]).toEqual([provider, url, model, cost])
      expect(unpricedTokens(s)).toBe(cost === null ? 1280 : 0)
    })
  }))

  it('a paid model behind a custom proxy on localhost is unpriced, not free', () => {
    const path = store([session('p', { model: 'claude-sonnet-4-5', cost_status: 'unknown', estimated_cost_usd: 0, billing_provider: 'custom', billing_base_url: 'http://localhost:4000' })], [])
    const s = one(path, 'p')
    expect([s.model, sessionCostUSD(s), unpricedTokens(s)]).toEqual(['unpriced/claude-sonnet-4-5', null, 1280])
  })

  it('a file with no billing columns is read, and its tag is unpriced', () => priced(() => {
    const s = one(store([session('n', unstated)], [], 31, 'billing_provider'), 'n')
    expect([s.model, sessionCostUSD(s)]).toEqual(['unpriced/llama3:8b', null])
  }))

  it('a system row is neither active time nor an hour of activity', () => {
    const rows = [msg('a', 'user', 1000), msg('a', 'assistant', 1060), msg('a', 'system', 1600)]
    const s = one(store([session('a', { ended_at: null })], rows), 'a')
    expect([s.active_minutes, s.message_hours.length, s.end_time]).toEqual([1, 2, new Date(1_060_000).toISOString()])
  })

  it('a row copied with the same message_uid is not counted, whatever its timestamp', () => {
    const path = store(
      [session('parent'), session('child', { parent_session_id: 'parent' })],
      [msg('parent', 'user', 1001, { message_uid: 'u1' }), msg('child', 'user', 1200, { message_uid: 'u1' }), msg('child', 'user', 1500, { message_uid: 'u2' })],
    )
    expect(one(path, 'child').user_message_count).toBe(1)
  })

  it('a compression summary is nobody\'s message', () => {
    const s = one(store([session('a')], [msg('a', 'user', 1001, { _compressed_summary: 1, content: 'summary' }), msg('a', 'user', 1002)]), 'a')
    expect([s.user_message_count, s.first_prompt]).toEqual([1, 'do it'])
  })

  it('a reply an hour or more after the assistant is not a response time', () => {
    const rows = [msg('a', 'assistant', 1000), msg('a', 'user', 1000 + 3599), msg('a', 'assistant', 5000), msg('a', 'user', 5000 + 3600)]
    expect(one(store([session('a')], rows), 'a').user_response_times).toEqual([3599])
  })

  it('a session that billed nothing states no cost, whatever Hermes wrote', () => {
    const none = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, api_call_count: 0 }
    const s = one(store([session('a', { ...none, cost_status: 'actual', actual_cost_usd: 0.5 })], [msg('a', 'user', 1001)]), 'a')
    expect(s.model_usage).toBeUndefined()
  })

  it('patch is an Edit', () => {
    const calls = JSON.stringify([{ id: 'p1', function: { name: 'patch', arguments: '{"path":"/work/a.ts"}' } }])
    const s = one(store([session('a')], [msg('a', 'assistant', 1001, { tool_calls: calls })]), 'a')
    expect([s.tool_counts, s.files_modified]).toEqual([{ Edit: 1 }, 1])
  })

  it('creates no -wal/-shm beside a WAL store that has none', () => {
    const path = store([session('a')], [])
    const db = new Database(path)
    db.run('PRAGMA journal_mode = WAL')
    db.close()
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
    expect(readHermesDb(path, existsSync).sessions).toHaveLength(1)
    expect([existsSync(`${path}-wal`), existsSync(`${path}-shm`)]).toEqual([false, false])
  })

  it('reads a pending WAL without writing the store: the file stays and the WAL is not checkpointed away', () => {
    const live = store([session('a')], [])
    const writer = new Database(live)
    writer.run('PRAGMA journal_mode = WAL')
    writer.run("UPDATE sessions SET title = 'only in the wal'")
    const copy = join(mkdtempSync(join(tmpdir(), 'hermes-wal-')), 'state.db')
    dirs.push(dirname(copy))
    copyFileSync(live, copy)
    copyFileSync(`${live}-wal`, `${copy}-wal`)
    writer.close()
    const before = readFileSync(copy)
    expect(readHermesDb(copy, existsSync).sessions.map(s => s.title)).toEqual(['only in the wal'])
    expect(readFileSync(copy).equals(before)).toBe(true)
    expect(existsSync(`${copy}-wal`)).toBe(true)
  })

  it('a missing store is simply empty', () => {
    expect(readHermesDb('/nonexistent/state.db', existsSync)).toEqual({ sessions: [] })
  })
})
