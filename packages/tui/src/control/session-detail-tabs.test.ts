import { describe, expect, test } from 'bun:test'
import { detailTabLines, stepDetailTab, type DetailLine, type DetailTabWords } from './session-fleet'
import type { ControlSession } from './types'

const W: DetailTabWords = {
  tabs: { chat: 'chat', terminal: 'terminal', metrics: 'metrics' }, hint: '← →',
  chatNative: 'NATIVE-CHAT', chatExternal: 'EXT-CHAT', chatUnlinked: 'UNLINKED', chatClosed: 'CLOSED-CHAT',
  termCaptured: 'CAPTURED', termNative: 'NATIVE-TERM', termExternal: 'EXT-TERM', termClosed: 'CLOSED-TERM', termEmpty: 'EMPTY',
  tokens: 'tokens', input: 'input', output: 'output', cacheRead: 'cache read', cacheWrite: 'cache write',
  notRecorded: 'N/A · not recorded', cost: 'cost', costNote: 'api-equivalent', context: 'context',
  contextNA: 'N/A — no verified window', turns: 'turns', metricsNone: 'NO-METRICS', metricsNative: 'NATIVE-METRICS',
}
const base = (over: Partial<ControlSession>): ControlSession => ({
  id: 'a1', title: 't', harness: 'claude', cwd: '/w', project: 'w', state: 'working', stateLabel: 'working',
  actionable: true, attached: false, searchFields: { name: '', folder: '', harness: '', note: '', task: '', prompt: '' },
  ...over,
} as ControlSession)
const facts: DetailLine[] = [
  { key: 'chat0', label: 'saying', value: 'hello', role: 'user' },
  { key: 'where', label: 'where', value: '/w' },
  { key: 'conv', label: 'conversation', value: 'c-1' },
]
const vals = (l: DetailLine[]) => l.map(x => x.value)

describe('detail tabs (SS-03 chat · SS-04 terminal · SS-05 metrics)', () => {
  test('← → wraps through the three tabs', () => {
    expect(stepDetailTab('chat', 1)).toBe('terminal')
    expect(stepDetailTab('metrics', 1)).toBe('chat')
    expect(stepDetailTab('chat', -1)).toBe('metrics')
  })
  test('chat: the linked turns; otherwise a sentence by kind — never the screen as a conversation', () => {
    const l = detailTabLines(base({ chatTurns: [{ role: 'user', text: 'hello' }] as never }), 'chat', facts, W)
    expect(l[0]!.tabs).toEqual({ items: ['chat', 'terminal', 'metrics'], active: 0, hint: '← →' })
    expect(vals(l)).toEqual([l[0]!.value, 'hello', 'c-1', '/w'])
    const noTurns = facts.filter(f => f.key !== 'chat0')
    expect(vals(detailTabLines(base({ lastLines: ['$ x'] }), 'chat', noTurns, W))).toContain('UNLINKED')
    expect(vals(detailTabLines(base({ harness: 'agentistics', state: 'closed' }), 'chat', noTurns, W))).toContain('NATIVE-CHAT')
    expect(vals(detailTabLines(base({ actionable: false, state: 'unknown' }), 'chat', noTurns, W))).toContain('EXT-CHAT')
  })
  test('terminal: the captured frame of a hosted session; native / external / ended say why', () => {
    expect(vals(detailTabLines(base({ lastLines: ['Do you want to proceed?', '❯ 1. Yes'] }), 'terminal', facts, W)).slice(1, 4))
      .toEqual(['CAPTURED', 'Do you want to proceed?', '❯ 1. Yes'])
    expect(vals(detailTabLines(base({ harness: 'agentistics', state: 'closed' }), 'terminal', facts, W))[1]).toBe('NATIVE-TERM')
    expect(vals(detailTabLines(base({ actionable: false, state: 'unknown' }), 'terminal', facts, W))[1]).toBe('EXT-TERM')
    expect(vals(detailTabLines(base({ state: 'closed' }), 'terminal', facts, W))[1]).toBe('CLOSED-TERM')
  })
  test('metrics: all four counters (N/A where not recorded), cost, context or N/A, turns', () => {
    const l = detailTabLines(base({
      tokens: '1.2M', cost: '$3.10', turns: 12,
      tokenParts: { input: '12k', output: '8k', cacheRead: '1.1M', cacheWrite: null },
    }), 'metrics', facts, W)
    expect(l.slice(1, 9).map(x => [x.label, x.value])).toEqual([
      ['tokens', '1.2M'], ['input', '12k'], ['output', '8k'], ['cache read', '1.1M'],
      ['cache write', 'N/A · not recorded'], ['cost', '$3.10  ·  api-equivalent'],
      ['context', 'N/A — no verified window'], ['turns', '12'],
    ])
    expect(vals(detailTabLines(base({ actionable: false, state: 'unknown' }), 'metrics', facts, W))[1]).toBe('NO-METRICS')
    expect(vals(detailTabLines(base({ harness: 'agentistics' }), 'metrics', facts, W))[1]).toBe('NATIVE-METRICS')
  })
})
