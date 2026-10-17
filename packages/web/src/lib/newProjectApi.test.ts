import { describe, expect, test } from 'bun:test'
import { projectNameMessage } from '@agentistics/core'
import { toRefusal } from './newProjectApi'

describe('toRefusal', () => {
  test('a known refusal keeps its code', () => {
    expect(toRefusal('forbidden')).toEqual({ ok: false, reason: 'forbidden' })
    expect(toRefusal('exists-other', '/h/x')).toEqual({ ok: false, reason: 'exists-other' })
  })
  test('only exists carries the path to reuse', () => {
    expect(toRefusal('exists', '/h/x')).toEqual({ ok: false, reason: 'exists', path: '/h/x' })
  })
  test.each(['csrf_blocked', 'capability_disabled', 'internal', undefined, 42, null, { code: 'x' }])('%p becomes failed, which has a sentence', error => {
    const out = toRefusal(error, '/h/x')
    expect(out).toEqual({ ok: false, reason: 'failed' })
    if (!out.ok) {
      expect(projectNameMessage(out.reason, true)).toBeTruthy()
      expect(projectNameMessage(out.reason, false)).toBeTruthy()
    }
  })
})
