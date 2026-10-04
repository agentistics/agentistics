/**
 * The owner's requirement, end to end: a backup's vault bundle restores on a FRESH data dir with the 24
 * words — personal secrets and the GitHub token come back, and nothing else opens it.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryProtector } from '@agentistics/vault'
import { __resetVaultForTests, becomeVaultHolder, ensureVaultOpen, openFromFile, sealToFile, vaultStatus } from './service'
import { __resetGateForTests, beginRecoveryKey, confirmRecoveryKey, recoverWithWords, SOCKET_SESSION } from './gate'
import { __resetPersonalForTests, createItem, listItems, revealField } from './personal'
import { buildVaultBundle, stageBundleRestore } from './bundle-io'

async function machine(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-bundle-'))
  const mem = memoryProtector()
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [mem], autoInit: { candidates: [mem] } })
  __resetGateForTests(); __resetPersonalForTests()
  becomeVaultHolder()
  return dir
}

describe('vault bundle: backup on one machine, restore on a fresh one with the 24 words', () => {
  test('round trip', async () => {
    // ── machine A ──
    const a = await machine()
    await sealToFile(join(a, 'github-backup.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('ghp_MARKER_TOKEN'))
    expect(await ensureVaultOpen()).not.toBeNull()
    const r = await beginRecoveryKey({ session: SOCKET_SESSION })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), { session: SOCKET_SESSION })).ok).toBe(true)
    const item = (await createItem({ kind: 'login', name: 'Banco', fields: { login: 'me', password: 'MARKER-pw' } })).meta
    const built = await buildVaultBundle()
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.count).toBeGreaterThanOrEqual(3)
    const text = JSON.stringify(built.bundle)
    expect(text).not.toContain('MARKER')
    expect(text).not.toContain(item.id)

    // ── machine B: a fresh data dir, no vault, no protector that knows A ──
    const b = await machine()
    expect(await stageBundleRestore(text)).toEqual({ ok: true, replacedEmpty: false })
    expect(await stageBundleRestore(text)).toEqual({ ok: false, code: 'vault-exists' }) // never overwrites
    expect((await vaultStatus()).state).not.toBe('open')
    expect((await recoverWithWords('abandon '.repeat(23) + 'art')).ok).toBe(false)
    const rec = await recoverWithWords(r.words.join(' '))
    expect(rec.ok).toBe(true)
    expect(rec.ok && rec.todo).toContain('authenticator')
    // everything came back, readable under the same key
    const items = await listItems()
    expect(items.map(i => i.name)).toEqual(['Banco'])
    expect(await revealField(items[0]!.id, 'password')).toMatchObject({ ok: true, value: 'MARKER-pw' })
    const gh = await openFromFile(join(b, 'github-backup.sealed'), 'github-backup', 'github-backup')
    expect(gh.ok && new TextDecoder().decode(gh.plaintext)).toBe('ghp_MARKER_TOKEN')
    expect(existsSync(join(b, 'vault', 'restore-bundle.json'))).toBe(false)
    const vj = JSON.parse(readFileSync(join(b, 'vault', 'vault.json'), 'utf8'))
    expect(vj.wrappers.map((w: { type: string }) => w.type)).toEqual(['recovery'])
  })
  test('a fresh machine\'s EMPTY auto-created vault is set aside; a vault holding secrets is never replaced', async () => {
    const a = await machine()
    expect(await ensureVaultOpen()).not.toBeNull()
    const r = await beginRecoveryKey({ session: SOCKET_SESSION })
    if (!r.ok) throw new Error('no words')
    await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), { session: SOCKET_SESSION })
    await createItem({ kind: 'note', name: 'N', fields: { value: 'MARKER-note' } })
    const built = await buildVaultBundle()
    if (!built.ok) throw new Error('no bundle')
    const text = JSON.stringify(built.bundle)
    void a
    const b = await machine()
    expect(await ensureVaultOpen()).not.toBeNull() // first use created an empty vault
    expect(await stageBundleRestore(text)).toEqual({ ok: true, replacedEmpty: true })
    expect((await import('node:fs')).readdirSync(b).some(n => n.startsWith('vault.replaced-'))).toBe(true)
    expect((await recoverWithWords(r.words.join(' '))).ok).toBe(true)
    expect((await listItems()).map(i => i.name)).toEqual(['N'])
    // and now this vault HOLDS secrets: a second restore is refused
    expect(await stageBundleRestore(text)).toEqual({ ok: false, code: 'vault-exists' })
  })
  test('a vault without a recovery key cannot be bundled (it could never be restored)', async () => {
    await machine()
    expect(await ensureVaultOpen()).not.toBeNull()
    expect(await buildVaultBundle()).toEqual({ ok: false, code: 'no-recovery' })
  })
})
