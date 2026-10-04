import { describe, expect, test } from 'bun:test'
import { handleMemoryRequest } from './memory-web'
import type { MemoryService } from './memory-service'

const svc = {
  list: async () => [{ chainId: 'mem_aaaaaaaa', factId: 'mem_aaaaaaaa', scope: 'repo', category: 'convention', statement: 'Use bun.', origin: 'person', validFrom: 'x', validTo: null, sessionId: null }],
  recall: async () => [],
  forget: async (c: string) => (c === 'mem_aaaaaaaa' ? { ok: true as const, versions: 1 } : { ok: false as const, reason: 'not-found' as const }),
} as unknown as MemoryService
const deps = (over: Partial<Parameters<typeof handleMemoryRequest>[2]> = {}) => ({ central: false, nativeOn: true, service: async () => svc, ...over })
const call = (method: string, path: string, d = deps()) => handleMemoryRequest(new Request(`http://x${path}`, { method }), new URL(`http://x${path}`), d)

describe('B6.6: /api/memory', () => {
  test('lists every fact; forgets one; an unknown or malformed id is 404', async () => {
    expect(await call('GET', '/api/memory')).toMatchObject({ status: 200, body: { facts: [{ statement: 'Use bun.' }] } })
    expect(await call('DELETE', '/api/memory/mem_aaaaaaaa')).toEqual({ status: 200, body: { forgotten: 'mem_aaaaaaaa', versions: 1 } })
    expect((await call('DELETE', '/api/memory/mem_bbbbbbbb')).status).toBe(404)
    expect((await call('DELETE', '/api/memory/..%2Fetc')).status).toBe(404)
  })
  test('experimental with the native harness; never on a central', async () => {
    expect(await call('GET', '/api/memory', deps({ nativeOn: false }))).toMatchObject({ status: 403, body: { error: 'experimental' } })
    expect((await call('GET', '/api/memory', deps({ central: true }))).status).toBe(409)
  })
})
