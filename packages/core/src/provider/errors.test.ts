import { describe, expect, it, test } from 'bun:test'
import {
  classifyProviderError,
  pickClassifierInput,
  PROVIDER_ERROR_KINDS,
  type ClassifierInput,
  type ProviderError,
  type ProviderErrorKind,
} from './errors'

describe('classifyProviderError — the §4.3 status table, one row per line', () => {
  test.each([
    ['invalid-request · 400', { httpStatus: 400, errorType: 'invalid_request_error' }, {
      kind: 'invalid-request', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.request_invalid',
    }],
    ['authentication · 401', { httpStatus: 401, errorType: 'authentication_error' }, {
      kind: 'authentication', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.key_rejected',
    }],
    ['billing · 402', { httpStatus: 402, errorType: 'billing_error' }, {
      kind: 'billing', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.billing',
    }],
    ['permission · 403', { httpStatus: 403, errorType: 'permission_error' }, {
      kind: 'permission', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.forbidden',
    }],
    ['not-found · 404', { httpStatus: 404, errorType: 'not_found_error' }, {
      kind: 'not-found', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.not_found',
    }],
    ['conflict · 409 — NOT retryable in B1', { httpStatus: 409, errorType: 'conflict_error' }, {
      kind: 'conflict', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.conflict',
    }],
    ['request-too-large · 413', { httpStatus: 413, errorType: 'request_too_large' }, {
      kind: 'request-too-large', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.too_large',
    }],
    ['api-error · 500', { httpStatus: 500, errorType: 'api_error' }, {
      kind: 'api-error', retryable: true, usageOutcome: 'none-reported', userCode: 'provider.unavailable',
    }],
    ['provider-timeout · 504', { httpStatus: 504, errorType: 'timeout_error' }, {
      kind: 'provider-timeout', retryable: true, usageOutcome: 'none-reported', userCode: 'provider.timeout',
    }],
    ['overloaded · 529', { httpStatus: 529, errorType: 'overloaded_error' }, {
      kind: 'overloaded', retryable: true, usageOutcome: 'none-reported', userCode: 'provider.overloaded',
    }],
  ] satisfies [string, ClassifierInput, Partial<ProviderError>][])('%s', (_name, input, expected) => {
    expect(classifyProviderError(input)).toMatchObject(expected)
  })

  it('rate-limited · 429 WITH retry-after — honours it as retryAfterMs', () => {
    const result = classifyProviderError({ httpStatus: 429, errorType: 'rate_limit_error', retryAfterHeader: '2' })
    expect(result).toMatchObject({
      kind: 'rate-limited', retryable: true, usageOutcome: 'none-reported', userCode: 'provider.rate_limited',
      retryAfterMs: 2000,
    })
  })

  it('rate-limited · 429 WITHOUT retry-after — ASSUMPTION: still retryable via backoff (spec table only documents the WITH case)', () => {
    const result = classifyProviderError({ httpStatus: 429, errorType: 'rate_limit_error' })
    expect(result).toMatchObject({
      kind: 'rate-limited', retryable: true, usageOutcome: 'none-reported', userCode: 'provider.rate_limited',
    })
    expect(result.retryAfterMs).toBeUndefined()
  })

  it('a known status with NO error.type at all classifies by status alone (e.g. an HTML body from a proxy) — an assumption', () => {
    const result = classifyProviderError({ httpStatus: 500 })
    expect(result).toMatchObject({ kind: 'api-error', retryable: true, usageOutcome: 'none-reported' })
    expect(result.errorType).toBeUndefined()
  })
})

describe('spend-cap — decided by error_code, NEVER by status', () => {
  it('wins over rate-limited on 429', () => {
    const result = classifyProviderError({
      httpStatus: 429, errorType: 'rate_limit_error', errorCode: 'enforced_spend_limit_reached',
    })
    expect(result).toMatchObject({
      kind: 'spend-cap', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.spend_cap',
    })
  })

  it('wins over invalid-request on 400', () => {
    const result = classifyProviderError({
      httpStatus: 400, errorType: 'invalid_request_error', errorCode: 'enforced_spend_limit_reached',
    })
    expect(result).toMatchObject({ kind: 'spend-cap', retryable: false })
  })

  it('is never retryable even alongside a retry-after header — a cap is never worth retrying against', () => {
    const result = classifyProviderError({
      httpStatus: 429, errorType: 'rate_limit_error', errorCode: 'enforced_spend_limit_reached', retryAfterHeader: '5',
    })
    expect(result.retryable).toBe(false)
    expect(result.kind).toBe('spend-cap')
  })
})

