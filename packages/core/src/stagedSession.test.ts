import { describe, expect, test } from 'bun:test'
import {
  MAX_STAGED_ATTACHMENTS, composePromptWithPaths, normalizeStagedSession,
  validateStagedSessionDraft,
} from './stagedSession'

describe('validateStagedSessionDraft', () => {
  test('a bare prompt is valid — everything else is optional', () => {
    expect(validateStagedSessionDraft({ prompt: 'do it' })).toEqual({ ok: true })
  })
  test('an empty prompt is refused — a draft with nothing to say is not a draft', () => {
    expect(validateStagedSessionDraft({ prompt: '  ' })).toEqual({ ok: false, issue: 'prompt' })
  })
  test('a relative cwd is refused, an absent one is fine', () => {
    expect(validateStagedSessionDraft({ prompt: 'do it', cwd: 'relative/path' }))
      .toEqual({ ok: false, issue: 'cwd_relative' })
    expect(validateStagedSessionDraft({ prompt: 'do it', cwd: undefined })).toEqual({ ok: true })
    expect(validateStagedSessionDraft({ prompt: 'do it', cwd: '/abs/path' })).toEqual({ ok: true })
  })
})

describe('normalizeStagedSession', () => {
  test('total: non-object input reads as no draft', () => {
    expect(normalizeStagedSession(undefined)).toBeUndefined()
    expect(normalizeStagedSession(null)).toBeUndefined()
    expect(normalizeStagedSession('nope')).toBeUndefined()
    expect(normalizeStagedSession(42)).toBeUndefined()
  })

  test('reads a well-formed draft back exactly', () => {
    const raw = {
      prompt: 'Fix the flaky test', attachmentIds: ['f1', 'f2'],
      harness: 'claude', cwd: '/repo', model: 'sonnet', effort: 'high',
    }
    expect(normalizeStagedSession(raw)).toEqual({
      prompt: 'Fix the flaky test', attachmentIds: ['f1', 'f2'],
      harness: 'claude', cwd: '/repo', model: 'sonnet', effort: 'high',
    })
  })

  test('a bare prompt normalizes to a draft with nothing else', () => {
    expect(normalizeStagedSession({ prompt: 'do it' })).toEqual({ prompt: 'do it' })
  })

  test('an empty or missing prompt drops the WHOLE draft, never a half-read one', () => {
    expect(normalizeStagedSession({ prompt: '' })).toBeUndefined()
    expect(normalizeStagedSession({ prompt: '   ' })).toBeUndefined()
    expect(normalizeStagedSession({ harness: 'claude' })).toBeUndefined()
  })

  test('a relative cwd drops the whole draft — a half-read one would fire somewhere nobody chose', () => {
    expect(normalizeStagedSession({ prompt: 'do it', cwd: 'relative' })).toBeUndefined()
  })

  test('trims whitespace and drops empty optional fields', () => {
    expect(normalizeStagedSession({ prompt: '  do it  ', cwd: '   ', model: '  ' }))
      .toEqual({ prompt: 'do it' })
  })

  test('dedupes attachment ids and caps at MAX_STAGED_ATTACHMENTS', () => {
    const raw = {
      prompt: 'do it',
      attachmentIds: [...Array.from({ length: MAX_STAGED_ATTACHMENTS + 5 }, (_, i) => `f${i}`), 'f0'],
    }
    const out = normalizeStagedSession(raw)
    expect(out?.attachmentIds?.length).toBe(MAX_STAGED_ATTACHMENTS)
    expect(out?.attachmentIds?.[0]).toBe('f0')
  })

  test('a non-array/garbage attachmentIds reads as none, never throws', () => {
    expect(normalizeStagedSession({ prompt: 'do it', attachmentIds: 'nope' })).toEqual({ prompt: 'do it' })
    expect(normalizeStagedSession({ prompt: 'do it', attachmentIds: [1, null, 'ok'] }))
      .toEqual({ prompt: 'do it', attachmentIds: ['ok'] })
  })
})

describe('composePromptWithPaths', () => {
  test('paths first, each on its own line, then the prompt', () => {
    expect(composePromptWithPaths(['/tmp/a.png', '/tmp/b.png'], 'look at these'))
      .toBe('/tmp/a.png\n/tmp/b.png\nlook at these')
  })
  test('no paths is just the prompt', () => {
    expect(composePromptWithPaths([], 'do it')).toBe('do it')
  })
  test('an empty prompt with paths is just the paths', () => {
    expect(composePromptWithPaths(['/tmp/a.png'], '')).toBe('/tmp/a.png')
  })
})
