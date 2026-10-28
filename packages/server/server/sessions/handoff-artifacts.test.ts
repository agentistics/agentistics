import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { computeHandoffPanel } from './handoff-panel'
import { handoffSessionLimit, refreshArtifactReplies, windowQuotaRate } from './handoff-usage'
import { claudeBilledReplies, geminiBilledReplies } from './handoff-artifacts'
import type { HarnessId, PlanLimits } from '@agentistics/core'
import type { AccountsFile } from '../harness-accounts'
import type { ManagedSession } from './types'

const now = Date.now()
const meter = (harness: HarnessId, account: string): PlanLimits => ({ harness, account, updatedAt: now,
  windows: [{ kind: '5h', usedPct: 20, resetsAt: now + 3600_000 }, { kind: 'week', usedPct: 40, resetsAt: now + 3600_000 }],
} as PlanLimits)
const claude = (id: string, output = 100) => ({ type: 'assistant', timestamp: new Date(now - 1000).toISOString(),
  message: { id, model: 'claude-opus-5-5', content: [], usage: { input_tokens: 10000, output_tokens: output,
    cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } } } })
const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

describe('native handoff quota calibration', () => {
  it('fills every projection for second-account Claude and Codex with no engine or journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'handoff-quota-'))
    try {
      const first = join(root, 'claude-first'), second = join(root, 'claude-second'), codex = join(root, 'codex')
      const id = '00000000-0000-0000-0000-000000000001'
      await Promise.all([mkdir(join(first, 'projects', 'p'), { recursive: true }), mkdir(join(second, 'projects', 'p'), { recursive: true }),
        mkdir(join(codex, 'sessions', '2026'), { recursive: true })])
      await Promise.all([
        writeFile(join(first, 'projects', 'p', 'c1.jsonl'), jsonl([claude('m1', 100000)])),
        writeFile(join(second, 'projects', 'p', 'c2.jsonl'), jsonl([claude('m2'), claude('m2', 200)])),
        writeFile(join(codex, 'sessions', '2026', `rollout-${id}.jsonl`), jsonl([
          { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
          { type: 'event_msg', timestamp: new Date(now - 1000).toISOString(), payload: { type: 'token_count', info: {
            total_token_usage: { input_tokens: 10000, cached_input_tokens: 5000, output_tokens: 500 } } } },
        ])),
      ])
      const accounts: AccountsFile = { version: 2, accounts: [], segments: {}, aliases: { 'old-second': 'second' },
        bindings: { 'claude:': 'first', [`claude:${first}`]: 'first', [`claude:${second}`]: 'second', 'codex:': 'code' } }
      const limits = [meter('claude', 'first'), meter('claude', 'second'), meter('codex', 'code')]
      const managed = [{ id: 'second-session', harness: 'claude', conversationId: 'c2', accountId: 'old-second' },
        { id: 'code-session', harness: 'codex', conversationId: id, accountId: 'code' }] as ManagedSession[]
      const replies = await refreshArtifactReplies([], {}, accounts, managed, limits, now, { claude: first, codex })
      expect(replies.filter(r => r.account === 'second')).toHaveLength(1)
      expect(replies.filter(r => r.account === 'code')).toHaveLength(1)
      for (const session of managed) {
        const limit = handoffSessionLimit(session.harness, session, accounts, limits)!
        expect(limit.account).toBe(session.harness === 'claude' ? 'second' : 'code')
        const quota = windowQuotaRate(limit, replies, now)
        const panel = computeHandoffPanel({ id: session.id, title: 'Leader', model: session.harness === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
          contextTokens: 200000, contextWindow: 1000000 }, null, quota, now)
        for (const row of panel.projections) {
          expect(row.fiveHourPct).toBeGreaterThan(0)
          expect(row.weekPct).toBeGreaterThan(0)
          expect(row.fiveHourPct).toBeCloseTo(row.costUSD! * 20 / replies.find(r => r.account === limit.account)!.costUSD!)
        }
      }
      const overlay = await refreshArtifactReplies([{ ...replies.find(r => r.account === 'second')!, costUSD: 9999 }], {}, accounts, managed, limits, now, { claude: first, codex })
      expect(overlay.filter(r => r.account === 'second')).toEqual(replies.filter(r => r.account === 'second'))
      // A cached artifact is reattributed after bindings change; it cannot leak a prior login's rate.
      accounts.bindings[`claude:${second}`] = 'third'
      const rebound = await refreshArtifactReplies([], {}, accounts, managed, limits, now, { claude: first, codex })
      expect(rebound.filter(r => r.account === 'second')).toHaveLength(0)
      expect(rebound.filter(r => r.account === 'third')).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('replaces Gemini journal usage with a deduplicated reopened conversation family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'handoff-gemini-'))
    try {
      const chats = join(root, 'tmp', 'project', 'chats')
      await mkdir(chats, { recursive: true })
      const id = 'abcdef12-0000-0000-0000-000000000000'
      const msg = { id: 'm', type: 'gemini', timestamp: new Date(now - 1000).toISOString(), model: 'gemini-3.8-flash',
        content: 'reply', tokens: { input: 10000, cached: 5000, output: 100 } }
      await writeFile(join(chats, 'session-2026-10-24T10-00-abcdef12.jsonl'), jsonl([
        { sessionId: id, startTime: new Date(now - 10000).toISOString() }, { $set: { messages: [msg] } },
      ]))
      await writeFile(join(chats, 'session-2026-10-24T10-01-abcdef12.jsonl'), jsonl([
        { $set: { messages: [msg, { ...msg, id: 'm2' }] } },
      ]))
      const accounts: AccountsFile = { version: 2, accounts: [], segments: {}, bindings: { [`gemini:${root}`]: 'gem' } }
      const rows = await refreshArtifactReplies([{ harness: 'gemini', conversationId: id, account: 'gem', at: now - 1, costUSD: 999 }],
        {}, accounts, [], [meter('gemini', 'gem')], now, { gemini: root })
      expect(rows).toHaveLength(2)
      expect(rows.every(r => r.conversationId === id && r.account === 'gem')).toBe(true)
      expect(windowQuotaRate(meter('gemini', 'gem'), rows, now).weekPctPerUSD).toBeGreaterThan(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('never borrows another metered account when the bound one has no reading', () => {
    const accounts = { version: 2, accounts: [{ id: 'first', harness: 'claude' }, { id: 'second', harness: 'claude' }], segments: {}, bindings: { 'claude:': 'first' } } as unknown as AccountsFile
    expect(handoffSessionLimit('claude', { accountId: 'second' }, accounts, [meter('claude', 'first')])).toBeUndefined()
    expect(handoffSessionLimit('claude', {}, accounts, [meter('claude', 'first'), meter('claude', 'second')])).toBeUndefined()
    expect(handoffSessionLimit('claude', { id: 'home', conversationId: 'home' }, accounts,
      [meter('claude', 'first'), meter('claude', 'second')])?.account).toBe('first')
    expect(handoffSessionLimit('claude', {}, { ...accounts, bindings: {} }, [meter('claude', 'first'), meter('claude', 'second')])).toBeUndefined()
  })
  it('uses Claude final usage once, preserves its first timestamp and cache TTL pricing', () => {
    const first = claude('m', 1), final = { ...claude('m', 500), timestamp: new Date(now + 1000).toISOString() }
    const rows = claudeBilledReplies(jsonl([first, final, final, { ...claude('error'), isApiErrorMessage: true }]), 'c')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.at).toBe(Date.parse(first.timestamp))
    expect(rows[0]!.costUSD).toBe(claudeBilledReplies(jsonl([final]), 'c')[0]!.costUSD)
    expect(rows[0]!.costUSD).toBeGreaterThan(0)
  })
  it('calibrates Gemini from timestamped native usage and deduplicates JSONL snapshots', () => {
    const msg = { id: 'g1', type: 'gemini', timestamp: new Date(now - 1000).toISOString(), model: 'gemini-3.8-flash',
      content: 'reply', tokens: { input: 10000, cached: 5000, output: 100 } }
    const rich = geminiBilledReplies(JSON.stringify({ sessionId: 'native-g', messages: [msg] }), 'g')
    expect(geminiBilledReplies(jsonl([{ sessionId: 'native-g' }, { $set: { messages: [msg] } }, { $set: { messages: [msg] } }]), 'g')).toEqual(rich)
    expect(rich[0]!.conversationId).toBe('native-g')
    const quota = windowQuotaRate(meter('gemini', 'gem'), rich.map(r => ({ ...r, account: 'gem' })), now)
    expect(quota.fiveHourPctPerUSD).toBeGreaterThan(0)
    expect(quota.weekPctPerUSD).toBeGreaterThan(0)
  })
})
