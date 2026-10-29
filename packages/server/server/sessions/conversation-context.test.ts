import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { __setAccountRootsForTest, newestTranscript } from './account-transcript-roots'
import { encodeProjectDir, forgetChatTailPaths } from './chat-tail'
import { refreshConversationContexts } from './conversation-context'
import { transcriptReaderFor } from './harness-transcript'
import { toControlSession } from './control-session'
import { cliStrings } from '../cli-i18n'
import { planHandoffHints } from './handoff-hint'

const id = '7d3f0a52-6b1e-4c8a-9f21-0a5b3c4d5e6f'
const cwd = '/workspace/context'
let root: string
const claudeFile = (r: string, conv = id) => join(r, 'projects', encodeProjectDir(cwd), `${conv}.jsonl`)
const claudeUsage = (tokens: number) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-25T12:00:00Z', message: {
  id: `m${tokens}`, model: 'claude-opus-4-7', content: [], usage: { input_tokens: tokens, output_tokens: 10 },
} }) + '\n'
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-account-'))
  __setAccountRootsForTest({ accounts: [{ id: 'acc', harness: 'claude', root }], bindings: {} })
})
afterEach(async () => {
  __setAccountRootsForTest(null)
  forgetChatTailPaths()
  await rm(root, { recursive: true, force: true })
})

test('a row without accountId gets the account transcript reading, composer ring and handoff input', async () => {
  await put(claudeFile(root), claudeUsage(900_000))
  const [conv] = await refreshConversationContexts([], [{ harness: 'claude', cwd, conversationId: id }])
  expect(conv?.contextTokens).toBe(900_000)
  expect(conv?.contextWindow).toBeGreaterThan(0)
  const view = { ...conv, id: 'leader', status: 'running', label: '[ LEADER ] - context' }
  expect(toControlSession(view as never, cliStrings('en')).context).toBeDefined()
  expect(planHandoffHints([{ id: 'leader', ...conv, title: '[ LEADER ] - context' }])).toHaveLength(1)
  await appendFile(claudeFile(root), claudeUsage(800_000))
  expect((await refreshConversationContexts([], [{ harness: 'claude', cwd, conversationId: id }]))[0]?.contextTokens).toBe(800_000)
})

test('the newest exact copy wins over stale history, whichever store has it; history is unchanged', async () => {
  const defaultFile = await put(claudeFile(join(root, 'default')), claudeUsage(100_000))
  const accountFile = await put(claudeFile(root), claudeUsage(900_000))
  await utimes(defaultFile, 100, 100)
  await utimes(accountFile, 200, 200)
  // Supply a temporary default store while retaining the production account-root resolver.
  const readerFor: typeof transcriptReaderFor = h => ({ ...transcriptReaderFor(h)!, resolve: async () =>
    newestTranscript('claude', defaultFile, async dir => dir === join(root, 'projects') ? accountFile : null) })
  const rows = [{ harness: 'claude' as const, cwd, conversationId: id }]
  const old = (await refreshConversationContexts([], rows, readerFor))[0]!
  expect(old.contextTokens).toBe(900_000)
  await utimes(defaultFile, 300, 300)
  const next = await refreshConversationContexts([old], rows, readerFor)
  expect(next[0]?.contextTokens).toBe(100_000)
  expect(old.contextTokens).toBe(900_000)
  __setAccountRootsForTest({ accounts: [], bindings: {} })
  expect((await refreshConversationContexts([], rows, readerFor))[0]?.contextTokens).toBe(100_000)
})

test('never borrows context from another conversation in the same directory', async () => {
  await put(claudeFile(root, '11111111-2222-4333-8444-555555555555'), claudeUsage(900_000))
  expect(await refreshConversationContexts([], [{ harness: 'claude', cwd, conversationId: id }])).toEqual([])
  expect(await refreshConversationContexts([], [{ harness: 'claude', cwd }])).toEqual([])
})

test('Codex, Gemini and Kimi context readers find their exact account-root files too', async () => {
  __setAccountRootsForTest({ accounts: ['codex', 'gemini', 'kimi'].map(harness => ({ id: harness, harness: harness as 'codex' | 'gemini' | 'kimi', root })), bindings: {} })
  await put(join(root, 'sessions', '2026', '10', '25', `rollout-2026-10-25T12-00-00-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-25T12:00:00Z' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 12345 }, model_context_window: 258400 } } },
  ].map(v => JSON.stringify(v)).join('\n') + '\n')
  await put(join(root, '.gemini', 'tmp', 'project', 'chats', `session-2026-10-25T12-00-${id.slice(0, 8)}.jsonl`), JSON.stringify({
    sessionId: id, startTime: '2026-10-25T12:00:00Z', messages: [{ type: 'gemini', model: 'gemini-3.8-flash', tokens: { input: 23456 } }],
  }))
  await put(join(root, 'sessions', 'workspace', `session_${id}`, 'agents', 'main', 'wire.jsonl'), JSON.stringify({
    type: 'usage.record', time: 1000, model: 'claude-opus-4-7', usage: { inputOther: 34567 },
  }) + '\n')
  for (const [harness, expected] of [['codex', 12345], ['gemini', 23456], ['kimi', 34567]] as const) {
    const [conv] = await refreshConversationContexts([], [{ harness, cwd, conversationId: id }])
    expect(conv?.contextTokens, harness).toBe(expected)
    expect(conv?.contextWindow, harness).toBeGreaterThan(0)
  }
})

test('a long Codex tool tail widens to the last measurement and ignores cumulative totals', async () => {
  __setAccountRootsForTest({ accounts: [{ id: 'acc', harness: 'codex', root }], bindings: {} })
  const path = join(root, 'sessions', '2026', '10', '25', `rollout-2026-10-25T12-00-00-${id}.jsonl`)
  const usage = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 999999 }, last_token_usage: { input_tokens: 45678 }, model_context_window: 258400,
  } } })
  const padding = (JSON.stringify({ type: 'tool', text: 'x'.repeat(1000) }) + '\n').repeat(300)
  await put(path, usage + '\n' + padding)
  const [conv] = await refreshConversationContexts([], [{ harness: 'codex', cwd, conversationId: id }])
  expect(conv?.contextTokens).toBe(45678)
  expect(conv?.contextWindow).toBe(258400)
})

test('ended rows and transcripts without a known window do not fabricate a live gauge', async () => {
  await put(claudeFile(root), claudeUsage(900_000))
  expect(await refreshConversationContexts([], [{ harness: 'claude', cwd, conversationId: id, endedAt: '2026-10-25T13:00:00Z' }])).toEqual([])
  await writeFile(claudeFile(root), claudeUsage(900_000).replace('claude-opus-4-7', 'claude-unverified-model'))
  expect(await refreshConversationContexts([], [{ harness: 'claude', cwd, conversationId: id }])).toEqual([])
})
