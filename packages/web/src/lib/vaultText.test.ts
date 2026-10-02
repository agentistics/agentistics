import { expect, test } from 'bun:test'
import { VAULT_TEXT, kindKey, orderItems, reasonKey, stateKey, vt, type VaultKey } from './vaultText'

test('every key has both languages, non-empty', () => {
  for (const [k, v] of Object.entries(VAULT_TEXT)) {
    expect(typeof v.en, k).toBe('string')
    expect(typeof v.pt, k).toBe('string')
    if (k !== 'none') { expect(v.en.length, k).toBeGreaterThan(0); expect(v.pt.length, k).toBeGreaterThan(0) }
  }
})

test('every code the server can send resolves to a key', () => {
  for (const kind of ['github-backup', 'central-token', 'envelope-key', 'central-env']) expect(kindKey(kind)).not.toBe('kind_other')
  expect(kindKey('github-backup')).toBe('kind_github_backup')
  expect(kindKey('nonsense')).toBe('kind_other')
  for (const s of ['open', 'locked', 'uninitialized', 'protector-lost', 'corrupt']) expect(VAULT_TEXT[stateKey(s)]).toBeDefined()
  for (const r of ['plaintext', 'wrong-machine', 'unparseable', 'mode-open']) expect(reasonKey(r)).not.toBeNull()
  expect(reasonKey(undefined)).toBeNull()
})

test('how-it-works says the limit in both languages', () => {
  expect(vt('how_not', 'en')).toContain('while the vault is open')
  expect(vt('how_not', 'pt')).toContain('enquanto o cofre está aberto')
  expect(vt('how_backup', 'en')).toContain('never carries the key')
})

test('pending leads, then unreadable, then sealed', () => {
  expect(orderItems([{ state: 'sealed' }, { state: 'pending' }, { state: 'unreadable' }]).map(i => i.state)).toEqual(['pending', 'unreadable', 'sealed'])
})
