import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetVaultForTests, lockVault, sealToFile } from './service'
import { kindOfPendingFile, lockVaultNow, readVaultView, requireVaultStepUp } from './inventory'

// Known values, planted so the test can prove the response never carries them.
const PLANTED = ['ghp_PLANTED_TOKEN_aaaa1111', 'zq9X-PLANTED-bbbb2222', 'wv7K-PLANTED-cccc3333']

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-vault-inv-'))
  __resetVaultForTests({ dir: join(dir, 'vault') })
  const a = join(dir, 'github-backup.sealed')
  const b = join(dir, 'tokens.sealed')
  const c = join(dir, 'secrets.sealed')
  const enc = (s: string) => new TextEncoder().encode(s)
  await sealToFile(a, 'github-backup', 'github-backup', enc(PLANTED[0]!))
  await sealToFile(b, 'central-token', 'central-token', enc(PLANTED[1]!))
  await sealToFile(c, 'central-env', 'central-env', enc(PLANTED[2]!))
  return { dir, a, b, c }
}

describe('vault inventory — metadata only', () => {
  test('lists what is sealed and NEVER carries a value, a fragment or a fingerprint', async () => {
    const { dir, a, b, c } = await setup()
    const plainFile = join(dir, 'github-backup.json')
    await writeFile(plainFile, JSON.stringify({ token: 'ghp_PENDING_PLAINTEXT_dddd4444' }))
    const view = await readVaultView([a, b, c], async () => [plainFile])
    const text = JSON.stringify(view)
    for (const v of [...PLANTED, 'ghp_PENDING_PLAINTEXT_dddd4444']) {
      expect(text).not.toContain(v)
      expect(text).not.toContain(v.slice(0, 8))
      expect(text).not.toContain(v.slice(-6))
    }
    expect(view.state).toBe('open')
    expect(view.kid).toMatch(/^[0-9a-f]{16}$/)
    expect(view.createdAt).not.toBeNull()
    expect(view.items.filter(i => i.state === 'sealed').map(i => i.kind).sort()).toEqual(['central-env', 'central-token', 'github-backup'])
    expect(view.items.every(i => i.state !== 'sealed' || !!i.sealedAt)).toBe(true)
    const pending = view.items.find(i => i.state === 'pending')!
    expect(pending.kind).toBe('github-backup')
    expect(pending.reason).toBe('plaintext')
    // Only these keys may ever appear on an item.
    for (const i of view.items) for (const k of Object.keys(i)) expect(['kind', 'state', 'reason', 'sealedAt', 'file', 'restoreWith']).toContain(k)
  })

  test('a file sealed by another vault is unreadable (wrong-machine) with how to re-enter; unparseable too', async () => {
    const { dir, a } = await setup()
    const other = join(dir, 'other.sealed')
    __resetVaultForTests({ dir: join(dir, 'vault-other') })
    await sealToFile(other, 'github-backup', 'github-backup', new TextEncoder().encode(PLANTED[0]!))
    __resetVaultForTests({ dir: join(dir, 'vault') })
    const junk = join(dir, 'junk.sealed')
    await writeFile(junk, 'not json', { mode: 0o600 })
    const view = await readVaultView([other, junk], async () => [])
    const wrong = view.items.find(i => i.file.endsWith('other.sealed'))!
    expect(wrong).toMatchObject({ state: 'unreadable', reason: 'wrong-machine' })
    expect(wrong.restoreWith).toBeTruthy()
    expect(view.items.find(i => i.file.endsWith('junk.sealed'))).toMatchObject({ state: 'unreadable', reason: 'unparseable' })
    void a
  })

  test('a group-readable sealed file is flagged mode-open', async () => {
    const { a } = await setup()
    await chmod(a, 0o644)
    const view = await readVaultView([a], async () => [])
    expect(view.items[0]).toMatchObject({ state: 'unreadable', reason: 'mode-open' })
  })

  test('lock now drops the key, through the one gate', async () => {
    await setup()
    expect((await requireVaultStepUp('lock')).ok).toBe(true)
    const r = await lockVaultNow()
    expect(r.ok).toBe(true)
    lockVault()
  })

  test('pending files map to what they hold', () => {
    expect(kindOfPendingFile('/x/preferences.json')).toBe('central-token')
    expect(kindOfPendingFile('/x/central.env')).toBe('central-env')
    expect(kindOfPendingFile('/x/machine-key.json')).toBe('envelope-key')
  })
})