describe('http-other — the closed union never throws away a status or an unrecognised type', () => {
  it('a known status with an UNKNOWN error.type becomes http-other, keeping the raw type', () => {
    const result = classifyProviderError({ httpStatus: 400, errorType: 'some_new_error_type' })
    expect(result).toMatchObject({ kind: 'http-other', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.error' })
    expect(result.errorType).toBe('some_new_error_type')
  })

  it('an entirely unlisted 5xx status is retryable', () => {
    const result = classifyProviderError({ httpStatus: 503 })
    expect(result).toMatchObject({ kind: 'http-other', retryable: true })
  })

  it('an entirely unlisted 4xx status is NOT retryable', () => {
    const result = classifyProviderError({ httpStatus: 418 })
    expect(result).toMatchObject({ kind: 'http-other', retryable: false })
  })

  it('a known status with an unrecognised error.type: 5xx unknown → retryable, 4xx unknown → not', () => {
    const serverSide = classifyProviderError({ httpStatus: 500, errorType: 'totally_unknown' })
    expect(serverSide.retryable).toBe(true)
    const clientSide = classifyProviderError({ httpStatus: 403, errorType: 'totally_unknown' })
    expect(clientSide.retryable).toBe(false)
  })
})

describe('network — retryable only when the request provably never left', () => {
  it('requestSent === false → retryable, usageOutcome none-reported (the attempt is known clean)', () => {
    const result = classifyProviderError({ transport: 'network', requestSent: false })
    expect(result).toMatchObject({ kind: 'network', retryable: true, usageOutcome: 'none-reported', userCode: 'provider.network' })
  })

  it('requestSent === true → NOT retryable, usageOutcome unknown (may have been billed)', () => {
    const result = classifyProviderError({ transport: 'network', requestSent: true })
    expect(result).toMatchObject({ kind: 'network', retryable: false, usageOutcome: 'unknown' })
  })

  it('requestSent undefined ("it may have") → NOT retryable, usageOutcome unknown', () => {
    const result = classifyProviderError({ transport: 'network' })
    expect(result).toMatchObject({ kind: 'network', retryable: false, usageOutcome: 'unknown' })
  })
})

describe('transport precedence — client-timeout and aborted', () => {
  it('client-timeout is never retryable in B1', () => {
    const result = classifyProviderError({ transport: 'client-timeout' })
    expect(result).toMatchObject({ kind: 'client-timeout', retryable: false, usageOutcome: 'unknown', userCode: 'provider.no_response' })
  })

  it('aborted is NEVER retryable, and outranks any HTTP facts also present', () => {
    const result = classifyProviderError({ transport: 'aborted', httpStatus: 500, errorType: 'api_error' })
    expect(result).toMatchObject({ kind: 'aborted', retryable: false, usageOutcome: 'unknown', userCode: 'provider.cancelled' })
  })
})

describe('sdk-rejected and response-unreadable — the residues with no HTTP classification', () => {
  it('sdkRejected with no httpStatus at all → sdk-rejected', () => {
    const result = classifyProviderError({ sdkRejected: true })
    expect(result).toMatchObject({ kind: 'sdk-rejected', retryable: false, usageOutcome: 'unknown', userCode: 'provider.error' })
  })

  it('sdkRejected WITH an httpStatus present is classified by the status instead', () => {
    const result = classifyProviderError({ sdkRejected: true, httpStatus: 401, errorType: 'authentication_error' })
    expect(result.kind).toBe('authentication')
  })

  it('a 2xx whose body cannot be read as a Message → response-unreadable', () => {
    const result = classifyProviderError({ responseUnreadable: true })
    expect(result).toMatchObject({ kind: 'response-unreadable', retryable: false, usageOutcome: 'unknown', userCode: 'provider.error' })
  })

  it('no facts observed at all → sdk-rejected, the honest residue', () => {
    const result = classifyProviderError({})
    expect(result).toMatchObject({ kind: 'sdk-rejected', retryable: false, usageOutcome: 'unknown', userCode: 'provider.error' })
  })
})

describe('retry-after parsing — seconds only, garbage and HTTP-dates ignored', () => {
  it('parses an integer-seconds header into ms', () => {
    expect(classifyProviderError({ httpStatus: 429, retryAfterHeader: '3' }).retryAfterMs).toBe(3000)
  })

  it('parses a decimal-seconds header into ms', () => {
    expect(classifyProviderError({ httpStatus: 429, retryAfterHeader: '1.5' }).retryAfterMs).toBe(1500)
  })

  it('ignores garbage', () => {
    expect(classifyProviderError({ httpStatus: 429, retryAfterHeader: 'not-a-number' }).retryAfterMs).toBeUndefined()
  })

  it('ignores the HTTP-date form (not covered by research; left unparsed rather than misread)', () => {
    expect(
      classifyProviderError({ httpStatus: 429, retryAfterHeader: 'Wed, 21 Oct 2026 07:28:00 GMT' }).retryAfterMs,
    ).toBeUndefined()
  })

  it('ignores a negative value', () => {
    expect(classifyProviderError({ httpStatus: 429, retryAfterHeader: '-5' }).retryAfterMs).toBeUndefined()
  })

  it('is carried on ANY kind when present, not only rate-limited', () => {
    // a network failure with a retry-after is an unusual combination, but the field is a general
    // enrichment — "a surface can say when to retry" — not something scoped to one kind.
    const result = classifyProviderError({ httpStatus: 500, errorType: 'api_error', retryAfterHeader: '10' })
    expect(result.retryAfterMs).toBe(10_000)
  })
})

describe('request identity — header wins, body used when absent, source recorded', () => {
  it('header present → requestId from the header, source "header"', () => {
    const result = classifyProviderError({ requestIdHeader: 'req_abc123' })
    expect(result).toMatchObject({ requestId: 'req_abc123', requestIdSource: 'header' })
  })

  it('header absent, body present → requestId from the body, source "body"', () => {
    const result = classifyProviderError({ requestIdBody: 'req_body456' })
    expect(result).toMatchObject({ requestId: 'req_body456', requestIdSource: 'body' })
  })

  it('both present → the header wins', () => {
    const result = classifyProviderError({ requestIdHeader: 'req_header', requestIdBody: 'req_body' })
    expect(result).toMatchObject({ requestId: 'req_header', requestIdSource: 'header' })
  })

  it('neither present → both fields absent, never synthesised', () => {
    const result = classifyProviderError({ httpStatus: 401, errorType: 'authentication_error' })
    expect(result.requestId).toBeUndefined()
    expect(result.requestIdSource).toBeUndefined()
  })
})

describe('pickClassifierInput — the allowlist made executable', () => {
  it('copies only the typed fields, each checked against its primitive type', () => {
    const picked = pickClassifierInput({
      httpStatus: 429,
      errorType: 'rate_limit_error',
      errorCode: 'enforced_spend_limit_reached',
      retryAfterHeader: '2',
      requestIdHeader: 'req_1',
      requestIdBody: 'req_2',
      transport: 'network',
      requestSent: false,
      sdkRejected: true,
      responseUnreadable: false,
    })
    expect(picked).toEqual({
      httpStatus: 429,
      errorType: 'rate_limit_error',
      errorCode: 'enforced_spend_limit_reached',
      retryAfterHeader: '2',
      requestIdHeader: 'req_1',
      requestIdBody: 'req_2',
      transport: 'network',
      requestSent: false,
      sdkRejected: true,
      responseUnreadable: false,
    })
  })

  it('drops everything not on the allowlist — headers, apiKey, message, the request body — from the result', () => {
    const dangerous = {
      httpStatus: 401,
      headers: { 'x-api-key': 'sk-ant-TEST-super-secret' },
      apiKey: 'sk-ant-TEST-another-secret',
      message: 'Invalid API key provided: sk-ant-TEST-leak',
      requestBody: { model: 'claude', prompt: 'do not leak this either' },
    }
    const picked = pickClassifierInput(dangerous)
    const serialized = JSON.stringify(picked)
    expect(serialized).not.toContain('sk-ant-TEST')
    expect(serialized).not.toContain('x-api-key')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('message')
    expect(serialized).not.toContain('requestBody')
    expect(picked).toEqual({ httpStatus: 401 })
  })

  it('rejects a field whose runtime value does not match its declared type', () => {
    const picked = pickClassifierInput({ httpStatus: '429', errorType: 42, transport: 'not-a-real-transport' })
    expect(picked).toEqual({})
  })

  it('the same allowlist enforcement holds end to end through classifyProviderError itself', () => {
    // A real caller might cast a wider SDK error object to ClassifierInput; `unknown` here
    // reproduces that widening without TypeScript flagging the excess properties at the call site.
    const wider: unknown = {
      httpStatus: 401,
      errorType: 'authentication_error',
      headers: { 'x-api-key': 'sk-ant-TEST-should-not-appear' },
      apiKey: 'sk-ant-TEST-should-not-appear-either',
    }
    const result = classifyProviderError(wider as ClassifierInput)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('sk-ant-TEST')
  })
})

describe('the classifier never throws, on any input however malformed', () => {
  const weirdInputs: unknown[] = [
    null,
    undefined,
    'a bare string',
    42,
    [],
    {},
    { httpStatus: Number.NaN },
    { httpStatus: 'not-a-number' },
    { transport: 'teleportation' },
    { httpStatus: -1 },
    { httpStatus: 999999 },
    { errorCode: null },
    { retryAfterHeader: null },
  ]

  for (const input of weirdInputs) {
    it(`does not throw on ${JSON.stringify(input)}`, () => {
      expect(() => classifyProviderError(input as ClassifierInput)).not.toThrow()
      const result = classifyProviderError(input as ClassifierInput)
      expect(typeof result.kind).toBe('string')
      expect(typeof result.retryable).toBe('boolean')
    })
  }
})

describe('PROVIDER_ERROR_KINDS — every kind in the closed union is reachable', () => {
  const reached = new Set<ProviderErrorKind>()
  reached.add(classifyProviderError({ httpStatus: 400, errorType: 'invalid_request_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 401, errorType: 'authentication_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 402, errorType: 'billing_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 403, errorType: 'permission_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 404, errorType: 'not_found_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 409, errorType: 'conflict_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 413, errorType: 'request_too_large' }).kind)
  reached.add(classifyProviderError({ httpStatus: 429, errorType: 'rate_limit_error' }).kind)
  reached.add(
    classifyProviderError({ httpStatus: 429, errorCode: 'enforced_spend_limit_reached' }).kind,
  )
  reached.add(classifyProviderError({ httpStatus: 500, errorType: 'api_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 504, errorType: 'timeout_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 529, errorType: 'overloaded_error' }).kind)
  reached.add(classifyProviderError({ httpStatus: 418 }).kind)
  reached.add(classifyProviderError({ transport: 'network' }).kind)
  reached.add(classifyProviderError({ transport: 'client-timeout' }).kind)
  reached.add(classifyProviderError({ transport: 'aborted' }).kind)
  reached.add(classifyProviderError({ sdkRejected: true }).kind)
  reached.add(classifyProviderError({ responseUnreadable: true }).kind)

  for (const kind of PROVIDER_ERROR_KINDS) {
    it(`"${kind}" is reachable by some input`, () => {
      expect(reached.has(kind)).toBe(true)
    })
  }

  it('PROVIDER_ERROR_KINDS has no duplicate and nothing extra beyond what was reached', () => {
    expect(new Set(PROVIDER_ERROR_KINDS).size).toBe(PROVIDER_ERROR_KINDS.length)
    expect(reached.size).toBe(PROVIDER_ERROR_KINDS.length)
  })
})

describe('no kind carries usage — a type-level guarantee', () => {
  it('ProviderError has no "usage" key at the type level', () => {
    // If `usage` were ever added to ProviderError, `'usage' extends keyof ProviderError` would be
    // `true` and this assignment would fail to type-check (a build-time failure, not a runtime one).
    type NoUsageField = 'usage' extends keyof ProviderError ? never : true
    const typeCheck: NoUsageField = true
    expect(typeCheck).toBe(true)
  })

  it('no kind carries a usage object at runtime either, over every reachable result', () => {
    const samples: ProviderError[] = [
      classifyProviderError({ httpStatus: 500, errorType: 'api_error' }),
      classifyProviderError({ transport: 'network', requestSent: false }),
      classifyProviderError({ transport: 'aborted' }),
      classifyProviderError({ sdkRejected: true }),
      classifyProviderError({ responseUnreadable: true }),
      classifyProviderError({}),
    ]
    for (const sample of samples) {
      expect('usage' in sample).toBe(false)
    }
  })
})
