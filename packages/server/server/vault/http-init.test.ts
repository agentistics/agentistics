/**
 * POST /api/vault/init — the page creates the vault (same code path as `agentop vault init`).
 * Fake protector, throwaway directory; nothing under the real ~/.agentistics is touched.
 */
import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Protector, ProtectorId, UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, vaultStatus } from './service'
import { __resetGateForTests } from './gate'
import { handleVaultHttp } from './http'

const STORE = new Map<string, Uint8Array>()
function fake(id: ProtectorId): Protector {
  return {
    id, label: () => 'DPAPI (fake)',
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: '2026-10-02T00:00:00.000Z' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  } as Protector
}

async function post(local: boolean, body: unknown = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  if (local) Object.assign(headers, { host: 'localhost:47292', origin: 'http://localhost:47292' })
  const req = new Request(`${local ? 'http://localhost:47292' : 'http://local'}/api/vault/init`, { method: 'POST', headers, body: JSON.stringify(body) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'session-A', ...(local ? { peer: '127.0.0.1' } : {}) })
  const j = JSON.parse(await res!.text())
  return { status: res!.status, json: j as Record<string, any> }
}

async function freshHome(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-http-init-'))
  STORE.clear()
  const dpapi = fake('dpapi')
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi], autoInit: { candidates: [dpapi] } })
  __resetGateForTests()
}

test('a fresh HOME has no vault; the page creates it and it is open', async () => {
  await freshHome()
  expect((await vaultStatus()).state).toBe('uninitialized')
  const r = await post(true)
  expect(r.status).toBe(200)
  expect(r.json.ok).toBe(true)
  expect(r.json.existed).toBe(false)
  expect((await vaultStatus()).state).toBe('open')
})

test('creating twice is idempotent: the second answer says it already existed', async () => {
  await freshHome()
  await post(true)
  const again = await post(true)
  expect(again.json.ok).toBe(true)
  expect(again.json.existed).toBe(true)
})

test('only a page on this computer may create it', async () => {
  await freshHome()
  const r = await post(false)
  expect(r.status).toBe(403)
  expect(r.json.code).toBe('init-not-here')
  expect((await vaultStatus()).state).toBe('uninitialized')
})

test('a malformed passphrase is a 400, not a vault', async () => {
  await freshHome()
  const r = await post(true, { passphrase: 123 })
  expect(r.status).toBe(400)
  expect((await vaultStatus()).state).toBe('uninitialized')
})
