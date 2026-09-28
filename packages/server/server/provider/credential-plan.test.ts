import { describe, test, expect } from 'bun:test'
import { inspect } from 'node:util'
import {
  createCredentialHandle,
  fingerprintOf,
  lastFourOf,
  KEY_TAIL_LENGTH,
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
      'empty', 'whitespace', 'control', 'bracketed-paste', 'prefix', 'foreign-prefix', 'too-short', 'too-long',
    ]
    const sentences = reasons.map(r => keyShapeSentence(r))
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

  test('lastFourOf shows the last 4 characters and never more (C-3)', () => {
    const key = 'sk-ant-' + 'abcdefghijklmnopqrst' + 'WXYZ'
    expect(lastFourOf(key)).toBe('WXYZ')
    expect(lastFourOf(key)).toHaveLength(KEY_TAIL_LENGTH)
    expect(KEY_TAIL_LENGTH).toBe(4)
    // A value too short to be a key yields nothing, never the whole thing.
    expect(lastFourOf('abcd')).toBe('')
    expect(lastFourOf('sk-ant-abc')).toBe('')
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

// ── B5a — endpoints: key shape, base URL, the stored record ─────────────────────────────────────

import {
  baseUrlSentence,
  parseStoredEndpoint,
  serializeEndpoint,
  validateBaseUrl,
  type BaseUrlRefusal,
} from './credential-plan.ts'

const FAKE_EP_KEY = 'sk-or-' + 'test' + 'q'.repeat(40)

describe('validateKeyShape — per endpoint, loose', () => {
  test('no prefix rule for an endpoint (an OpenRouter or operator-minted key passes)', () => {
    expect(validateKeyShape(FAKE_EP_KEY, 'openrouter')).toEqual({ ok: true })
    expect(validateKeyShape('sk-1234', 'litellm')).toEqual({ ok: true })
  })

  test('refuses whitespace, paste residue, absurd lengths and an Anthropic key', () => {
    expect(validateKeyShape(FAKE_EP_KEY + ' ', 'openrouter')).toEqual({ ok: false, reason: 'whitespace' })
    expect(validateKeyShape('[200~' + FAKE_EP_KEY, 'openrouter')).toEqual({ ok: false, reason: 'bracketed-paste' })
    expect(validateKeyShape('x'.repeat(600), 'openai')).toEqual({ ok: false, reason: 'too-long' })
    expect(validateKeyShape('short', 'openai')).toEqual({ ok: false, reason: 'too-short' })
    expect(validateKeyShape(FAKE_KEY, 'openrouter')).toEqual({ ok: false, reason: 'foreign-prefix' })
  })

  test('the endpoint sentences never echo the value and name the endpoint', () => {
    const s = keyShapeSentence('too-short', 'openrouter')
    expect(s).toContain('OpenRouter')
    expect(keyShapeSentence('foreign-prefix', 'openai')).toContain('agentop provider key set anthropic')
    expect(keyShapeSentence('foreign-prefix', 'openai')).not.toContain(FAKE_KEY)
  })
})

describe('validateBaseUrl — contract D6', () => {
  test('accepts https anywhere and http to loopback, normalising trailing slashes', () => {
    expect(validateBaseUrl('https://api.openai.com/v1/')).toEqual({ ok: true, baseUrl: 'https://api.openai.com/v1' })
    expect(validateBaseUrl('https://Proxy.Example.com:8443/v1//')).toEqual({ ok: true, baseUrl: 'https://proxy.example.com:8443/v1' })
    expect(validateBaseUrl('http://localhost:11434/v1')).toEqual({ ok: true, baseUrl: 'http://localhost:11434/v1' })
    expect(validateBaseUrl('http://127.0.0.1:20128/v1')).toEqual({ ok: true, baseUrl: 'http://127.0.0.1:20128/v1' })
    expect(validateBaseUrl('http://[::1]:8080/v1')).toEqual({ ok: true, baseUrl: 'http://[::1]:8080/v1' })
  })

  const refused: Array<[string, BaseUrlRefusal]> = [
    ['', 'empty'],
    ['not a url', 'unparseable'],
    ['http://api.example.com/v1', 'insecure-remote'],
    ['http://127.0.0.1.evil.example/v1', 'insecure-remote'],
    ['http://localhost.evil.example/v1', 'insecure-remote'],
    ['ftp://api.example.com/v1', 'scheme'],
    ['https://user:pw@api.example.com/v1', 'userinfo'],
    ['https://token@api.example.com/v1', 'userinfo'],
    ['https://api.example.com/v1?key=x', 'query-or-fragment'],
    ['https://api.example.com/v1#frag', 'query-or-fragment'],
  ]
  for (const [raw, reason] of refused) {
    test(`refuses ${reason}: ${raw === '' ? '(empty)' : raw}`, () => {
      expect(validateBaseUrl(raw)).toEqual({ ok: false, reason })
      expect(baseUrlSentence(reason)).not.toContain(raw === '' ? '\u0000' : raw)
    })
  }
})

describe('serializeEndpoint / parseStoredEndpoint', () => {
  const at = '2026-09-27T00:00:00.000Z'
  test('round-trips a keyed and a keyless (ollama) record', () => {
    expect(parseStoredEndpoint(serializeEndpoint('openrouter', 'https://openrouter.ai/api/v1', FAKE_EP_KEY, at), 'openrouter'))
      .toEqual({ ok: true, baseUrl: 'https://openrouter.ai/api/v1', key: FAKE_EP_KEY, storedAt: at })
    expect(parseStoredEndpoint(serializeEndpoint('ollama', 'http://localhost:11434/v1', null, at), 'ollama'))
      .toEqual({ ok: true, baseUrl: 'http://localhost:11434/v1', key: null, storedAt: at })
  })

  test('a record for another endpoint, or the Anthropic record, is wrong-provider', () => {
    const text = serializeEndpoint('openrouter', 'https://openrouter.ai/api/v1', FAKE_EP_KEY, at)
    expect(parseStoredEndpoint(text, 'openai')).toEqual({ ok: false, reason: 'wrong-provider' })
    expect(parseStoredEndpoint(serializeCredential('anthropic', FAKE_KEY, at), 'openai')).toEqual({ ok: false, reason: 'wrong-provider' })
  })

  test('a hand-edited record is re-validated: remote http, a null key where one is required, a bad key', () => {
    expect(parseStoredEndpoint(serializeEndpoint('openai', 'http://evil.example/v1', FAKE_EP_KEY, at), 'openai').ok).toBe(false)
    expect(parseStoredEndpoint(serializeEndpoint('openai', 'https://api.openai.com/v1', null, at), 'openai').ok).toBe(false)
    expect(parseStoredEndpoint(serializeEndpoint('openai', 'https://api.openai.com/v1', FAKE_KEY, at), 'openai').ok).toBe(false)
    expect(parseStoredEndpoint(serializeEndpoint('openai', 'https://api.openai.com/v1/', FAKE_EP_KEY, at), 'openai').ok).toBe(false)
  })
})

describe('createCredentialHandle — an endpoint handle names the PROTOCOL, never the vendor', () => {
  test('provider is openai-compatible; every stringification is the label, never the key', () => {
    const h = createCredentialHandle('openai', FAKE_EP_KEY)
    expect(h.provider).toBe('openai-compatible')
    for (const text of [JSON.stringify(h), String(h), `${h}`, inspect(h)]) {
      expect(text).toContain('openai-compatible/openai')
      expect(text).not.toContain(FAKE_EP_KEY)
    }
    expect(h.reveal()).toBe(FAKE_EP_KEY)
  })
})

// ── B5b.1-SEC G-2 — a key is only ever stored for the vendor whose host will receive it ─────────
//
// The endpoint list is read from the SAME tables the code uses (`KEYED_PROVIDERS` /
// `OPENAI_COMPATIBLE_ENDPOINTS`), so a new endpoint is covered by construction. Every value is built
// at runtime — nothing here is a real-looking literal.

import { KEYED_PROVIDERS, OPENAI_COMPATIBLE_ENDPOINTS } from '../config.ts'

/** A Google-shaped key: `AIza` + 35 characters = 39. */
const GOOGLE_SHAPED = 'AIza' + 'Sy' + 'g'.repeat(33)
/** The `sk-` family, each padded to 39 so the refusal is about the PREFIX, never the length. */
const SK_FAMILY = ['sk-ant-', 'sk-proj-', 'sk-or-', 'sk-'].map(prefix => prefix + 'k'.repeat(39 - prefix.length))

describe('validateKeyShape — Google (G-2): AIza + 39 characters, and never the sk- family', () => {
  test('the well-formed Google key is accepted', () => {
    expect(GOOGLE_SHAPED).toHaveLength(39)
    expect(validateKeyShape(GOOGLE_SHAPED, 'google')).toEqual({ ok: true })
  })

  for (const value of SK_FAMILY) {
    test(`refuses the sk- family (${value.slice(0, 8)}…) as foreign-prefix`, () => {
      expect(value).toHaveLength(39)
      expect(validateKeyShape(value, 'google')).toEqual({ ok: false, reason: 'foreign-prefix' })
    })
  }

  test('requires the AIza prefix', () => {
    expect(validateKeyShape('B' + GOOGLE_SHAPED.slice(1), 'google')).toEqual({ ok: false, reason: 'prefix' })
    expect(validateKeyShape('aiza' + GOOGLE_SHAPED.slice(4), 'google')).toEqual({ ok: false, reason: 'prefix' })
  })

  test('requires the total length to be exactly 39', () => {
    expect(validateKeyShape(GOOGLE_SHAPED.slice(0, 38), 'google')).toEqual({ ok: false, reason: 'too-short' })
    expect(validateKeyShape(GOOGLE_SHAPED + 'g', 'google')).toEqual({ ok: false, reason: 'too-long' })
  })
})

describe('validateKeyShape — every OTHER keyed provider refuses a Google key (G-2)', () => {
  const others = KEYED_PROVIDERS.filter(p => p !== 'google')

  test('the enumeration is not empty and covers every OpenAI-compatible endpoint', () => {
    expect(others.length).toBeGreaterThan(0)
    for (const endpoint of OPENAI_COMPATIBLE_ENDPOINTS) expect(others).toContain(endpoint)
  })

  for (const provider of KEYED_PROVIDERS.filter(p => p !== 'google')) {
    test(`${provider}: an AIza… key is refused`, () => {
      const result = validateKeyShape(GOOGLE_SHAPED, provider)
      expect(result.ok).toBe(false)
      // An endpoint answers `foreign-prefix`; Anthropic's own prefix rule already answers `prefix`.
      if (provider !== 'anthropic') expect(result).toEqual({ ok: false, reason: 'foreign-prefix' })
    })
  }
})

describe('keyShapeSentence — G-2 refusals speak in words and never echo a key', () => {
  const reasons: KeyShapeRefusal[] = ['prefix', 'foreign-prefix', 'too-short', 'too-long']
  const probes = [GOOGLE_SHAPED, ...SK_FAMILY]

  for (const provider of KEYED_PROVIDERS) {
    test(`${provider}: no sentence contains any probe key`, () => {
      for (const reason of reasons) {
        const sentence = keyShapeSentence(reason, provider)
        expect(sentence.length).toBeGreaterThan(0)
        for (const key of probes) expect(sentence).not.toContain(key)
      }
    })
  }

  test('the Google sentences name the real rule, not the Anthropic one', () => {
    expect(keyShapeSentence('prefix', 'google')).toContain('AIza')
    expect(keyShapeSentence('prefix', 'google')).not.toContain('sk-ant-')
    expect(keyShapeSentence('too-short', 'google')).toContain('39')
    expect(keyShapeSentence('too-long', 'google')).toContain('39')
    expect(keyShapeSentence('foreign-prefix', 'google')).toContain('never sent to Google')
  })

  test('a foreign-prefix sentence on an endpoint names both places the key can belong', () => {
    const s = keyShapeSentence('foreign-prefix', 'openai')
    expect(s).toContain('agentop provider key set anthropic')
    expect(s).toContain('agentop provider key set google')
  })
})
