import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { answerAwayDigest, readDigestLine } from './awayDigest'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('away digest bell action', () => {
  test('posts the answer payload and returns the Nay conversation', async () => {
    let request: RequestInit | undefined
    globalThis.fetch = (async (_url, init) => { request = init; return new Response(JSON.stringify({ conversationId: 'nay-42' }), { status: 200 }) }) as typeof fetch
    await expect(answerAwayDigest('yes', 20, '2026-01-01T00:00:00.000Z', 'pt')).resolves.toEqual({ ok: true, status: 200, conversationId: 'nay-42' })
    expect(request?.method).toBe('POST')
    expect(JSON.parse(String(request?.body))).toEqual({ answer: 'yes', bucket: 20, since: '2026-01-01T00:00:00.000Z', lang: 'pt' })
  })

  test('returns stale status and never lets the response body override HTTP failure', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 409 })) as unknown as typeof fetch
    expect(await answerAwayDigest('yes', 20, 'old-window', 'en')).toMatchObject({ ok: false, status: 409 })
  })

  test('bell renders both buttons, disables them while pending, and opens the returned session', () => {
    const source = readFileSync(new URL('../components/NotificationBell.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Sim, abrir resumo')
    expect(source).toContain('Não agora')
    expect(source).toContain('busy={digestBusy}')
    expect(source).toContain('navigate(`/sessions/${encodeURIComponent(body.conversationId)}`)')
  })
})

describe('away digest streamed steps', () => {
  test('readDigestLine reports phases, ignores junk and returns the final answer', () => {
    const seen: string[] = []
    expect(readDigestLine('{"phase":"collect"}', p => seen.push(p))).toBeNull()
    expect(readDigestLine('', p => seen.push(p))).toBeNull()
    expect(readDigestLine('not json', p => seen.push(p))).toBeNull()
    expect(readDigestLine('{"phase":"bogus"}', p => seen.push(p))).toBeNull()
    expect(readDigestLine('{"done":true,"result":{"ok":true,"conversationId":"nay-1"},"answerStarted":true}', p => seen.push(p)))
      .toEqual({ ok: true, status: 200, conversationId: 'nay-1', answerStarted: true })
    expect(readDigestLine('{"done":true,"result":{"ok":false,"error":"stale"}}', () => {})).toEqual({ ok: false, status: 409, conversationId: undefined })
    expect(seen).toEqual(['collect'])
  })

  test('with onPhase it asks for NDJSON and resolves only on the last line, chunk boundaries included', async () => {
    let accept: string | undefined
    const chunks = ['{"phase":"collect"}\n{"pha', 'se":"prepare"}\n{"phase":"send"}\n', '\n{"phase":"writing"}\n', '{"done":true,"result":{"ok":true,"conversationId":"nay-9"},"answerStarted":true}']
    globalThis.fetch = (async (_url, init) => {
      accept = (init?.headers as Record<string, string>)?.Accept
      const enc = new TextEncoder()
      const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close() } })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
    }) as typeof fetch
    const phases: string[] = []
    const out = await answerAwayDigest('yes', 20, 's', 'pt', p => phases.push(p))
    expect(accept).toBe('application/x-ndjson')
    expect(phases).toEqual(['collect', 'prepare', 'send', 'writing'])
    expect(out).toEqual({ ok: true, status: 200, conversationId: 'nay-9', answerStarted: true })
  })

  test('a stream cut before its last line is a failure, not a success', async () => {
    globalThis.fetch = (async () => new Response('{"phase":"collect"}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })) as unknown as typeof fetch
    expect(await answerAwayDigest('yes', 20, 's', 'en', () => {})).toEqual({ ok: false, status: 502 })
  })
})

describe('away digest offer sentence', () => {
  test('names the configured delay, and the old default for an offer saved before the setting', async () => {
    const { resolveNotification } = await import('./notifications')
    const base = { id: 'x', ts: 0, type: 'info' as const, code: 'away.digest_offer', read: false }
    expect(resolveNotification({ ...base, meta: { after: '2 h' } } as never, 'pt').message).toContain('mais de 2 h')
    expect(resolveNotification({ ...base, meta: { bucket: 20 } } as never, 'en').message).toContain('more than 5 h')
  })
})
