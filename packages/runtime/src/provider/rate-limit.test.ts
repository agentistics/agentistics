import { describe, expect, test } from 'bun:test'
import { parseGoDurationMs, readRateLimit } from './rate-limit.ts'

const NOW = new Date('2026-09-28T14:00:00.000Z')

describe('readRateLimit — Anthropic (RFC 3339 reset instants)', () => {
  // Header names from https://platform.claude.com/docs/en/api/rate-limits § "Response headers".
  const documented = {
    'retry-after': '56',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-requests-remaining': '49',
    'anthropic-ratelimit-requests-reset': '2026-09-28T14:01:00Z',
    'anthropic-ratelimit-tokens-limit': '40000',
    'anthropic-ratelimit-tokens-remaining': '39000',
    'anthropic-ratelimit-tokens-reset': '2026-09-28T14:00:30.5-03:00',
    'anthropic-ratelimit-input-tokens-limit': '30000',
    'anthropic-ratelimit-input-tokens-remaining': '30000',
    'anthropic-ratelimit-input-tokens-reset': '2026-09-28T14:00:12Z',
    'anthropic-ratelimit-output-tokens-limit': '8000',
    'anthropic-ratelimit-output-tokens-remaining': '8000',
    'anthropic-ratelimit-output-tokens-reset': '2026-09-28T14:00:01Z',
    'request-id': 'req_x',
  }

  test('reads every documented resource, in a fixed order, as instants', () => {
    const r = readRateLimit('anthropic', documented, NOW)
    expect(r).toEqual({
      source: 'headers',
      resources: [
        { kind: 'requests', limit: 50, remaining: 49, resetsAt: '2026-09-28T14:01:00.000Z' },
        { kind: 'tokens', limit: 40000, remaining: 39000, resetsAt: '2026-09-28T17:00:30.500Z' },
        { kind: 'input-tokens', limit: 30000, remaining: 30000, resetsAt: '2026-09-28T14:00:12.000Z' },
        { kind: 'output-tokens', limit: 8000, remaining: 8000, resetsAt: '2026-09-28T14:00:01.000Z' },
      ],
      retryAfterMs: 56_000,
      dropped: 0,
    })
  })

  test('the result does not depend on the order the headers arrived in', () => {
    const reversed = Object.fromEntries(Object.entries(documented).reverse())
    expect(readRateLimit('anthropic', reversed, NOW)).toEqual(readRateLimit('anthropic', documented, NOW))
  })

  test('the reset instant does not depend on `now`', () => {
    const later = readRateLimit('anthropic', documented, new Date('2030-01-01T00:00:00Z'))
    expect(later).toEqual(readRateLimit('anthropic', documented, NOW))
  })

  test('a malformed value is dropped and counted — never read as 0', () => {
    const r = readRateLimit('anthropic', {
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': 'lots',
      'anthropic-ratelimit-requests-reset': '2026-09-28 14:01', // no T, no offset: not RFC 3339
      'anthropic-ratelimit-tokens-remaining': '-5',
    }, NOW)
    expect(r).toEqual({ source: 'headers', resources: [{ kind: 'requests', limit: 50 }], dropped: 3 })
  })

  test('only one field stated leaves the others ABSENT, not zero', () => {
    const r = readRateLimit('anthropic', { 'anthropic-ratelimit-tokens-remaining': '12000' }, NOW)
    expect(r).toEqual({ source: 'headers', resources: [{ kind: 'tokens', remaining: 12000 }], dropped: 0 })
    if ('resources' in r) expect('limit' in r.resources[0]!).toBe(false)
  })

  test('names are matched case-insensitively', () => {
    const r = readRateLimit('anthropic', { 'Anthropic-RateLimit-Requests-Limit': '7' }, NOW)
    expect(r).toEqual({ source: 'headers', resources: [{ kind: 'requests', limit: 7 }], dropped: 0 })
  })

  test('no rate-limit header at all → absent: no-headers', () => {
    expect(readRateLimit('anthropic', { 'request-id': 'req_x', date: 'x' }, NOW)).toEqual({ absent: 'no-headers', dropped: 0 })
  })

  test('headers present and none parse → absent: unparseable, with the count', () => {
    const r = readRateLimit('anthropic', {
      'anthropic-ratelimit-requests-limit': 'n/a',
      'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT', // HTTP-date: documented by neither vendor
    }, NOW)
    expect(r).toEqual({ absent: 'unparseable', dropped: 2 })
  })

  test('an unknown anthropic-ratelimit-* resource is ignored, not counted as dropped', () => {
    const r = readRateLimit('anthropic', { 'anthropic-ratelimit-widgets-limit': '3' }, NOW)
    expect(r).toEqual({ absent: 'no-headers', dropped: 0 })
  })

  test('the OpenAI header family is not read for anthropic', () => {
    expect(readRateLimit('anthropic', { 'x-ratelimit-limit-requests': '60' }, NOW)).toEqual({ absent: 'no-headers', dropped: 0 })
  })
})

