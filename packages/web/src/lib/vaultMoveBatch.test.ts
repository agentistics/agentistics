import { expect, test } from 'bun:test'
import { moveBatch, withStepUp } from './vaultPersonal'
import { fakeVaultFetch, fakeItems } from '../../e2e/vault-bulk-fixture'

test('bulk moves reuse the single route and gated retry, never replaying earlier successes', async () => {
  const original = globalThis.fetch
  const fake = fakeVaultFetch(true)
  let requestedProof = false
  let asks = 0
  globalThis.fetch = (async (url, init) => {
    const b = JSON.parse(String(init?.body))
    if (b.id === 'pi_demo1' && !requestedProof) {
      requestedProof = true
      return Response.json({ ok: false, code: 'stepup-required', sentence: 'Confirm' }, { status: 403 })
    }
    return fake.fetcher(url, init)
  }) as typeof fetch
  try {
    const result = await moveBatch(fakeItems().slice(0, 3), 'pg_demo', call => withStepUp(call, async () => { asks++; return 'synthetic-proof' }))
    expect(asks).toBe(1)
    expect(fake.calls.map(c => c.id)).toEqual(['pi_demo0', 'pi_demo1', 'pi_demo2'])
    expect(fake.calls[1]!.code).toBe('synthetic-proof')
    expect(result.map(r => r.ok)).toEqual([true, false, true])
    expect(result[1]!.sentence).toBe('Atualizado em outra janela')
    expect(fake.stored[0]!.version).toBe(2)
  } finally { globalThis.fetch = original }
})

test('a transport failure is recorded per item and the next item still runs', async () => {
  const original = globalThis.fetch
  const fake = fakeVaultFetch()
  globalThis.fetch = fake.fetcher
  let n = 0
  try {
    const results = await moveBatch(fakeItems().slice(0, 3), null, async call => {
      if (++n === 2) throw new Error('offline')
      return call()
    })
    expect(results.map(r => r.ok)).toEqual([true, false, true])
    expect(results[1]!.code).toBe('network')
    expect(n).toBe(3)
  } finally { globalThis.fetch = original }
})
