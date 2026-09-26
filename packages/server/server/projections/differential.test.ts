/**
 * The parity differential's own rules: EQUAL, never close; an explanation applies only when the
 * session's own bytes prove it; a declared absence is reported as one and never as a bug. And the
 * row over A2.2's redacted fixtures, which must hold no unexplained difference.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AgentInvocation, SessionMeta } from '@agentistics/core'
import {
  EXPLANATIONS, compareSession, compareTokens, compareTime, compareTools, fileUsageById, globalDedupPerModel,
  metaChainMembers, pairInvocations, recountUsage, renderReport, runDifferential, summarize,
  type UsageEvidence,
} from './differential'
import { fallbackSubagentAgentId } from '../integrations/claude/replay-agents'
import { subagentIdOf } from '../integrations/claude/replay-core'
import type { ProjectedInvocation, SessionMetaProjection } from './session-meta'

const FIXTURES = join(import.meta.dir, '../../test/fixtures')

const legacy = (o: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 's', project_path: '/x', start_time: '', duration_minutes: 0,
  user_message_count: 0, assistant_message_count: 0, tool_counts: {}, languages: {},
  git_commits: 0, git_pushes: 0, input_tokens: 100, output_tokens: 50,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  first_prompt: '', user_interruptions: 0, user_response_times: [], tool_errors: 0,
  tool_error_categories: {}, uses_task_agent: false, uses_mcp: false, uses_web_search: false,
  uses_web_fetch: false, lines_added: 0, lines_removed: 0, files_modified: 0,
  message_hours: [], user_message_timestamps: [], model: 'claude-sonnet-4-6',
  ...o,
} as SessionMeta)

const projection = (m: Partial<SessionMetaProjection['meta']> = {}, costUSD: number | null = null): SessionMetaProjection => ({
  meta: {
    tool_counts: {}, tool_errors: 0, tool_error_categories: {},
    input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    uses_task_agent: false, uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
    lines_added: 0, lines_removed: 0, files_modified: 0, model: 'claude-sonnet-4-6', ...m,
  },
  costUSD, costSource: 'table', notProjectable: [], partialFields: [], caveats: [], eventsFolded: 0,
})

const evidence = (first: number, last: number): UsageEvidence => ({
  main: {
    firstWins: { input: 100, output: first, cacheRead: 0, cacheWrite: 0 },
    lastWins: { input: 100, output: last, cacheRead: 0, cacheWrite: 0 },
    usageLines: 2, apiErrorZeroTtlLines: 0,
  },
  mainBytes: 100,
  roots: {},
})

const assistant = (id: string | undefined, output: number) =>
  JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 10, output_tokens: output } } })

describe('recountUsage — the two counting rules over the same lines', () => {
  test('a streamed id: first-wins keeps the partial line, last-wins the final one', () => {
    const r = recountUsage([assistant('m1', 5), assistant('m1', 276), assistant('m2', 7)])
    expect(r.firstWins.output).toBe(12)
    expect(r.lastWins.output).toBe(283)
    expect(r.firstWins.input).toBe(20)
    expect(r.lastWins.input).toBe(20)
  })
  test('a line with no id is always counted, by both rules', () => {
    const r = recountUsage([assistant(undefined, 3), assistant(undefined, 3)])
    expect(r.firstWins.output).toBe(6)
    expect(r.lastWins.output).toBe(6)
  })
})

describe('verdicts — equal, never close', () => {
  test('equal counters are equal', () => {
    const rows = compareTokens(legacy(), projection({}, null))
    expect(rows.find(r => r.field === 'output_tokens')!.verdict).toBe('equal')
  })
  test('a difference of ONE token with no evidence is a bug', () => {
    const rows = compareTokens(legacy(), projection({ output_tokens: 51 }))
    expect(rows.find(r => r.field === 'output_tokens')!.verdict).toBe('bug')
  })
  test('a difference the recount reproduces on BOTH sides is explained, in one sentence', () => {
    const r = compareTokens(legacy({ output_tokens: 50 }), projection({ output_tokens: 70 }), evidence(50, 70))
      .find(x => x.field === 'output_tokens')!
    expect(r.verdict).toBe('explained')
    expect(r.reason).toBe(EXPLANATIONS.firstWins)
  })
  test('evidence that reproduces only ONE side explains nothing', () => {
    const r = compareTokens(legacy({ output_tokens: 50 }), projection({ output_tokens: 71 }), evidence(50, 70))
      .find(x => x.field === 'output_tokens')!
    expect(r.verdict).toBe('bug')
  })
  test('the cost of an explained token difference is explained only if re-pricing closes it exactly', () => {
    const l = legacy({ output_tokens: 50 })
    const proven = compareTokens(l, projection({ output_tokens: 70 }, null), evidence(50, 70))
    // legacy has a model and a price; the projection said null — re-pricing cannot close that
    expect(proven.find(x => x.field === 'costUSD')!.verdict).toBe('bug')
  })
})

describe('legacy defects, proven per session', () => {
  const apiError = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: {
    model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } } } })
  test('a transcript whose ONLY usage is a synthetic API error: legacy 0/0 TTL vs absent is explained', () => {
    const main = recountUsage([apiError])
    expect(main.apiErrorZeroTtlLines).toBe(1)
    const rows = compareTokens(
      legacy({ input_tokens: 0, output_tokens: 0, cache_creation_1h_input_tokens: 0, cache_creation_5m_input_tokens: 0 }),
      projection({ input_tokens: 0, output_tokens: 0 }),
      { main, mainBytes: 10, roots: {} })
    expect(rows.find(r => r.field === 'cache_creation_1h_input_tokens')!.reason).toBe(EXPLANATIONS.apiErrorOnly)
  })
  test('one real usage line beside the API error: the same difference is a bug', () => {
    const main = recountUsage([apiError, assistant('m1', 5)])
    const rows = compareTokens(
      legacy({ input_tokens: 10, output_tokens: 5, cache_creation_1h_input_tokens: 0, cache_creation_5m_input_tokens: 0 }),
      projection({ input_tokens: 10, output_tokens: 5 }),
      { main, mainBytes: 10, roots: {} })
    expect(rows.find(r => r.field === 'cache_creation_1h_input_tokens')!.verdict).toBe('bug')
  })
  test('an empty transcript: legacy measured-0 duration/compactions vs absent is explained; a non-empty one is not', () => {
    const l = legacy({ duration_minutes: 0, compact_count: 0, compact_ms: 0 } as Partial<SessionMeta>)
    const p = projection()
    const ev = (mainBytes: number): UsageEvidence => ({ ...evidence(50, 50), mainBytes })
    const empty = compareSession({ sessionId: 's', legacy: l, projection: p, evidence: ev(0) })
    expect(empty.rows.find(r => r.field === 'compact_count')!.reason).toBe(EXPLANATIONS.emptyTranscript)
    const full = compareSession({ sessionId: 's', legacy: l, projection: p, evidence: ev(10) })
    expect(full.rows.find(r => r.field === 'compact_count')!.verdict).toBe('bug')
  })
})

describe('declared absences', () => {
  test('the human-turn family is not-projectable, never a bug', () => {
    const rows = compareTime(legacy({ active_minutes: 12, rounds: 3 } as Partial<SessionMeta>), projection())
    for (const f of ['active_minutes', 'rounds', 'user_message_count', 'message_hours']) {
      expect(rows.find(r => r.field === f)!.verdict).toBe('not-projectable')
      expect(rows.find(r => r.field === f)!.reason).toBeTruthy()
    }
  })
})

describe('metaChainMembers — the harness\'s own parentAgentId chain, never a directory glob', () => {
  test('a direct nested child chains to its root', () => {
    const entries = [
      { agentId: 'root1', meta: null },
      { agentId: 'child1', meta: { parentAgentId: 'root1' } },
    ]
    expect(metaChainMembers('root1', entries)).toEqual(['root1', 'child1'])
  })
  test('a grandchild resolves through its parent to the same root', () => {
    const entries = [
      { agentId: 'root1', meta: null },
      { agentId: 'child1', meta: { parentAgentId: 'root1' } },
      { agentId: 'grandchild1', meta: { parentAgentId: 'child1' } },
    ]
    expect(metaChainMembers('root1', entries)).toEqual(['root1', 'child1', 'grandchild1'])
  })
  test('a fork whose OWN meta never names a parent is never swept in — it is its own root', () => {
    const entries = [
      { agentId: 'root1', meta: null },
      { agentId: 'orphanFork', meta: { isFork: true } as { isFork: boolean; parentAgentId?: string } },
    ]
    expect(metaChainMembers('root1', entries)).toEqual(['root1'])
    // it never becomes a member of an UNRELATED root either, whatever the caller asks about
    expect(metaChainMembers('someOtherRoot', entries)).toEqual(['someOtherRoot'])
  })
  test('order is the directory listing order — nested entries never reorder themselves', () => {
    const entries = [
      { agentId: 'root1', meta: null },
      { agentId: 'later', meta: { parentAgentId: 'root1' } },
      { agentId: 'earlierByAlpha', meta: { parentAgentId: 'root1' } },
    ]
    expect(metaChainMembers('root1', entries)).toEqual(['root1', 'later', 'earlierByAlpha'])
  })
})

describe('cross-file dedup — the same message.id can never be counted twice, across files', () => {
  const line = (id: string, model: string, output: number) =>
    JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 1, output_tokens: output } } })

  test('an id shared by two files, with IDENTICAL usage, is counted ONCE — from the first file', () => {
    const fileA = fileUsageById([line('shared', 'm', 10)])
    const fileB = fileUsageById([line('shared', 'm', 10), line('onlyB', 'm', 5)])
    const { byModel, conflict } = globalDedupPerModel([fileA, fileB])
    expect(conflict).toBe(false)
    // shared(1+10) once, plus onlyB(1+5) — never shared counted twice
    expect(byModel.get('m')!.output).toBe(15)
    expect(byModel.get('m')!.input).toBe(2)
  })
  test('an id shared by two files with DIFFERENT usage is a CONFLICT, and the FIRST file wins', () => {
    const fileA = fileUsageById([line('shared', 'm', 10)])
    const fileB = fileUsageById([line('shared', 'm', 999)])
    const { byModel, conflict } = globalDedupPerModel([fileA, fileB])
    expect(conflict).toBe(true)
    expect(byModel.get('m')!.output).toBe(10) // the FIRST file's copy, never the second's
  })
  test('a record with no message.id is always counted, from every file', () => {
    const anon = JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 3 } } })
    const fileA = fileUsageById([anon])
    const fileB = fileUsageById([anon])
    const { byModel } = globalDedupPerModel([fileA, fileB])
    expect(byModel.get('m')!.output).toBe(6) // both counted — an id-less line can never be shown a duplicate
  })
})

describe('a subagent transcript carrying a MAIN-transcript response under the same message.id (A2.6)', () => {
  const line = (id: string, model: string, output: number) =>
    JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 1, output_tokens: output } } })

  test('an id the main transcript already carries is pre-claimed: dropped from the invocation, and counted', () => {
    const main = fileUsageById([line('parentLast', 'm', 40)])
    const fork = fileUsageById([line('parentLast', 'm', 40), line('ownWork', 'm', 7)])
    const { byModel, conflict, preclaimedHits } = globalDedupPerModel([fork], main.byId)
    expect(conflict).toBe(false)
    expect(preclaimedHits).toBe(1)
    // only ownWork(1+7) — the main transcript's response is never billed to the invocation too
    expect(byModel.get('m')!.output).toBe(7)
    expect(byModel.get('m')!.input).toBe(1)
  })
  test('the pre-claimed copy disagreeing with the subagent\'s copy is a conflict, never a silent pick', () => {
    const main = fileUsageById([line('parentLast', 'm', 40)])
    const fork = fileUsageById([line('parentLast', 'm', 41)])
    const { conflict, preclaimedHits } = globalDedupPerModel([fork], main.byId)
    expect(conflict).toBe(true)
    expect(preclaimedHits).toBe(1)
  })
  test('no pre-claimed ids: the result is exactly the pre-A2.6 one', () => {
    const fork = fileUsageById([line('a', 'm', 3), line('b', 'm', 4)])
    const without = globalDedupPerModel([fork])
    const withEmpty = globalDedupPerModel([fork], new Map())
    expect(withEmpty.byModel).toEqual(without.byModel)
    expect(without.preclaimedHits).toBe(0)
  })

  const conversationId = 'conv-fork'
  const stats = { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, otherToolCount: 0 }
  const legacyWith = (tokens: number, cost: number) => legacy({ agentMetrics: {
    invocations: [{
      toolUseId: 't1', agentId: 'aFork', agentType: 'general-purpose', description: '', status: 'completed',
      totalTokens: tokens, totalDurationMs: 0, totalToolUseCount: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      toolStats: { ...stats, linesAdded: 0, linesRemoved: 0 }, costUSD: cost,
    }],
    totalInvocations: 1, unmeasuredInvocations: 0, totalTokens: tokens, totalDurationMs: 0, totalCostUSD: cost,
  } })
  const projWith = (tokens: number, cost: number) => projection({ agentMetrics: {
    invocations: [{
      agentId: subagentIdOf(conversationId, 'aFork'), status: 'completed', totalTokens: tokens,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalToolUseCount: 0,
      toolStats: stats, costUSD: cost,
    }],
    totalInvocations: 1, unmeasuredInvocations: 0, totalTokens: tokens, totalCostUSD: cost,
  } })
  const ev = (mainSharedIds: number, projected: number, projectedCost: number): UsageEvidence => ({
    main: { firstWins: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lastWins: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageLines: 0, apiErrorZeroTtlLines: 0 },
    mainBytes: 1,
    roots: { aFork: {
      legacy: { tokens: 1000, costUSD: 2, toolUseCount: 0, toolStats: stats },
      projected: { tokens: projected, costUSD: projectedCost, toolUseCount: 0, toolStats: stats },
      conflict: false, mainSharedIds,
    } },
  })

  test('both sides reproduced with the main transcript\'s ids pre-claimed: explained by forkReplaysMain', () => {
    const rows = compareTools(conversationId, legacyWith(1000, 2), projWith(800, 1.5), ev(1, 800, 1.5))
    expect(rows.find(r => r.field === 'agentMetrics.invocations[aFork].totalTokens')!.reason).toBe(EXPLANATIONS.forkReplaysMain)
    expect(rows.find(r => r.field === 'agentMetrics.totalTokens')!.reason).toBe(EXPLANATIONS.forkReplaysMain)
    expect(rows.find(r => r.field === 'agentMetrics.totalCostUSD')!.reason).toBe(EXPLANATIONS.forkReplaysMainCost)
  })
  test('the same numbers with nothing shared with the main transcript keep the nested-rollup sentence', () => {
    const rows = compareTools(conversationId, legacyWith(1000, 2), projWith(800, 1.5), ev(0, 800, 1.5))
    expect(rows.find(r => r.field === 'agentMetrics.invocations[aFork].totalTokens')!.reason).toBe(EXPLANATIONS.nestedRollup)
  })
  test('a pre-claimed id that does NOT account for the difference is still a bug', () => {
    const rows = compareTools(conversationId, legacyWith(1000, 2), projWith(800, 1.5), ev(1, 801, 1.5))
    expect(rows.find(r => r.field === 'agentMetrics.invocations[aFork].totalTokens')!.verdict).toBe('bug')
    expect(rows.find(r => r.field === 'agentMetrics.totalTokens')!.verdict).toBe('bug')
  })
})

describe('pairInvocations — the fallback id, when the claimed one never resolves', () => {
  const conversationId = 'conv-1'
  const inv = (o: Partial<AgentInvocation> = {}): AgentInvocation => ({
    toolUseId: 'tool-1', agentType: 'general-purpose', description: '', status: 'completed',
    totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    toolStats: { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 },
    costUSD: 0, unmeasured: true, ...o,
  })
  const projInv = (agentId: string, o: Partial<ProjectedInvocation> = {}): ProjectedInvocation => ({
    agentId, status: 'unmeasured', unmeasured: true, totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalToolUseCount: 0,
    toolStats: { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, otherToolCount: 0 },
    costUSD: 0, ...o,
  })

  test('an interrupted call (no agentId at all) pairs by the fallback id, keyed on toolUseId', () => {
    const l = legacy({ agentMetrics: { invocations: [inv({ toolUseId: 'toolu_X' })], totalInvocations: 1, unmeasuredInvocations: 1, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0 } })
    const fallbackId = fallbackSubagentAgentId(conversationId, 'toolu_X')
    const p = projection({ agentMetrics: { invocations: [projInv(fallbackId)], totalInvocations: 1, unmeasuredInvocations: 1, totalTokens: 0, totalCostUSD: 0 } })
    const pairs = pairInvocations(conversationId, l, p)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.q).toBeDefined()
    expect(pairs[0]!.q!.agentId).toBe(fallbackId)
  })
  test('a claimed agentId with NO subagents/ directory falls back the same way', () => {
    const l = legacy({ agentMetrics: { invocations: [inv({ toolUseId: 'toolu_Y', agentId: 'aHexId123' })], totalInvocations: 1, unmeasuredInvocations: 1, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0 } })
    const fallbackId = fallbackSubagentAgentId(conversationId, 'toolu_Y')
    // The claimed id (subagentIdOf) resolves to nothing on the projected side — no transcript existed.
    expect(subagentIdOf(conversationId, 'aHexId123')).not.toBe(fallbackId)
    const p = projection({ agentMetrics: { invocations: [projInv(fallbackId)], totalInvocations: 1, unmeasuredInvocations: 1, totalTokens: 0, totalCostUSD: 0 } })
    const pairs = pairInvocations(conversationId, l, p)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.q!.agentId).toBe(fallbackId)
  })
  test('a genuinely claimed transcript still pairs by subagentIdOf, never the fallback', () => {
    const l = legacy({ agentMetrics: { invocations: [inv({ toolUseId: 'toolu_Z', agentId: 'aHexId456', unmeasured: undefined, totalTokens: 5 })], totalInvocations: 1, unmeasuredInvocations: 0, totalTokens: 5, totalDurationMs: 0, totalCostUSD: 0 } })
    const claimedId = subagentIdOf(conversationId, 'aHexId456')
    const p = projection({ agentMetrics: { invocations: [projInv(claimedId, { status: 'completed', unmeasured: undefined, totalTokens: 5 })], totalInvocations: 1, unmeasuredInvocations: 0, totalTokens: 5, totalCostUSD: 0 } })
    const pairs = pairInvocations(conversationId, l, p)
    expect(pairs[0]!.q!.agentId).toBe(claimedId)
  })
})

describe('the report', () => {
  test('collapses per-day and per-invocation fields, and names only ids and fields', () => {
    const report = summarize([
      { sessionId: 'abcdef0123', rows: [
        { family: 'time', field: 'daily.2026-09-01.tokens', verdict: 'equal' },
        { family: 'time', field: 'daily.2026-09-02.tokens', verdict: 'bug' },
        { family: 'tools', field: 'agentMetrics.invocations[x1].totalTokens', verdict: 'explained', reason: EXPLANATIONS.firstWins },
      ] },
    ])
    const day = report.fields.find(f => f.field === 'daily.<day>.tokens')!
    expect(day.counts.equal).toBe(1)
    expect(day.counts.bug).toBe(1)
    expect(day.bugSessions).toEqual(['abcdef0123'])
    expect(report.sessionsWithBugs).toBe(1)
    expect(renderReport(report)).toContain('agentMetrics.invocations[].totalTokens')
  })
})

describe('the fixture row (A2.2\'s redacted transcripts)', () => {
  for (const dir of ['claude-replay', 'claude-replay-compact']) {
    test(`${dir}: no unexplained difference on any projected counter`, async () => {
      const r = await runDifferential({ projectsDir: join(FIXTURES, dir), settledMs: 0, keepDiffs: true })
      expect(r.sessions).toBe(1)
      const bugs = r.diffs!.flatMap(d => d.rows.filter(x => x.verdict === 'bug'))
      expect(bugs).toEqual([])
    })
  }
  test('claude-replay: the subagent first-wins difference is reported as explained, not hidden', async () => {
    const r = await runDifferential({ projectsDir: join(FIXTURES, 'claude-replay'), settledMs: 0 })
    const f = r.fields.find(x => x.field === 'agentMetrics.totalTokens')!
    expect(f.counts.explained).toBe(1)
  })
})
