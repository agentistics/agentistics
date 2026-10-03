import { describe, expect, it } from 'bun:test'
import { attentionLine, placeAttention, recordedFigures, type ChatAttentionMark, type ChatRecorded } from './sessionRecorded'

const mark = (at: string, over: Partial<ChatAttentionMark> = {}): ChatAttentionMark => ({ at, kind: 'approval', via: 'screen', ...over })

describe('placeAttention — marks go before the first turn that came after them', () => {
  const turns = [{ at: '2026-10-01T10:00:00.000Z' }, { at: '2026-10-01T10:10:00.000Z' }, {}]
  it('by time; a mark after every dated turn goes to the end; a turn with no time never anchors one', () => {
    const p = placeAttention(turns, [mark('2026-10-01T10:05:00.000Z'), mark('2026-10-01T09:00:00.000Z'), mark('2026-10-01T11:00:00.000Z')])
    expect([...p.before.keys()]).toEqual([0, 1])
    expect(p.before.get(0)!.map(m => m.at)).toEqual(['2026-10-01T09:00:00.000Z'])
    expect(p.before.get(1)!.map(m => m.at)).toEqual(['2026-10-01T10:05:00.000Z'])
    expect(p.after.map(m => m.at)).toEqual(['2026-10-01T11:00:00.000Z'])
  })
  it('no turns: every mark is "after" — nothing is lost', () => {
    expect(placeAttention([], [mark('2026-10-01T10:00:00.000Z')]).after).toHaveLength(1)
  })
})

describe('attentionLine', () => {
  it('says what was asked, how it ended and how long it waited — in the reader\'s language', () => {
    expect(attentionLine(mark('x', { kind: 'approval', how: 'answered-here', blockedMs: 4000 }), false)).toBe('Asked you to approve · answered here · waited 4 s')
    expect(attentionLine(mark('x', { kind: 'question', how: 'session-ended' }), true)).toBe('Perguntou algo a você · a sessão terminou')
    expect(attentionLine(mark('x', { kind: 'select' }), false)).toBe('Asked you to choose · not answered here')
  })
})

describe('recordedFigures', () => {
  const r: ChatRecorded = { firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-02T10:00:00.000Z', turns: 12, toolCalls: 40, toolsFailed: 2, toolsDenied: 1, models: ['claude-opus-5-5'], tokens: { input: 1500, output: 20 } }
  it('numbers only; absent is not zero', () => {
    const f = recordedFigures(r, false)
    expect(f).toContainEqual({ label: 'Turns', value: '12' })
    expect(f).toContainEqual({ label: 'Tool calls', value: '40 (2 failed, 1 denied)' })
    expect(f).toContainEqual({ label: 'Models', value: 'claude-opus-5-5' })
    expect(f).toContainEqual({ label: 'Tokens', value: '1.5k in · 20 out' })
    expect(recordedFigures({ ...r, tokens: null, models: [] }, false).some(x => x.label === 'Tokens' || x.label === 'Models')).toBe(false)
  })
  it('portuguese labels', () => {
    expect(recordedFigures(r, true)[0]).toEqual({ label: 'Interações', value: '12' })
  })
})
