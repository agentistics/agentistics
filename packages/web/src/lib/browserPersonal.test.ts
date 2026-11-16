import { describe, expect, test } from 'bun:test'
import { normalizeAddress, personalAct, personalBrowserOf, personalFailure } from './browserPersonal'

describe('personalBrowserOf', () => {
  test('finds the personal browser, ignores sessions', () => {
    const status = { live: [
      { owner: { kind: 'session', managedId: 'm1' }, phase: 'ready', tabs: [] },
      { owner: { kind: 'personal' }, phase: 'ready', tabs: [{ targetId: 'T', url: 'https://a.b', title: 'a', active: true }] },
    ] }
    expect(personalBrowserOf(status)?.tabs.length).toBe(1)
  })
  test('none when absent, stopping or malformed', () => {
    expect(personalBrowserOf({ live: [{ owner: { kind: 'session', managedId: 'm1' }, phase: 'ready', tabs: [] }] })).toBeNull()
    expect(personalBrowserOf({ live: [{ owner: { kind: 'personal' }, phase: 'stopping', tabs: [] }] })).toBeNull()
    expect(personalBrowserOf(null)).toBeNull()
    expect(personalBrowserOf({ live: 3 })).toBeNull()
  })
})

describe('normalizeAddress', () => {
  const ok = (t: string) => { const r = normalizeAddress(t, true); return r.ok ? r.url : null }
  test('a host-looking text gets https', () => { expect(ok('exemplo.com/docs')).toBe('https://exemplo.com/docs') })
  test('loopback gets http, with or without a port', () => {
    expect(ok('localhost:5173')).toBe('http://localhost:5173')
    expect(ok('127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(ok('localhost')).toBe('http://localhost')
  })
  test('a scheme is kept as typed — the server refuses the dangerous ones in its own words', () => {
    expect(ok('https://a.b/c')).toBe('https://a.b/c')
    expect(ok('file:///etc/passwd')).toBe('file:///etc/passwd')
  })
  test('host:port is not mistaken for a scheme', () => { expect(ok('exemplo.com:8080/a')).toBe('https://exemplo.com:8080/a') })
  test('not an address → a sentence, never a guessed search', () => {
    expect(normalizeAddress('   ', true)).toEqual({ ok: false, sentence: 'Digite um endereço.' })
    const r = normalizeAddress('como fazer bolo', false)
    expect(r.ok).toBe(false)
  })
})

describe('personalFailure — a known server code reads in the interface language (F5)', () => {
  const body = (error: string, extra: Record<string, unknown> = {}) => ({ ok: false, error, sentence: `EN ${error}`, ...extra })
  test('blocked by reason, a session caller, an unidentified caller, the switch off: pt sentences; en keeps the server\'s', () => {
    expect(personalFailure(200, body('blocked', { reason: 'scheme' }), true)).toMatch(/^Recusado/)
    expect(personalFailure(200, body('blocked', { reason: 'agentistics-port' }), true)).toMatch(/^Recusado/)
    expect(personalFailure(200, body('blocked', { reason: 'debug-port' }), true)).toMatch(/^Recusado/)
    expect(personalFailure(200, body('blocked', { reason: 'parse' }), true)).toMatch(/^Recusado/)
    expect(personalFailure(403, body('session_cannot_drive_personal'), true)).toContain('pessoa')
    expect(personalFailure(403, body('caller_unidentified'), true)).toContain('pessoa')
    expect(personalFailure(403, body('browser_disabled'), true)).toContain('desligado')
    expect(personalFailure(200, body('blocked', { reason: 'scheme' }), false)).toBe('EN blocked')
    expect(personalFailure(200, body('something_new'), true)).toBe('EN something_new')
  })
})

describe('personalAct', () => {
  test('posts to the personal route and is ok on a 200', async () => {
    const seen: Array<[string, unknown]> = []
    const r = await personalAct('navigate', { url: 'https://a.b' }, true, async (u, b) => { seen.push([u, b]); return { status: 200, body: { ok: true } } })
    expect(r).toEqual({ ok: true })
    expect(seen).toEqual([['/api/browser/personal/navigate', { url: 'https://a.b' }]])
  })
  test('a 200 {ok:false} (a blocked URL) is a refusal with the server sentence', async () => {
    const r = await personalAct('navigate', { url: 'file:///x' }, true, async () => ({ status: 200, body: { ok: false, sentence: 'Blocked.' } }))
    expect(r).toEqual({ ok: false, sentence: 'Blocked.' })
  })
  test('a 403 without a sentence says the browser is unavailable; a thrown fetch says the server did not answer', async () => {
    expect(personalFailure(403, null, true)).toContain('não está disponível')
    const r = await personalAct('reload', {}, false, async () => { throw new Error('x') })
    expect(r).toEqual({ ok: false, sentence: 'The server did not answer.' })
  })
})
