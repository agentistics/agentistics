import { describe, expect, test } from 'bun:test'
import { acceptPayload, dataUrl, takeEarlySlim, livenessStep, bootWatchdog, classifyLoadError, loadErrorText, partialPollMs, retryDelayMs, startupStripText, SLOW_AFTER_MS, UNREACHABLE_AFTER_MS } from './startupLoad'

describe('classifyLoadError', () => {
  test('a status is a server error and keeps the HTTP detail the auth gates read', () => {
    expect(classifyLoadError(null, 401)).toEqual({ kind: 'server', status: 401, detail: 'HTTP 401' })
    expect(classifyLoadError(null, 500).kind).toBe('server')
  })
  test('a gateway that cannot reach the server reads as unreachable', () => {
    expect(classifyLoadError(null, 502).kind).toBe('unreachable')
    expect(classifyLoadError(null, 504).kind).toBe('unreachable')
  })
  test('an abort is a timeout; a TypeError from fetch is unreachable; a parse error is incompatible', () => {
    expect(classifyLoadError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind).toBe('timeout')
    expect(classifyLoadError(new TypeError('Failed to fetch')).kind).toBe('unreachable')
    expect(classifyLoadError(new TypeError('Load failed')).kind).toBe('unreachable')
    expect(classifyLoadError(new SyntaxError('Unexpected token <')).kind).toBe('incompatible')
  })
})

describe('pacing', () => {
  test('a partial answer is asked again quickly at first, then every five seconds', () => {
    expect(partialPollMs(0)).toBe(1000)
    expect(partialPollMs(100)).toBe(5000)
  })
  test('a failed first load backs off and is capped', () => {
    expect([0, 1, 2, 3, 10].map(retryDelayMs)).toEqual([2000, 4000, 8000, 15000, 15000])
  })
})

describe('bootWatchdog — the boot screen never spins without a word', () => {
  test('plain loading at first, then slow while the server answers — never "broken" when it is up', () => {
    expect(bootWatchdog(1000, 'unknown')).toBe('loading')
    expect(bootWatchdog(SLOW_AFTER_MS, 'ok')).toBe('slow')
    expect(bootWatchdog(60_000, 'ok')).toBe('slow')
  })
  test('a server that stops answering is reported as unreachable', () => {
    expect(bootWatchdog(UNREACHABLE_AFTER_MS - 1, 'down')).toBe('slow')
    expect(bootWatchdog(UNREACHABLE_AFTER_MS, 'down')).toBe('unreachable')
  })
})

describe('acceptPayload', () => {
  test('the quick subset never replaces a full payload already on screen', () => {
    expect(acceptPayload({}, { partial: true, partialReason: 'quick' })).toBe(false)
    expect(acceptPayload({}, { partial: true, partialReason: 'snapshot' })).toBe(true)
    expect(acceptPayload({ partial: true }, { partial: true, partialReason: 'quick' })).toBe(true)
    expect(acceptPayload(null, { partial: true, partialReason: 'quick' })).toBe(true)
    expect(acceptPayload(null, { partial: true, partialReason: 'slim' })).toBe(true)
    expect(acceptPayload({}, { partial: true, partialReason: 'slim' })).toBe(false)
    expect(acceptPayload({ partial: true }, { partial: true, partialReason: 'slim' })).toBe(true)
    expect(acceptPayload({ partial: true }, {})).toBe(true)
  })
})

describe('startup strip', () => {
  test('says what is still arriving, with the scan percentage when known', () => {
    expect(startupStripText({ partial: true, partialReason: 'quick', projects: 0.42 }, 'en')).toContain('42%')
    expect(startupStripText({ partial: true, partialReason: 'snapshot' }, 'pt')).toContain('última vez')
    expect(startupStripText({ partial: false, deferredRepos: 3 }, 'en')).toContain('3 repositories')
    expect(startupStripText({ partial: false }, 'en')).toBeNull()
  })
  test('every failure has words a non-technical person can act on, in both languages', () => {
    for (const kind of ['unreachable', 'timeout', 'server', 'incompatible'] as const) {
      for (const lang of ['en', 'pt'] as const) {
        const t = loadErrorText({ kind, detail: 'HTTP 500' }, lang, 'host:1')
        expect(t.title.length).toBeGreaterThan(10)
        expect(t.body).not.toMatch(/bun run|server\.ts/)
      }
    }
  })
})

describe('livenessStep', () => {
  test('a failed probe marks the server down once, then stays quiet', () => {
    expect(livenessStep(false, false)).toBe('mark-offline')
    expect(livenessStep(true, false)).toBe('none')
  })
  test('an answer after being down means recover now; an answer while up changes nothing', () => {
    expect(livenessStep(true, true)).toBe('recover')
    expect(livenessStep(false, true)).toBe('none')
  })
})

describe('dataUrl', () => {
  test('the first load asks for the slim payload, later ones for the full build', () => {
    expect(dataUrl(false)).toBe('/api/data?partial=1&slim=1')
    expect(dataUrl(true)).toBe('/api/data?partial=1')
  })
})

describe('takeEarlySlim', () => {
  const w = globalThis as { __agEarlySlim?: Promise<Response | null> }
  test('is null when nothing was started', async () => {
    w.__agEarlySlim = undefined
    expect(await takeEarlySlim(50)).toBeNull()
  })
  test('hands out the started request once', async () => {
    const r = new Response('{}')
    w.__agEarlySlim = Promise.resolve(r)
    expect(await takeEarlySlim(50)).toBe(r)
    expect(await takeEarlySlim(50)).toBeNull()
  })
  test('a request that is too late is dropped, and a failed one is null', async () => {
    w.__agEarlySlim = new Promise(() => {})
    expect(await takeEarlySlim(20)).toBeNull()
    w.__agEarlySlim = Promise.resolve(null)
    expect(await takeEarlySlim(20)).toBeNull()
  })
})
