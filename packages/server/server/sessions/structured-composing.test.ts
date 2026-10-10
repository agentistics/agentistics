import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS_ORDER } from '@agentistics/core'
import {
  COMPOSING_RULES, __resetComposingForTest, clearComposing, composingOf, composingStep, noteComposingLine, onComposing, type Composing,
} from './structured-composing'

/**
 * The REAL frames of one AskUserQuestion turn, recorded from claude 2.1.295 on 2026-10-09 (the engine's
 * redacted `claude-stream-json-basic` fixture, its stdout lines in the relay's own `{t, l}` shape).
 */
const OUT = readFileSync(join(import.meta.dir, 'fixtures', 'claude-ask-question.out.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l) as { t: number; l: string })

const isQuestionStart = (l: string) => /"content_block_start"/.test(l) && /"name":"AskUserQuestion"/.test(l)
const isCard = (l: string) => /"type":"control_request"/.test(l) && /"tool_name":"AskUserQuestion"/.test(l)

afterEach(() => __resetComposingForTest())

describe('composingStep — claude, over the real frames', () => {
  it('says "question" from the tool block\'s start until the card arrives, and nothing before or after', () => {
    let c: Composing = null
    const trace: Array<{ t: number; c: Composing }> = []
    for (const r of OUT) { c = composingStep('claude', c, r.l); trace.push({ t: r.t, c }) }
    const start = OUT.findIndex(r => isQuestionStart(r.l))
    const card = OUT.findIndex(r => isCard(r.l))
    expect(start).toBeGreaterThan(0)
    expect(card).toBeGreaterThan(start)
    expect(trace.slice(0, start).every(x => x.c === null)).toBe(true)
    expect(trace.slice(start, card).every(x => x.c === 'question')).toBe(true)
    expect(trace.slice(card).every(x => x.c === null)).toBe(true)
    // The gap the indicator fills, measured on this recording.
    expect(OUT[card]!.t - OUT[start]!.t).toBe(344)
  })

  it('another tool, a text block, a subagent\'s question and an unparsable line never say "question"', () => {
    const block = (name: string, parent: string | null = null) =>
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name, input: {} } }, parent_tool_use_id: parent })
    expect(composingStep('claude', null, block('Bash'))).toBeNull()
    expect(composingStep('claude', null, block('AskUserQuestion', 'toolu_parent'))).toBeNull()
    expect(composingStep('claude', 'question', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } }, parent_tool_use_id: null }))).toBeNull()
    expect(composingStep('claude', 'question', '{not json')).toBe('question')
    expect(composingStep('claude', 'question', JSON.stringify({ type: 'result', subtype: 'success' }))).toBeNull()
  })

  it('every harness is listed: a rule, or the sentence why not — and only a rule ever says "question"', () => {
    for (const h of HARNESS_ORDER) {
      const r = COMPOSING_RULES[h]
      expect(typeof r === 'function' || (typeof r === 'string' && r.length > 10)).toBe(true)
      if (typeof r === 'string') for (const x of OUT) expect(composingStep(h, null, x.l)).toBeNull()
    }
  })
})

describe('the store', () => {
  it('announces changes only, per session, and clears', () => {
    const seen: Composing[] = []
    const off = onComposing('s1', c => seen.push(c))
    for (const r of OUT) noteComposingLine('s1', 'claude', r.l)
    expect(seen).toEqual(['question', null])
    noteComposingLine('s1', 'claude', OUT.find(r => isQuestionStart(r.l))!.l)
    expect(composingOf('s1')).toBe('question')
    expect(composingOf('s2')).toBeNull()
    clearComposing('s1')
    expect(composingOf('s1')).toBeNull()
    expect(seen).toEqual(['question', null, 'question', null])
    off()
    noteComposingLine('s1', 'claude', OUT.find(r => isQuestionStart(r.l))!.l)
    expect(seen.length).toBe(4)
  })
})
