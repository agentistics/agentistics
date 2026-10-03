import { describe, expect, test, afterAll } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { ENGINE_OWNED_DIRS, sealedFiles } from './boot'
import { __resetVaultForTests, ensureVaultOpen, runMigrations, vaultDir, vaultMigrators, pendingPlaintext } from './service'
import { routeEngineVaultAudit } from './engine-secrets'

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-own-after-')), 'vault') }) })

describe('ONE OWNER PER FILE — the host never touches provider-keys (the engine owns S1)', () => {
  test('a full migration pass leaves provider-keys/ byte-for-byte untouched, and counts nothing there', async () => {
    __resetVaultForTests({ dir: join(AGENTISTICS_DATA_DIR, 'vault') })
    const dir = join(AGENTISTICS_DATA_DIR, 'provider-keys')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const plain = join(dir, 'anthropic.json')
    const sealed = join(dir, 'openai.sealed')
    writeFileSync(plain, JSON.stringify({ v: 1, provider: 'anthropic', value: 'TEST-NOT-A-SECRET-s1', storedAt: '2026-10-01T00:00:00Z' }), { mode: 0o600 })
    writeFileSync(sealed, '{"engine-owned":true}', { mode: 0o600 })
    const before = readdirSync(dir).map(f => [f, readFileSync(join(dir, f), 'utf8'), statSync(join(dir, f)).mtimeMs])
    const pendingBefore = await pendingPlaintext()
    expect(await ensureVaultOpen()).not.toBeNull()
    await runMigrations(true)
    expect(readdirSync(dir).map(f => [f, readFileSync(join(dir, f), 'utf8'), statSync(join(dir, f)).mtimeMs])).toEqual(before)
    expect(await pendingPlaintext()).toBe(pendingBefore)
    expect(sealedFiles().some(f => f.startsWith(dir))).toBe(false)
    expect(ENGINE_OWNED_DIRS).toContain(dir)
  })

  test('no host vault module reads or writes under provider-keys (source lint)', () => {
    const src = join(import.meta.dir)
    const offenders: string[] = []
    for (const f of readdirSync(src).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const code = readFileSync(join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const line of code.split('\n')) {
        if (!line.includes('provider-keys')) continue
        // The two allowed mentions: the restore-row LOOKUP and the declaration of the engine's dir.
        if (/'engine\/provider-key': '\.agentistics\/provider-keys'/.test(line) || /ENGINE_OWNED_DIRS/.test(line)) continue
        offenders.push(`${f}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
    expect(vaultMigrators().map(m => m.id).sort()).toEqual(['central-env', 'envelope-key', 'github-backup', 'preferences-tokens'])
  })
})

describe('engine-api 1.5 vault audit actions → vault/audit.jsonl', () => {
  test('vault.* events land in the local audit with purpose and name only; others go elsewhere', async () => {
    __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-own-audit-')), 'vault') })
    for (const action of ['vault.migrated', 'vault.plaintext-pending', 'vault.migration-failed'] as const) {
      expect(routeEngineVaultAudit({ action, ip: 'local', meta: { purpose: 'engine/provider-key', name: 'anthropic', token: 'TEST-NOT-A-SECRET-leak', value: 'TEST-NOT-A-SECRET-leak' } })).toBe(true)
    }
    expect(routeEngineVaultAudit({ action: 'provider.set', ip: 'local' })).toBe(false)
    // A host purpose or a junk name is not recorded as given.
    routeEngineVaultAudit({ action: 'vault.migrated', ip: 'local', meta: { purpose: 'github-backup', name: '../../x' } })
    const file = join(vaultDir(), 'audit.jsonl')
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.type)).toEqual(['vault.migrated', 'vault.plaintext-pending', 'vault.migration-failed', 'vault.migrated'])
    expect(lines[0]).toMatchObject({ purpose: 'engine/provider-key', name: 'anthropic', source: 'engine' })
    expect(lines[3].purpose).toBeUndefined()
    expect(lines[3].name).toBeUndefined()
    expect(readFileSync(file, 'utf8')).not.toContain('TEST-NOT-A-SECRET')
  })
})
