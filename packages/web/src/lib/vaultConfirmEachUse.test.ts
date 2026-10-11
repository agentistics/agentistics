import { afterEach, describe, expect, test } from 'bun:test'
import { gateActionOf } from '../components/vault/VaultFlows'
import { decideVaultUse, setConfirmEachUse } from './vaultApi'
import { vt } from './vaultText'

const realFetch = globalThis.fetch
const calls: { url: string; body: unknown }[] = []
afterEach(() => { globalThis.fetch = realFetch; calls.length = 0; delete (globalThis as Record<string, unknown>).window })
function mockFetch(): void {
  globalThis.fetch = (async (url: string, init?: { body?: string }) => { calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined }); return new Response(JSON.stringify({ ok: true }), { status: 200 }) }) as unknown as typeof fetch
}

describe('confirm each use — web', () => {
  test('the setting posts to its own route with the code, and names its gate action', async () => {
    mockFetch()
    expect((await setConfirmEachUse(true, '123456')).ok).toBe(true)
    expect(calls[0]).toEqual({ url: '/api/vault/confirm-each-use', body: { enabled: true, code: '123456' } })
    expect(gateActionOf('confirm-each-use')).toBe('set-confirm-each-use')
  })
  test('texts exist in both languages', () => {
    for (const k of ['cfu_title', 'cfu_d'] as const) { expect(vt(k, 'pt').length).toBeGreaterThan(5); expect(vt(k, 'en')).not.toBe(vt(k, 'pt')) }
  })
  test('deny posts at once with no gesture; approve here posts too (the service raises the gesture)', async () => {
    mockFetch()
    ;(globalThis as Record<string, unknown>).window = { location: { hostname: 'localhost' } }
    await decideVaultUse('use-1', false)
    await decideVaultUse('use-1', true)
    expect(calls.map(c => c.url)).toEqual(['/api/vault/personal/use/use-1/deny', '/api/vault/personal/use/use-1/approve'])
  })
  test('from a phone, approve asks the passkey first and carries its token; deny still asks nothing', async () => {
    mockFetch()
    ;(globalThis as Record<string, unknown>).window = { location: { hostname: 'box.tail1234.ts.net' } }
    const asked: string[][] = []
    const phone = async (a: string, t: string) => { asked.push([a, t]); return { ok: true as const, gestureToken: 'tok', status: 200 } as never }
    await decideVaultUse('use-2', false, phone)
    expect(asked).toEqual([])
    await decideVaultUse('use-2', true, phone)
    expect(asked).toEqual([['use-approve', 'use-2']])
    expect(calls[1]).toEqual({ url: '/api/vault/personal/use/use-2/approve', body: { gestureToken: 'tok' } })
    // a cancelled passkey sends nothing
    calls.length = 0
    expect((await decideVaultUse('use-3', true)).ok).toBe(false)
    expect(calls).toEqual([])
  })
})