describe('readRateLimit — OpenAI / OpenAI-compatible (durations relative to the response)', () => {
  // The documented sample row of https://developers.openai.com/api/docs/guides/rate-limits.
  const documented = {
    'retry-after': '56',
    'x-ratelimit-limit-requests': '60',
    'x-ratelimit-limit-tokens': '150000',
    'x-ratelimit-remaining-requests': '59',
    'x-ratelimit-remaining-tokens': '149984',
    'x-ratelimit-reset-requests': '1s',
    'x-ratelimit-reset-tokens': '6m0s',
    'x-ratelimit-limit-project-tokens': '60000',
    'x-ratelimit-remaining-project-tokens': '57000',
    'x-ratelimit-reset-project-tokens': '3s',
  }

  for (const provider of ['openai', 'openai-compatible'] as const) {
    test(`${provider}: the documented sample reads exactly`, () => {
      expect(readRateLimit(provider, documented, NOW)).toEqual({
        source: 'headers',
        resources: [
          { kind: 'requests', limit: 60, remaining: 59, resetsAt: '2026-09-28T14:00:01.000Z' },
          { kind: 'tokens', limit: 150000, remaining: 149984, resetsAt: '2026-09-28T14:06:00.000Z' },
          { kind: 'project-tokens', limit: 60000, remaining: 57000, resetsAt: '2026-09-28T14:00:03.000Z' },
        ],
        retryAfterMs: 56_000,
        dropped: 0,
      })
    })
  }

  test('a router writing the SAME name in another format is dropped, not reinterpreted', () => {
    const r = readRateLimit('openai-compatible', {
      'x-ratelimit-limit-requests': '20',
      'x-ratelimit-reset-requests': '1759068000000', // an epoch, not a duration
      'x-ratelimit-reset': '1759068000000', // OpenRouter's un-suffixed name: not an OpenAI header at all
    }, NOW)
    expect(r).toEqual({ source: 'headers', resources: [{ kind: 'requests', limit: 20 }], dropped: 1 })
  })

  test('absent headers → absent: no-headers', () => {
    expect(readRateLimit('openai-compatible', {}, NOW)).toEqual({ absent: 'no-headers', dropped: 0 })
  })

  test('retry-after alone is still a reading', () => {
    expect(readRateLimit('openai', { 'retry-after': '0.5' }, NOW)).toEqual({
      source: 'headers', resources: [], retryAfterMs: 500, dropped: 0,
    })
  })
})

describe('readRateLimit — providers with no documented format', () => {
  test('google documents no rate-limit header → absent: not-documented, whatever the headers say', () => {
    expect(readRateLimit('google', { 'x-ratelimit-limit-requests': '60' }, NOW)).toEqual({ absent: 'not-documented', dropped: 0 })
  })
  test('an unknown provider is not guessed at', () => {
    expect(readRateLimit('other', { 'x-ratelimit-limit-requests': '60' }, NOW)).toEqual({ absent: 'unknown-format', dropped: 0 })
    expect(readRateLimit('moonshot', { 'x-ratelimit-limit-requests': '60' }, NOW)).toEqual({ absent: 'unknown-format', dropped: 0 })
  })
})

describe('parseGoDurationMs — the grammar of OpenAI\'s documented samples', () => {
  const cases: Array<[string, number]> = [
    ['1s', 1000],
    ['6m0s', 360_000],
    ['3s', 3000],
    ['20ms', 20],
    ['0.5s', 500],
    ['.5s', 500],
    ['1h2m3.5s', 3_723_500],
    ['2m59.56s', 179_560],
    ['1m30ms', 60_030], // `ms` must win over `m` followed by `s`
    ['0s', 0],
    ['1500us', 1.5],
    ['1500µs', 1.5],
    ['2000000ns', 2],
    [' 1s ', 1000],
  ]
  for (const [text, ms] of cases) {
    test(`"${text}" → ${ms} ms`, () => {
      expect(parseGoDurationMs(text)).toBeCloseTo(ms, 9)
    })
  }

  for (const bad of ['', '56', 's', '1', '-1s', '+1s', '1 s', '1s 2m', '1d', '1.s', '1S', 'abc', '1s!']) {
    test(`"${bad}" is refused`, () => {
      expect(parseGoDurationMs(bad)).toBeUndefined()
    })
  }
})
