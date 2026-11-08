import { expect, test } from 'bun:test'
import { VAULT_TEXT, kindKey, lockedSubKey, orderItems, reasonKey, stateKey, vt, type VaultKey } from './vaultText'

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
  expect(vt('how_backup', 'en')).toContain('only wrapped under your 24 words')
})

test('pending leads, then unreadable, then sealed', () => {
  expect(orderItems([{ state: 'sealed' }, { state: 'pending' }, { state: 'unreadable' }]).map(i => i.state)).toEqual(['pending', 'unreadable', 'sealed'])
})

// v2.98.1 — owner rule: users never run commands. No page text names an `agentop` command, except the
// setup-code fallback (a first setup from off this computer, or one with no presence device).
test('no vault text tells the person to run a command (setup-code is the one fallback)', () => {
  for (const [k, v] of Object.entries(VAULT_TEXT)) {
    for (const s of [v.en, v.pt]) {
      if (k === 'wiz_setup_why') continue
      expect(s, k).not.toMatch(/`agentop /)
    }
  }
})

test('"Presence" is said as how the vault confirms it is you, naming every way there is', () => {
  expect(vt('sec_presence', 'pt')).toBe('Como o cofre confirma que é você')
  expect(vt('sec_presence', 'en')).toBe('How the vault confirms it is you')
  for (const s of ['Touch ID', 'Windows Hello', 'senha própria do cofre', 'chave de segurança']) expect(vt('sec_presence_d', 'pt')).toContain(s)
  for (const [k, v] of Object.entries(VAULT_TEXT)) expect(v.pt, k).not.toMatch(/[Pp]resença/)
})

test('the lock-screen sentence names the way this vault really confirms (a Mac never reads Windows Hello)', () => {
  expect(lockedSubKey(['hello', 'recovery'])).toBe('lockedSub_hello')
  expect(lockedSubKey(['fido2'])).toBe('lockedSub_fido2')
  expect(lockedSubKey(['keychain', 'touchid'])).toBe('lockedSub_touchid')
  expect(lockedSubKey(['password'])).toBe('lockedSub_password')
  for (const w of [['keychain'], [], null, undefined]) {
    const k = lockedSubKey(w)
    expect(k).toBe('lockedSub_plain')
    expect(vt(k, 'en')).not.toContain('Windows Hello')
    expect(vt(k, 'pt')).not.toContain('Windows Hello')
  }
})

// COFRE.DESBLOQUEIO (owner 2026-11-07): no QR, no 6-digit app code, no authenticator — anywhere on the page.
test('no vault text asks for an authenticator, a 6-digit code or a QR', () => {
  for (const [k, v] of Object.entries(VAULT_TEXT)) {
    if (k === 'legacy_code_note') continue // the one sentence that says the old code is gone
    for (const s of [v.en, v.pt]) expect(s, k).not.toMatch(/authenticator|autenticador|TOTP|\bQR\b|6 d[ií]git/i)
  }
})
