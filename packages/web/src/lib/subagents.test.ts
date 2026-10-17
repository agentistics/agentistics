import { describe, expect, it } from 'bun:test'
import {
  SUBAGENT_POLL_MS, appendPage, runningCount, subagentCount, subagentStatusText, subagentsPollMs,
  subagentsStateOf, unmeasuredText, unpricedText, listedObservation, stampPage, type SubagentRow,
} from './subagents'
import { resolveSubagentStatus, shouldPollSubagent } from './artifactLayout'

const row = (o: Partial<SubagentRow> = {}): SubagentRow => ({
  agentId: 'a1', status: 'finished', tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  totalTokens: 4, costUSD: 0.01, toolCalls: 2, turns: 3, ...o,
})

describe('subagentsStateOf — three answers, never one empty box', () => {
  it('keeps "this harness cannot report them" apart from "it ran none"', () => {
    expect(subagentsStateOf({ ok: true, supported: false, message: 'codex does not…' }).phase).toBe('unsupported')
    expect(subagentsStateOf({ ok: true, supported: true, rows: [], total: 0, hasMore: false }))
      .toEqual({ phase: 'ready', rows: [], total: 0, hasMore: false })
  })

  it('keeps a refusal apart from both', () => {
    expect(subagentsStateOf({ ok: false, message: 'gone' }).phase).toBe('failed')
  })
})

describe('subagentCount — the tab never says 0 for something it cannot count', () => {
  it('counts a supported session', () => {
    // The TOTAL, not what is loaded — a paged tab would otherwise say 20 for 57.
    expect(subagentCount({ phase: 'ready', rows: [row()], total: 57, hasMore: true })).toBe(57)
    expect(subagentCount({ phase: 'ready', rows: [], total: 0, hasMore: false })).toBe(0)
  })

  it('answers null wherever a count would be a claim', () => {
    expect(subagentCount({ phase: 'unsupported', message: 'x' })).toBe(null)
    expect(subagentCount({ phase: 'failed', message: 'x' })).toBe(null)
    expect(subagentCount({ phase: 'loading' })).toBe(null)
    expect(subagentCount(null)).toBe(null)
  })
})

describe('subagentsPollMs — only what can still change', () => {
  it('polls while an agent is running', () => {
    expect(subagentsPollMs({ phase: 'ready', rows: [row({ status: 'running' }), row()], total: 0, hasMore: false })).toBe(SUBAGENT_POLL_MS)
    expect(runningCount({ phase: 'ready', rows: [row({ status: 'running' })], total: 0, hasMore: false })).toBe(1)
  })

  it('stops once everything has stopped — the list costs a full read of the parent', () => {
    expect(subagentsPollMs({ phase: 'ready', rows: [row(), row({ status: 'failed' })], total: 0, hasMore: false })).toBe(null)
    expect(subagentsPollMs({ phase: 'unsupported', message: 'x' })).toBe(null)
    expect(subagentsPollMs(null)).toBe(null)
  })
})

describe('the words', () => {
  it('gives stopped its own word and colour', () => {
    expect(subagentStatusText('stopped', false).text).toBe('stopped')
    expect(subagentStatusText('stopped', false).color).not.toBe(subagentStatusText('failed', false).color)
  })

  it('says why a number is missing instead of printing a zero', () => {
    // "It has not answered yet" and "it spent nothing" are different facts.
    expect(unmeasuredText(row({ totalTokens: null, status: 'running' }), false)).toBe('has not answered yet')
    expect(unmeasuredText(row({ totalTokens: null, status: 'finished' }), false)).toBe('no transcript to measure')
    expect(unmeasuredText(row(), false)).toBe(null)
  })

  it('says why a cost is missing when the tokens are not', () => {
    expect(unpricedText(row({ costUSD: null }), false)).toBe('no price for this model')
    expect(unpricedText(row({ costUSD: null, totalTokens: null }), false)).toBe(null)
    expect(unpricedText(row(), false)).toBe(null)
  })
})

describe('appendPage — a page is merged, not stacked', () => {
  it('adds new agents and keeps the order pages arrived in', () => {
    const have = [row({ agentId: 'a' }), row({ agentId: 'b' })]
    expect(appendPage(have, [row({ agentId: 'c' })]).map(r => r.agentId)).toEqual(['a', 'b', 'c'])
  })

  it('REPLACES a row that came back with newer numbers instead of drawing it twice', () => {
    // The list is ordered by last activity, so a running agent moves between polls.
    const have = [row({ agentId: 'a', totalTokens: 1 }), row({ agentId: 'b' })]
    const merged = appendPage(have, [row({ agentId: 'a', totalTokens: 999 })])
    expect(merged).toHaveLength(2)
    expect(merged.find(r => r.agentId === 'a')!.totalTokens).toBe(999)
  })

  it('never throws away pages already asked for', () => {
    const have = [row({ agentId: 'a' }), row({ agentId: 'b' }), row({ agentId: 'c' })]
    expect(appendPage(have, [row({ agentId: 'd' })])).toHaveLength(4)
  })
})

describe('list observations carry the instant their response was received', () => {
  const ready = (status: SubagentRow['status']) => stampPage(
    { phase: 'ready', rows: [{ agentId: 'a', status } as SubagentRow], total: 1, hasMore: false }, 0)
  const rowAt = (status: SubagentRow['status'], at: number) => {
    const st = stampPage({ phase: 'ready', rows: [{ agentId: 'a', status } as SubagentRow], total: 1, hasMore: false }, at)
    return st.phase === 'ready' ? st.rows[0] : undefined
  }
  it('stamps ready pages only and keeps other phases untouched', () => {
    expect(ready('running').phase).toBe('ready')
    const failed = { phase: 'failed', message: 'x' } as const
    expect(stampPage(failed, 5)).toBe(failed)
    expect(listedObservation(undefined)).toBeUndefined()
    expect(listedObservation({ agentId: 'a', status: 'running' } as SubagentRow)).toBeUndefined()
  })
  it('running list → fetched unknown → a NEWER list response still running restarts polling', () => {
    const opened = { status: 'running' as const, at: 1 }
    const fetched = { status: 'unknown' as const, at: 2 }
    expect(shouldPollSubagent(resolveSubagentStatus([opened, listedObservation(rowAt('running', 1)), fetched]))).toBe(false)
    const newer = listedObservation(rowAt('running', 3))
    expect(shouldPollSubagent(resolveSubagentStatus([opened, newer, fetched]))).toBe(true)
  })
  it('fetched running → a NEWER list response terminal stops polling', () => {
    const opened = { status: 'running' as const, at: 1 }
    const fetched = { status: 'running' as const, at: 2 }
    expect(shouldPollSubagent(resolveSubagentStatus([opened, listedObservation(rowAt('running', 1)), fetched]))).toBe(true)
    expect(shouldPollSubagent(resolveSubagentStatus([opened, listedObservation(rowAt('finished', 3)), fetched]))).toBe(false)
  })
  it('a re-used (cached) row keeps its stamp, so it never outranks newer evidence', () => {
    const row = rowAt('running', 1)
    expect(listedObservation(row)).toEqual(listedObservation(row))
    expect(resolveSubagentStatus([listedObservation(row), { status: 'unknown', at: 2 }])).toBe('unknown')
  })
})
