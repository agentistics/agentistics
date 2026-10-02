import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initVault, passphraseProtector, refusalSentence, VaultRefusalError, type VaultRefusal } from '@agentistics/vault'
import { omittedSecrets } from '../backup/backup-plan'
import {
  __resetVaultForTests, allRestoreWith, ensureVaultOpen, openFromFile, restoreWithFor, sealToFile, vaultStatus,
} from './service'
import { realProtectorIo } from './io'
import { askVaultSocket, startVaultSocket, stopVaultSocket } from './socket'

const FAST = { N: 2 ** 10, r: 8, p: 1 }
async function freshDir() { return mkdtemp(join(tmpdir(), 'agentistics-vault-svc-')) }
afterAll(async () => { stopVaultSocket(); __resetVaultForTests({ dir: join(await freshDir(), 'vault') }) })

describe('§2.8 refusal sentences — snapshot, EN and PT', () => {
  const args = { file: '~/.agentistics/github-backup.sealed', restoreWith: 'agentop backup github setup <url>', protector: 'Windows (DPAPI)', reason: 'DPAPI refused', kid: '0123456789abcdef', n: 3, checked: 'libsecret — no Secret Service answered; systemd-creds — no TPM2' }
  const codes: VaultRefusal[] = ['uninitialized', 'locked', 'no-protector', 'protector-lost', 'wrong-machine', 'tampered', 'plaintext-pending', 'migration-failed', 'purpose', 'protector-unavailable', 'conflict']
  test('English', () => {
    expect(Object.fromEntries(codes.map(c => [c, refusalSentence(c, 'en', args)]))).toMatchSnapshot()
  })
  test('Português', () => {
    expect(Object.fromEntries(codes.map(c => [c, refusalSentence(c, 'pt', args)]))).toMatchSnapshot()
  })
  test('the spec\'s own wording for the two most-read sentences', () => {
    expect(refusalSentence('uninitialized', 'en')).toBe('There is no vault on this machine yet, so this secret cannot be stored — Agentistics never writes one in plain text. Run `agentop vault init`.')
    expect(refusalSentence('no-protector', 'en', { checked: args.checked })).toBe('This machine has no system keychain Agentistics can use (checked: libsecret — no Secret Service answered; systemd-creds — no TPM2). Secrets are never stored in plain text, so they will be protected by a passphrase you choose. You will type it once each time the agentop service starts.')
  })
})

describe('{restoreWith} resolves through omittedSecrets()', () => {
  test('every purpose names the command of its backup-plan secret row — renaming that row fails here', () => {
    const rows = omittedSecrets()
    const cmd = (pattern: string) => rows.find(r => r.pattern === pattern)?.restoreWith
    expect(restoreWithFor('github-backup')).toBe(cmd('.agentistics/github-backup.')!)
    expect(restoreWithFor('central-token')).toBe(cmd('.agentistics/preferences.json#team.token')!)
    expect(restoreWithFor('envelope-key')).toBe(cmd('.agentistics/machine-key')!)
    expect(restoreWithFor('central-env')).toBe(cmd('.agentistics/central')!)
    expect(restoreWithFor('engine/provider-key')).toBe(cmd('.agentistics/provider-keys')!)
    expect(cmd('.agentistics/vault')).toBe('agentop vault init (runs on first use)')
    for (const p of ['github-backup', 'central-token', 'envelope-key', 'central-env']) expect(allRestoreWith()).toContain(restoreWithFor(p))
  })
})

describe('the service', () => {
  test('auto-creates a vault on the first seal, and a file sealed by another vault reads wrong-machine', async () => {
    const dir = await freshDir()
    __resetVaultForTests({ dir: join(dir, 'vault') })
    const file = join(dir, 'x.sealed')
    await sealToFile(file, 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET'))
    expect((await vaultStatus()).state).toBe('open')
    __resetVaultForTests({ dir: join(dir, 'vault2') })
    const r = await openFromFile(file, 'github-backup', 'github-backup')
    // A different vault exists only after something creates it: reading never creates one.
    expect(r.ok).toBe(false)
    if (!r.ok && !r.absent) expect(r.code).toBe('uninitialized')
    await sealToFile(join(dir, 'y.sealed'), 'github-backup', 'github-backup', new Uint8Array(1))
    const r2 = await openFromFile(file, 'github-backup', 'github-backup')
    expect(!r2.ok && !r2.absent && r2.code).toBe('wrong-machine')
    if (!r2.ok && !r2.absent) expect(r2.sentence).toContain('agentop backup github setup <url>')
  })

  test('a passphrase vault starts LOCKED; writes refuse with the locked sentence; the socket unlocks it', async () => {
    const dir = await freshDir()
    __resetVaultForTests({ dir: join(dir, 'vault'), scrypt: FAST, lang: 'en' })
    const init = await initVault(realProtectorIo(), join(dir, 'vault'), passphraseProtector({ io: realProtectorIo(), vaultDir: join(dir, 'vault'), passphrase: 'a long test passphrase', params: FAST }))
    expect(init.ok).toBe(true)
    __resetVaultForTests({ dir: join(dir, 'vault'), scrypt: FAST, lang: 'en' })
    expect(await ensureVaultOpen()).toBeNull()
    expect((await vaultStatus()).state).toBe('locked')
    let err: unknown
    try { await sealToFile(join(dir, 'z.sealed'), 'github-backup', 'github-backup', new Uint8Array(1)) } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultRefusalError)
    expect((err as Error).message).toBe(refusalSentence('locked', 'en'))

    const sock = join(dir, 'run', 'vault.sock')
    expect((await startVaultSocket(sock)).ok).toBe(true)
    const bad = await askVaultSocket({ op: 'unlock', passphrase: 'not the passphrase!!' }, sock)
    expect(bad && !bad.ok && bad.code).toBe('locked')
    expect(JSON.stringify(bad)).not.toContain('not the passphrase')
    const good = await askVaultSocket({ op: 'unlock', passphrase: 'a long test passphrase' }, sock)
    expect(good && good.ok && good.status?.state).toBe('open')
    await sealToFile(join(dir, 'z.sealed'), 'github-backup', 'github-backup', new Uint8Array(1))
    const locked = await askVaultSocket({ op: 'lock' }, sock)
    expect(locked && locked.ok && locked.status?.state).not.toBe('open')
    stopVaultSocket()
  })
})
