import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarnessAccounts, __setHarnessAccountsForTest } from '../harness-accounts'
import { AGENTISTICS_DATA_DIR, DEFAULT_HARNESS_DIRS, harnessRoots, resetHarnessRootsMemo } from '../config'
import { HARNESS_ORDER } from '@agentistics/core'
import { NOOP_PARSE_CACHE, openParseCache, type ParseCache } from '../parse-cache'
import { loadCodexRoot } from './codex'
import { loadCopilotRoot } from './copilot'
import { geminiAdapter, loadGeminiRoot } from './gemini'
import { loadKimiRoot } from './kimi'
import { loadClaudeRoot } from './claude'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'acct-roots-')); resetHarnessRootsMemo() })
afterEach(async () => {
  // Put the module's own store back: a store left pointing at a deleted temp dir leaks into every
  // later test file in the same bun process.
  __setHarnessAccountsForTest(createHarnessAccounts({ file: join(AGENTISTICS_DATA_DIR, 'accounts.json') }))
  await rm(dir, { recursive: true, force: true }); resetHarnessRootsMemo()
})

const put = async (path: string, text: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text) }
const jl = (...lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n')

// --- one fixture per harness, written under an arbitrary root --------------------------------
const writeCodex = (root: string, id: string) => put(join(root, 'sessions/2026/05/25', `rollout-${id}.jsonl`), jl(
  { timestamp: '2026-05-25T18:25:51.037Z', type: 'session_meta', payload: { id, timestamp: '2026-05-25T18:25:50.087Z', cwd: '/p', model_provider: 'openai' } },
  { timestamp: '2026-05-25T18:25:53.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
  { timestamp: '2026-05-25T18:25:55.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'yo' } },
))
const writeCopilot = (root: string, id: string) => put(join(root, 'session-state', id, 'events.jsonl'), jl(
  { type: 'session.start', data: { sessionId: id, startTime: '2026-03-01T10:00:00.000Z', context: { cwd: '/p' } }, timestamp: '2026-03-01T10:00:00.000Z' },
  { type: 'user.message', data: { content: 'test' }, timestamp: '2026-03-01T10:01:00.000Z' },
))
const writeGemini = (root: string, name: string) => put(join(root, 'tmp', 'proj', 'chats', `session-2026-06-18T16-31-${name}.jsonl`), jl(
  { sessionId: name, projectHash: 'h', startTime: '2026-06-18T16:31:11.084Z', lastUpdated: '2026-06-18T16:32:00.000Z', kind: 'main' },
  { id: 'm1', timestamp: '2026-06-18T16:31:11.085Z', type: 'user', content: [{ text: 'hello' }] },
  { id: 'm2', timestamp: '2026-06-18T16:31:20.000Z', type: 'gemini', content: 'hi', model: 'gemini-3-pro' },
))
const writeKimi = async (root: string, id: string) => {
  const s = join(root, 'sessions', 'ws', `session_${id}`)
  await put(join(s, 'state.json'), JSON.stringify({ title: 't', workDir: '/p', createdAt: '2026-07-27T22:26:15.061Z', updatedAt: '2026-07-27T22:35:50.015Z', agents: { main: {} } }))
  await put(join(s, 'agents/main/wire.jsonl'), jl(
    { type: 'turn.prompt', input: [{ type: 'text', text: 'salve' }], origin: { kind: 'user' }, time: 1785191518480 },
    { type: 'usage.record', model: 'google/gemini-3.5-flash-lite', usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: 1785191519480 },
  ))
}
const writeClaude = (root: string, id: string) => put(join(root, 'usage-data/session-meta', `${id}.json`), JSON.stringify({
  session_id: id, project_path: '/p', start_time: '2026-05-01T10:00:00.000Z', first_prompt: 'x',
}))

const LOADERS: Array<[string, (root: string, id: string) => Promise<void>, (root: string, account?: string) => Promise<Array<{ session_id: string; account?: string }>>]> = [
  ['codex', writeCodex, loadCodexRoot],
  ['copilot', writeCopilot, loadCopilotRoot],
  ['gemini', writeGemini, loadGeminiRoot],
  ['kimi', writeKimi, loadKimiRoot],
  ['claude', writeClaude, (r, a) => loadClaudeRoot(r, a, false, NOOP_PARSE_CACHE)],
]

for (const [name, write, load] of LOADERS) {
  test(`${name}: a second root's session appears stamped with its account`, async () => {
    const def = join(dir, 'default'), second = join(dir, 'second')
    await write(def, 'default-1'); await write(second, 'second-1')
    const fromSecond = await load(second, 'acc_second')
    expect(fromSecond).toHaveLength(1)
    expect(fromSecond[0]!.account).toBe('acc_second')
    expect(fromSecond[0]!.session_id).toContain('second-1')
  })

  test(`${name}: the default root keeps its ids and gains no account without a binding`, async () => {
    const def = join(dir, 'default')
    await write(def, 'default-1')
    const out = await load(def)
    expect(out).toHaveLength(1)
    expect('account' in out[0]!).toBe(false)
    expect(out[0]!.session_id).toContain('default-1')
    // Same ids with or without the second root present on disk.
    await write(join(dir, 'second'), 'second-1')
    expect((await load(def)).map(s => s.session_id)).toEqual(out.map(s => s.session_id))
  })
}

test('harnessRoots: default + non-retired bound roots; retired and unbound are skipped; antigravity stays single', async () => {
  const file = join(dir, 'accounts.json')
  const store = createHarnessAccounts({ file, probe: async () => ({ key: 'k', label: 'k' }) })
  const a = join(dir, 'root-a'), b = join(dir, 'root-b')
  const first = await store.bind(a, { harness: 'codex', key: 'one', label: 'one' })
  await store.bind(b, { harness: 'codex', key: 'two', label: 'two' })
  await store.bind(join(dir, 'claude-root'), { harness: 'claude', key: 'c', label: 'c' })
  // An UNBOUND registry root: an account naming a root no binding points at.
  const raw = JSON.parse(await readFile(file, 'utf8'))
  raw.accounts.push({ ...raw.accounts.find((x: { id: string }) => x.id === first.account.id), id: 'acc_unbound', key: 'three', label: 'three', root: join(dir, 'root-c') })
  await writeFile(file, JSON.stringify(raw))
  __setHarnessAccountsForTest(store)
  const roots = await harnessRoots('codex', 1)
  expect(roots[0]!.isDefault).toBe(true)
  expect(roots.slice(1).map(r => r.root).sort()).toEqual([a, b].sort())
  expect(roots.slice(1).every(r => !!r.account)).toBe(true)
  expect((await harnessRoots('claude', 1)).filter(r => !r.isDefault)).toHaveLength(1)
  expect(await harnessRoots('antigravity', 1)).toEqual([])
  expect(await harnessRoots('opencode', 1)).toEqual([])
  // Retire one: after the 5 s memo it is gone.
  const data = JSON.parse(await readFile(file, 'utf8'))
  data.accounts.find((x: { id: string }) => x.id === first.account.id).retired = true
  await writeFile(file, JSON.stringify(data))
  expect((await harnessRoots('codex', 10_000)).filter(r => !r.isDefault)).toHaveLength(1)
})

test('claude: a second root is read without its stats-cache.json (default root only)', async () => {
  const second = join(dir, 'second')
  await writeClaude(second, 'sx')
  await put(join(second, 'stats-cache.json'), JSON.stringify({ totalSessions: 999999 }))
  const out = await loadClaudeRoot(second, 'acc', false)
  expect(out.map(s => s.session_id)).toEqual(['sx'])
  const src = await readFile(join(import.meta.dir, 'claude.ts'), 'utf8')
  expect(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')).not.toMatch(/stats-cache|STATS_CACHE/)
})

const writeClaudeTranscript = (root: string, id: string) => put(join(root, 'projects', '-p', `${id}.jsonl`), jl(
  { type: 'user', sessionId: id, uuid: 'u1', cwd: '/p', timestamp: '2026-05-01T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', sessionId: id, uuid: 'u2', cwd: '/p', timestamp: '2026-05-01T10:00:05.000Z', message: { id: 'msg1', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 4 } } },
))

test('claude: a second root\'s transcripts go through the parse cache (a rebuild does not re-parse them)', async () => {
  const second = join(dir, 'second')
  await writeClaudeTranscript(second, 'tx1')
  const real = await openParseCache(join(dir, 'cache.db'))
  let gets = 0, hits = 0
  const spy: ParseCache = { ...real, get: <T,>(kind: Parameters<ParseCache['get']>[0], stamp: Parameters<ParseCache['get']>[1], variant?: string) => { gets++; const v = real.get<T>(kind, stamp, variant); if (v !== null) hits++; return v } }
  const first = await loadClaudeRoot(second, 'acc', false, spy)
  expect(first.map(s => s.session_id)).toEqual(['tx1'])
  expect(gets).toBeGreaterThan(0)
  const again = await loadClaudeRoot(second, 'acc', false, spy)
  expect(hits).toBeGreaterThan(0)
  expect(again.map(s => [s.session_id, s.account])).toEqual([['tx1', 'acc']])
  real.close()
})

test('the default-root table names EVERY harness explicitly (antigravity and opencode as null)', () => {
  expect(Object.keys(DEFAULT_HARNESS_DIRS).sort()).toEqual([...HARNESS_ORDER].sort())
  expect(DEFAULT_HARNESS_DIRS.antigravity).toBeNull()
  expect(DEFAULT_HARNESS_DIRS.opencode).toBeNull()
})

test('gemini: an account root is a HOME, so the adapter reads <root>/.gemini (GEMINI_CLI_HOME)', async () => {
  const home = join(dir, 'gemini-home')
  await writeGemini(join(home, '.gemini'), 'acct-1')
  await writeGemini(home, 'wrong-1') // a <root>/tmp tree must NOT be what an account root reads
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'k', label: 'k' }) })
  const { account } = await store.bind(home, { harness: 'gemini', key: 'g', label: 'g' })
  __setHarnessAccountsForTest(store)
  const mine = (await geminiAdapter.loadSessions()).filter(s => s.account === account.id)
  expect(mine).toHaveLength(1)
  expect(mine[0]!.session_id).toContain('acct-1')
})
