import { describe, test, expect } from 'bun:test'
import { inspect } from 'node:util'
import {
  createCredentialHandle,
  fingerprintOf,
  formatMode,
  isModeTooOpen,
  keyShapeSentence,
  parseStoredCredential,
  refusalSentence,
  serializeCredential,
  validateKeyShape,
  type KeyShapeRefusal,
} from './credential-plan.ts'

// A key shaped exactly like a real one, built at runtime so no real-looking secret sits in the
// repo's history — never a literal that could be mistaken for a live key.
const FAKE_KEY = 'sk-ant-' + 'test' + 'x'.repeat(40)

describe('validateKeyShape', () => {
  test('a well-formed key is accepted', () => {
    expect(validateKeyShape(FAKE_KEY)).toEqual({ ok: true })
  })

  const cases: Array<{ reason: KeyShapeRefusal; value: string }> = [
    { reason: 'empty', value: '' },
    { reason: 'whitespace', value: FAKE_KEY.slice(0, 20) + ' ' + FAKE_KEY.slice(20) },
    { reason: 'control', value: FAKE_KEY.slice(0, 20) + '\x01' + FAKE_KEY.slice(20) },
    { reason: 'bracketed-paste', value: 'sk-ant-' + 'x'.repeat(30) + '[200~' },
    { reason: 'prefix', value: 'sk-oth-' + 'x'.repeat(40) },
    { reason: 'too-short', value: 'sk-ant-' + 'x'.repeat(5) },
    { reason: 'too-long', value: 'sk-ant-' + 'x'.repeat(600) },
  ]

  for (const { reason, value } of cases) {
    test(`refuses "${reason}"`, () => {
      expect(validateKeyShape(value)).toEqual({ ok: false, reason })
    })

    test(`the "${reason}" sentence never echoes the rejected value`, () => {
      const sentence = keyShapeSentence(reason)
      if (value.length > 0) {
        expect(sentence).not.toContain(value)
        expect(sentence.toLowerCase()).not.toContain(value.toLowerCase())
      }
    })
  }

  test('every refusal reason has a non-empty, distinct sentence', () => {
    const reasons: KeyShapeRefusal[] = [
      'empty', 'whitespace', 'control', 'bracketed-paste', 'prefix', 'too-short', 'too-long',
    ]
    const sentences = reasons.map(keyShapeSentence)
    for (const s of sentences) expect(s.length).toBeGreaterThan(0)
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  test('does not trim — a value with a trailing newline is refused as whitespace', () => {
    // The caller (`cli-provider.ts`) strips one trailing \n/\r\n before calling this function;
    // this function itself must never do that silently, or a genuinely bad value could slip
    // through both layers unnoticed.
    expect(validateKeyShape(FAKE_KEY + '\n')).toEqual({ ok: false, reason: 'whitespace' })
  })
})

describe('fingerprintOf', () => {
  test('matches the documented shape', () => {
    expect(fingerprintOf(FAKE_KEY)).toMatch(/^sha256:[0-9a-f]{8}$/)
  })

  test('is stable — the same key always fingerprints the same', () => {
    expect(fingerprintOf(FAKE_KEY)).toBe(fingerprintOf(FAKE_KEY))
  })

  test('is not a substring of the key, and the key is not a substring of it', () => {
    const fp = fingerprintOf(FAKE_KEY)
    expect(FAKE_KEY.includes(fp)).toBe(false)
    expect(fp.includes(FAKE_KEY)).toBe(false)
  })

  test('a rotated key fingerprints differently, so a rotation is visible as old -> new', () => {
    const other = 'sk-ant-' + 'other' + 'y'.repeat(40)
    expect(fingerprintOf(FAKE_KEY)).not.toBe(fingerprintOf(other))
  })
})

describe('createCredentialHandle — the value never leaks through any stringification', () => {
  const handle = createCredentialHandle('anthropic', FAKE_KEY)
  const label = `[credential anthropic ${fingerprintOf(FAKE_KEY)}]`

  test('reveal() returns the actual key — it is the one sanctioned way out', () => {
    expect(handle.reveal()).toBe(FAKE_KEY)
  })

  test('JSON.stringify never contains the key and carries the label', () => {
    const out = JSON.stringify(handle)
    expect(out).not.toContain(FAKE_KEY)
    expect(out).toContain(label)
  })

  test('String(handle) never contains the key and carries the label', () => {
    const out = String(handle)
    expect(out).not.toContain(FAKE_KEY)
    expect(out).toBe(label)
  })

  test('a template literal never contains the key and carries the label', () => {
    const out = `${handle}`
    expect(out).not.toContain(FAKE_KEY)
    expect(out).toBe(label)
  })

  test('util.inspect never contains the key and carries the label', () => {
    const out = inspect(handle)
    expect(out).not.toContain(FAKE_KEY)
    expect(out).toContain(label)
  })

  test('Object.keys never contains the key', () => {
    const keys = Object.keys(handle)
    expect(keys.join(',')).not.toContain(FAKE_KEY)
  })

  test('Object.getOwnPropertyNames never contains the key', () => {
    const names = Object.getOwnPropertyNames(handle)
    expect(names.join(',')).not.toContain(FAKE_KEY)
  })

  test('fingerprint and provider are readable and correct', () => {
    expect(handle.provider).toBe('anthropic')
    expect(handle.fingerprint).toBe(fingerprintOf(FAKE_KEY))
  })
})

describe('isModeTooOpen / formatMode', () => {
  test('0600 is not too open', () => {
    expect(isModeTooOpen(0o600)).toBe(false)
  })

  test('0700 (a directory) is not too open', () => {
    expect(isModeTooOpen(0o700)).toBe(false)
  })

  test('0644 (group/other read) is too open', () => {
    expect(isModeTooOpen(0o644)).toBe(true)
  })

  test('0660 (group write) is too open', () => {
    expect(isModeTooOpen(0o660)).toBe(true)
  })

  test('file-type bits above the permission bits do not affect the check', () => {
    // A real stat().mode carries the file-type bits (e.g. S_IFREG = 0o100000) above the low 9.
    expect(isModeTooOpen(0o100600)).toBe(false)
    expect(isModeTooOpen(0o100644)).toBe(true)
  })

  test('formatMode renders the familiar 0NNN form', () => {
    expect(formatMode(0o600)).toBe('0600')
    expect(formatMode(0o644)).toBe('0644')
    expect(formatMode(0o700)).toBe('0700')
    expect(formatMode(0o100600)).toBe('0600')
  })
})

describe('serializeCredential / parseStoredCredential round-trip', () => {
  test('round-trips value and storedAt exactly', () => {
    const storedAt = new Date('2026-09-25T12:00:00.000Z').toISOString()
    const text = serializeCredential('anthropic', FAKE_KEY, storedAt)
    const parsed = parseStoredCredential(text, 'anthropic')
    expect(parsed).toEqual({ ok: true, value: FAKE_KEY, storedAt })
  })

  test('malformed JSON reads as unreadable', () => {
    expect(parseStoredCredential('{ not json', 'anthropic')).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('a JSON array reads as unreadable', () => {
    expect(parseStoredCredential('[]', 'anthropic')).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('a well-formed document missing a field reads as unreadable', () => {
    const text = JSON.stringify({ v: 1, provider: 'anthropic', value: FAKE_KEY })
    expect(parseStoredCredential(text, 'anthropic')).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('a value that fails shape validation reads as unreadable, not "present but wrong"', () => {
    const text = serializeCredential('anthropic', 'not-a-real-key-shape', new Date().toISOString())
    expect(parseStoredCredential(text, 'anthropic')).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('a document written for a different provider reads as wrong-provider', () => {
    const text = serializeCredential('anthropic', FAKE_KEY, new Date().toISOString())
    // @ts-expect-error — deliberately asking for a provider the document does not name.
    expect(parseStoredCredential(text, 'openai')).toEqual({ ok: false, reason: 'wrong-provider' })
  })
})

describe('refusalSentence', () => {
  test('central names the reason, never a secret', () => {
    const s = refusalSentence('central')
    expect(s.toLowerCase()).toContain('central')
    expect(s).not.toContain(FAKE_KEY)
  })

  test('flag-off names the env var to set', () => {
    const s = refusalSentence('flag-off')
    expect(s).toContain('AGENTISTICS_PROVIDER')
    expect(s).not.toContain(FAKE_KEY)
  })
})
