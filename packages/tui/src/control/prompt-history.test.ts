import { describe, expect, test } from 'bun:test'
import { lineText, lineWidth } from './code'
import { codeStrings } from './code-i18n'
import { filterPrompts, historyKey, historyLines, openHistory, type HistoryState } from './prompt-history'
import type { CodePromptRecord } from './code-types'

const t = codeStrings('en')

const P: CodePromptRecord[] = [
  { text: 'run the core tests', at: '2026-09-28T12:00:00Z', sessionId: 's1' },
  { text: 'fix the Parser off-by-one', at: '2026-09-28T14:00:00Z', sessionId: 's2' },
  { text: 'summarize\nthe diff', at: '2026-09-27T10:00:00Z', sessionId: 's3' },
]

const loaded = (over: Partial<HistoryState> = {}): HistoryState => ({ ...openHistory(), prompts: P, ...over })

describe('prompt history (CD-18)', () => {
  test('newest first, filtered case- and whitespace-insensitively', () => {
    expect(filterPrompts(P, '').map(p => p.sessionId)).toEqual(['s2', 's1', 's3'])
    expect(filterPrompts(P, 'PARSER').map(p => p.sessionId)).toEqual(['s2'])
    expect(filterPrompts(P, 'summarize the').map(p => p.sessionId)).toEqual(['s3'])
  })

  test('typing filters and resets the pick; ↑↓ move within the matches', () => {
    let s = loaded()
    s = historyKey(s, { input: '', downArrow: true }).state
    s = historyKey(s, { input: '', downArrow: true }).state
    s = historyKey(s, { input: '', downArrow: true }).state
    expect(s.sel).toBe(2)
    s = historyKey(s, { input: 'r' }).state
    expect(s).toMatchObject({ query: 'r', sel: 0 })
    s = historyKey(s, { input: '', upArrow: true }).state
    expect(s.sel).toBe(0)
  })

  test('enter puts the pick back for EDITING — the effect is `use`, never a send; esc closes', () => {
    const r = historyKey(loaded({ sel: 1 }), { input: '', return: true })
    expect(r.effect).toEqual({ kind: 'use', text: 'run the core tests' })
    expect(historyKey(loaded(), { input: '', escape: true }).effect).toEqual({ kind: 'close' })
    expect(historyKey(loaded({ query: 'zzz' }), { input: '', return: true }).effect).toEqual({ kind: 'none' })
  })

  test('the empty states are said in words: loading, none on this machine, no match, a refusal', () => {
    const say = (s: HistoryState) => historyLines(s, t, 60).body.map(lineText).join(' ')
    expect(say(openHistory())).toBe('reading your earlier prompts…')
    expect(say(loaded({ prompts: [] }))).toBe('No earlier prompts on this machine yet.')
    expect(say(loaded({ query: 'nope' }))).toBe('No earlier prompt matches that.')
    expect(say({ ...openHistory(), error: 'The journal could not be read.' })).toBe('The journal could not be read.')
    expect(historyLines(openHistory(), t, 60).selected).toBeNull()
  })

  test('rows mark the pick, flatten line breaks, and fit the width', () => {
    for (const w of [30, 34, 76, 106]) {
      const h = historyLines(loaded({ sel: 2 }), t, w)
      expect(h.selected).toBe(2)
      for (const l of [...h.head, ...h.body, ...h.foot]) expect(lineWidth(l)).toBeLessThanOrEqual(w)
      expect(lineText(h.body[2]!).startsWith('▸ summarize')).toBe(true)
      expect(lineText(h.body[2]!)).not.toContain('\n')
    }
  })
})
