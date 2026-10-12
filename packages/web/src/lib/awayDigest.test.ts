import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { answerAwayDigest } from './awayDigest'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('away digest bell action', () => {
  test('posts the answer payload and returns the Nay conversation', async () => {
    let request: RequestInit | undefined
    globalThis.fetch = (async (_url, init) => { request = init; return new Response(JSON.stringify({ conversationId: 'nay-42' }), { status: 200 }) }) as typeof fetch
    await expect(answerAwayDigest('yes', 20, 'pt')).resolves.toEqual({ ok: true, conversationId: 'nay-42' })
    expect(request?.method).toBe('POST')
    expect(JSON.parse(String(request?.body))).toEqual({ answer: 'yes', bucket: 20, lang: 'pt' })
  })

  test('bell renders both buttons, disables them while pending, and opens the returned session', () => {
    const source = readFileSync(new URL('../components/NotificationBell.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Sim, abrir resumo')
    expect(source).toContain('Não agora')
    expect(source).toContain('disabled={digestBusy}')
    expect(source).toContain('navigate(`/sessions/${encodeURIComponent(body.conversationId)}`)')
  })
})
