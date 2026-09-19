import { describe, expect, test } from 'bun:test'
import { mentionFor, mentionSpecFor, MENTION_SPECS, PLAIN_MENTION_SPEC } from './mentionSpec'
import { HARNESS_ORDER } from '@agentistics/core'
import type { HarnessId } from '@agentistics/core'

describe('MENTION_SPECS', () => {
  test('every HarnessId has an entry — the Record type enforces this at compile time', () => {
    for (const h of HARNESS_ORDER) {
      expect(Object.prototype.hasOwnProperty.call(MENTION_SPECS, h)).toBe(true)
    }
  })

  test('claude is the only verified harness today', () => {
    const verified = (Object.keys(MENTION_SPECS) as HarnessId[]).filter(h => MENTION_SPECS[h] !== null)
    expect(verified).toEqual(['claude'])
  })
})

describe('mentionSpecFor', () => {
  test('claude uses its own @ syntax', () => {
    const spec = mentionSpecFor('claude')
    expect(spec.file('src/app.ts')).toBe('@src/app.ts')
    expect(spec.range('src/app.ts', 3, 5)).toBe('@src/app.ts#L3-5')
  })

  test('an unverified harness falls back to the plain form', () => {
    for (const h of ['codex', 'gemini', 'copilot', 'kimi', 'antigravity'] as HarnessId[]) {
      expect(mentionSpecFor(h)).toBe(PLAIN_MENTION_SPEC)
    }
  })

  test('an undefined harness (external row, or not yet reported) gets the plain form too', () => {
    expect(mentionSpecFor(undefined)).toBe(PLAIN_MENTION_SPEC)
  })

  test('the plain form is backtick-quoted and carries no @ — never guess a harness syntax', () => {
    expect(PLAIN_MENTION_SPEC.file('a/b.ts')).toBe('`a/b.ts`')
    expect(PLAIN_MENTION_SPEC.range('a/b.ts', 1, 2)).toBe('`a/b.ts:1-2`')
  })
})

describe('mentionFor', () => {
  test('a whole-file target with no lines uses the file form', () => {
    expect(mentionFor('claude', { path: 'src/app.ts' })).toBe('@src/app.ts')
  })

  test('a target with lines uses the range form', () => {
    expect(mentionFor('claude', { path: 'src/app.ts', lines: { start: 3, end: 5 } })).toBe('@src/app.ts#L3-5')
  })

  test('a single-line selection is a range with equal start and end', () => {
    expect(mentionFor('claude', { path: 'src/app.ts', lines: { start: 7, end: 7 } })).toBe('@src/app.ts#L7-7')
  })

  test('an unverified harness never receives an @-prefixed mention', () => {
    const text = mentionFor('gemini', { path: 'src/app.ts', lines: { start: 1, end: 2 } })
    expect(text.startsWith('@')).toBe(false)
    expect(text).toBe('`src/app.ts:1-2`')
  })
})
