import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NEWLINE_GAP_MS, normalize, stepsText, typingSteps } from './typing-plan'

describe('typingSteps — a typed message is never one multi-line burst', () => {
  test('a single line is one burst, as before', () => {
    expect(typingSteps('hello there')).toEqual([{ kind: 'literal', text: 'hello there' }])
    expect(typingSteps('')).toEqual([])
  })
  test('REPRODUCTION: the owner\'s five-line message becomes five lines joined by newline keys', () => {
    const msg = 'o botao de resolver\nnao da pra entender\n\ndeveria dar pra mencionar sessoes\nno lado esquerdo'
    const steps = typingSteps(msg)
    expect(steps.filter(s => s.kind === 'literal')).toHaveLength(4)
    expect(steps.filter(s => s.kind === 'newline')).toHaveLength(4)
    // No step carries a line break inside a literal: that is the burst a harness reads as a paste.
    expect(steps.every(s => s.kind === 'newline' || !s.text.includes('\n'))).toBe(true)
  })
  test('what arrives is identical to the message — splitting changes timing, never content', () => {
    for (const m of ['a\nb', 'a\n\nb', '\nlead', 'trail\n', 'one\ntwo\nthree\n\n', 'x']) expect(stepsText(typingSteps(m))).toBe(m)
  })
  test('CRLF and CR are LF first', () => {
    expect(normalize('a\r\nb\rc')).toBe('a\nb\nc')
    expect(stepsText(typingSteps('a\r\nb'))).toBe('a\nb')
  })
  test('the gap between lines is short enough to never be felt', () => {
    expect(NEWLINE_GAP_MS).toBeGreaterThan(0)
    expect(NEWLINE_GAP_MS).toBeLessThanOrEqual(60)
  })
})

describe('the tmux backend types through the plan', () => {
  const src = readFileSync(join(import.meta.dir, 'backend-tmux.ts'), 'utf8')
  test('typeAndSubmit walks typingSteps and presses C-j between lines, never one burst of the whole text', () => {
    expect(src).toContain('for (const step of typingSteps(text))')
    expect(src).toContain("sendKeysNamedArgs(id, 'C-j')")
    expect(src).not.toMatch(/const typed = await tmux\(sendKeysLiteralArgs\(id, text\)\)/)
  })
})
