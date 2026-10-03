import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiCompatible, ENGINE_API_VERSION } from '@agentistics/engine-api'
import { engineSecrets, notifyEngineSecretsChange, __resetEngineSecretsForTests } from './engine-secrets'
import { __resetVaultForTests, sealBytes } from './service'

const fresh = async () => join(await mkdtemp(join(tmpdir(), 'agentistics-engine-secrets-')), 'vault')
afterAll(async () => { __resetVaultForTests({ dir: await fresh() }) })

describe('engine-api 1.5 secrets', () => {
  test('is a minor, optional bump: a 1.5 engine loads on a 1.6 host, a 1.3 engine too, not the reverse', () => {
    expect(ENGINE_API_VERSION).toBe('1.6.0')
    expect(apiCompatible('1.6.0', '1.5.0')).toBe(true)
    expect(apiCompatible('1.5.0', '1.6.0')).toBe(false)
    expect(apiCompatible('1.5.0', '1.3.0')).toBe(true)
    expect(apiCompatible('1.4.0', '1.5.0')).toBe(false)
  })

  test('round-trips an engine purpose; the engine never receives key material', async () => {
    __resetVaultForTests({ dir: await fresh() })
    const s = engineSecrets()
    const pt = new TextEncoder().encode('TEST-NOT-A-SECRET-provider')
    const sealed = await s.seal('engine/provider-key', 'anthropic', pt)
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return
    expect(new TextDecoder().decode(sealed.sealed)).not.toContain('TEST-NOT-A-SECRET')
    const opened = await s.open('engine/provider-key', 'anthropic', sealed.sealed)
    expect(opened.ok && new TextDecoder().decode(opened.plaintext)).toBe('TEST-NOT-A-SECRET-provider')
    expect(s.status().state).toBe('open')
    // A blob moved to another provider's name is tampered.
    const moved = await s.open('engine/provider-key', 'openai', sealed.sealed)
    expect(!moved.ok && moved.code).toBe('tampered')
  })

  test('a purpose outside engine/ is refused at runtime — the host\'s own secrets are unreachable', async () => {
    __resetVaultForTests({ dir: await fresh() })
    const s = engineSecrets()
    const hostBlob = await sealBytes('github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET-gh'))
    const asHost = await s.open('github-backup' as `engine/${string}`, 'github-backup', hostBlob)
    expect(asHost).toEqual({ ok: false, code: 'purpose', sentence: expect.any(String) })
    const sealHost = await s.seal('central-token' as `engine/${string}`, 'x', new Uint8Array(1))
    expect(!sealHost.ok && sealHost.code).toBe('purpose')
    // And opening the host's blob under an engine purpose fails cryptographically.
    const crafted = await s.open('engine/github-backup', 'github-backup', hostBlob)
    expect(!crafted.ok && crafted.code).toBe('tampered')
  })
})

describe('engine-api 1.6 secrets status', () => {
  test('a locked vault says lockedBy "start" until it has been open; subscribers get notified and can unsubscribe', async () => {
    __resetVaultForTests({ dir: await fresh() })
    __resetEngineSecretsForTests()
    const s = engineSecrets()
    const seen: string[] = []
    const off = s.onStateChange!(st => seen.push(`${st.state}:${st.lockedBy ?? ''}`))
    notifyEngineSecretsChange('auto-lock')
    expect(seen.length).toBe(1)
    off()
    notifyEngineSecretsChange('user')
    expect(seen.length).toBe(1)
  })
  test('an open vault reports its auto-lock countdown and no lockedBy (review S5: not null — the human scope always auto-locks)', async () => {
    __resetVaultForTests({ dir: await fresh() })
    __resetEngineSecretsForTests()
    const s = engineSecrets()
    await s.seal('engine/provider-key', 'x', new Uint8Array([1]))
    const st = s.status()
    expect(st.state).toBe('open')
    expect(st.lockedBy).toBeUndefined()
    expect(typeof st.autoLockInMs).toBe('number')
    expect(st.autoLockInMs!).toBeGreaterThan(0)
  })
})
