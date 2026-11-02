import { describe, expect, test } from 'bun:test'
import { fetchJsonWithTimeout, acceptPayload, dataUrl, livenessStep, bootSlowLine, bootWatchdog, classifyLoadError, holdLoadError, loadErrorText, partialPollMs, POST_UPDATE_GRACE_MS, retryDelayMs, startupStripText, SLOW_AFTER_MS, UNREACHABLE_AFTER_MS } from './startupLoad'

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

test('an unanswered first start explains history reading after updates in both languages', () => {
  expect(loadErrorText({ kind: 'unreachable', detail: '' }, 'pt', 'host').body).toContain('primeira abertura lê todo o histórico e pode levar alguns minutos')
  expect(loadErrorText({ kind: 'unreachable', detail: '' }, 'en', 'host').body).toContain('first start reads your whole history and can take a few minutes')
})

// UPDATE.FIM (2026-10-24): after every in-app update the boot of the new bundle landed on the server's
// first build, one probe missed its 4 s deadline, and "Não foi possível falar com o agentistics" +
// "Tentar novamente" appeared as the finale ended — over a server that was up and starting.
describe('the boot right after an update', () => {
  test('a missed probe is "still starting", never unreachable, inside the grace', () => {
    expect(bootWatchdog(UNREACHABLE_AFTER_MS + 2000, 'down', 4000)).toBe('slow')
    expect(bootWatchdog(UNREACHABLE_AFTER_MS + 2000, 'down', POST_UPDATE_GRACE_MS - 1)).toBe('slow')
  })
  test('past the grace, and on an ordinary boot, an unanswered server is reported as before', () => {
    expect(bootWatchdog(UNREACHABLE_AFTER_MS, 'down', POST_UPDATE_GRACE_MS)).toBe('unreachable')
    expect(bootWatchdog(UNREACHABLE_AFTER_MS, 'down', null)).toBe('unreachable')
    expect(bootWatchdog(UNREACHABLE_AFTER_MS, 'down')).toBe('unreachable')
  })
  test('a failed first load keeps the loader only for what a starting server looks like', () => {
    const since = 6000
    expect(holdLoadError({ kind: 'unreachable', detail: 'Failed to fetch' }, since)).toBe(true)
    expect(holdLoadError({ kind: 'timeout', detail: 'aborted' }, since)).toBe(true)
    expect(holdLoadError({ kind: 'server', status: 503, detail: 'HTTP 503' }, since)).toBe(true)
    expect(holdLoadError({ kind: 'server', status: 401, detail: 'HTTP 401' }, since)).toBe(false)
    expect(holdLoadError({ kind: 'server', status: 404, detail: 'HTTP 404' }, since)).toBe(false)
    expect(holdLoadError({ kind: 'incompatible', detail: 'x' }, since)).toBe(false)
    expect(holdLoadError({ kind: 'unreachable', detail: 'x' }, null)).toBe(false)
    expect(holdLoadError({ kind: 'unreachable', detail: 'x' }, POST_UPDATE_GRACE_MS)).toBe(false)
  })
  test('the slow line says why, in both languages, and is unchanged otherwise', () => {
    expect(bootSlowLine('pt', 5000)).toContain('acabou de reiniciar')
    expect(bootSlowLine('en', 5000)).toContain('just restarted')
    expect(bootSlowLine('pt', null)).toBe('Ainda carregando — o servidor está respondendo.')
    expect(bootSlowLine('en', null)).toBe('Still loading — the server is answering.')
  })
})

describe('fetchJsonWithTimeout — the deadline covers the body', () => {
  const realFetch = globalThis.fetch
  const restore = () => { globalThis.fetch = realFetch }

  // A response whose headers arrive at once and whose body never does (a server restarting mid-answer).
  const stalledBody = (signal: AbortSignal | null | undefined) => ({
    ok: true, status: 200, headers: new Headers(),
    json: () => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  }) as unknown as Response

  test('a body that never arrives times out instead of hanging the boot', async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => stalledBody(init?.signal)) as typeof fetch
    try {
      const err = await fetchJsonWithTimeout('/api/data', 30).catch(e => e)
      expect(classifyLoadError(err).kind).toBe('timeout')
    } finally { restore() }
  })

  test('server unreachable, then ready: the next ask succeeds', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      if (++calls === 1) throw new TypeError('Failed to fetch')
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: 1 }) } as unknown as Response
    }) as unknown as typeof fetch
    try {
      const first = await fetchJsonWithTimeout('/api/data', 100).catch(e => e)
      expect(classifyLoadError(first).kind).toBe('unreachable')
      const second = await fetchJsonWithTimeout<{ ok: number }>('/api/data', 100)
      expect(second.ok && second.json?.ok).toBe(1)
    } finally { restore() }
  })

  test('an HTML body (old bundle behind a proxy page) is reported, not thrown', async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('Unexpected token <') } }) as unknown as Response) as unknown as typeof fetch
    try {
      const r = await fetchJsonWithTimeout('/api/data', 100)
      expect(classifyLoadError(r.parseError).kind).toBe('incompatible')
    } finally { restore() }
  })
})

describe('an update with the server out for a few seconds renders no error', () => {
  const kinds = [
    { kind: 'unreachable', detail: 'Failed to fetch' }, { kind: 'timeout', detail: 'aborted' },
    { kind: 'server', status: 503, detail: 'HTTP 503' }, { kind: 'unreachable', status: 502, detail: 'HTTP 502' },
  ] as const
  test('every failure of a restarting server is held as the loader, for minutes', () => {
    for (const since of [0, 5_000, 60_000, 200_000]) {
      for (const e of kinds) expect(holdLoadError({ ...e }, since)).toBe(true)
      // the watchdog never turns the boot into the "can't reach / try again" screen in that window
      expect(bootWatchdog(UNREACHABLE_AFTER_MS + 30_000, 'down', since)).not.toBe('unreachable')
    }
  })
  test('a real, prolonged outage is still reported once the grace is spent', () => {
    expect(holdLoadError({ kind: 'unreachable', detail: 'x' }, POST_UPDATE_GRACE_MS + 1)).toBe(false)
    expect(bootWatchdog(UNREACHABLE_AFTER_MS, 'down', POST_UPDATE_GRACE_MS + 1)).toBe('unreachable')
  })
  test('the first /api/version ask is retried quietly until the server answers, so the route is restored', async () => {
    const { firstVersionRetryMs } = await import('./updateToast')
    expect([0, 1, 2, 10].map(firstVersionRetryMs)).toEqual([1000, 2000, 3000, 5000])
  })
})
