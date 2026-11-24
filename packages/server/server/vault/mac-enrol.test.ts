import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { openRecord, touchIdProtector, OSASCRIPT, SECURITY, unlockMethodsFor, type Protector, type ProtectorIo } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, ensureVaultOpen, lockVault, openFromFile, sealToFile, vaultDir } from './service'
import { __resetGateForTests, beginRecoveryKey, confirmRecoveryKey, enrolPresence, presenceHeldFor } from './gate'
import { realProtectorIo, realSecretFs } from './io'
import { withVaultPassword } from './password-context'
import { __rekeyCrashAtForTests, finishRekeyIfPending } from './rekey'

const roots: string[] = []
const S = { session: 'socket' }
async function mac() {
  const root = await mkdtemp(join(tmpdir(), 'mac-enrol-')); roots.push(root)
  const keychain = new Map<string, string>()
  let prompts = 0, failStage = false, failJournal = false
  let stagedRead: (() => Promise<void>) | null = null
  const io: ProtectorIo = { ...realProtectorIo(), async firstExisting(candidates) { return candidates.find(c => c === OSASCRIPT || c === SECURITY) ?? null }, async run(cmd, args, stdin) {
    const answer = (s = '') => ({ code: 0, stdout: new TextEncoder().encode(s), stderr: '' })
    if (cmd === OSASCRIPT) { if (args[4] === 'ask') prompts++; return answer('OK') }
    if (cmd !== SECURITY) throw new Error('unexpected program')
    if (args[0] === '-i') {
      const m = / -a (\S+) .* -w ([0-9a-f]{64})/.exec(new TextDecoder().decode(stdin!))!
      keychain.set(m[1]!, m[2]!); return answer()
    }
    const kid = args[args.indexOf('-a') + 1]!
    if (args[0] === 'delete-generic-password') { keychain.delete(kid); return answer() }
    return answer(keychain.get(kid) ?? '')
  } }
  let silentKey = new Uint8Array()
  const silent: Protector = { id: 'keychain', label: () => 'Keychain',
    async probe() { return { ok: true } },
    async wrap(dek) { silentKey = new Uint8Array(dek); return { ok: true, record: { type: 'keychain', createdAt: 'x' } } },
    async unwrap() { return { ok: true, dek: new Uint8Array(silentKey) } }, async remove() {},
  }
  const touch = touchIdProtector({ io, vaultDir: join(root, 'vault') })
  __resetVaultForTests({ dir: join(root, 'vault'), lang: 'pt', io, protectors: [silent, touch], autoInit: { candidates: [silent] }, scrypt: { N: 1024, r: 8, p: 1 },
    fs: { ...realSecretFs, async openExclusive(path, mode) {
      if (failJournal && path.includes('rekey.json.tmp-')) throw Object.assign(new Error('journal write denied'), { code: 'EACCES' })
      return realSecretFs.openExclusive(path, mode)
    }, async readFile(path) {
      const raw = await realSecretFs.readFile(path)
      if (path.endsWith('.sealed.rekey') && stagedRead) { const hook = stagedRead; stagedRead = null; await hook() }
      return failStage && path.endsWith('.sealed.rekey') ? new TextEncoder().encode('{}') : raw
    } },
  })
  __resetGateForTests()
  await sealToFile(join(root, 'test.sealed'), 'github-backup', 'test', new TextEncoder().encode('TEST VALUE'))
  return { root, touch, prompts: () => prompts, keychain, setFail: (v: boolean) => { failStage = v }, setJournalFail: (v: boolean) => { failJournal = v }, onStagedRead: (hook: () => Promise<void>) => { stagedRead = hook } }
}
afterAll(async () => {
  __resetGateForTests(); __resetVaultForTests()
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

test('darwin Touch ID enrol commits at recovery without a second prompt', async () => {
  expect(unlockMethodsFor({ platform: 'darwin', wsl: false, fido2Tools: false, webauthnVerified: false }).map(m => m.id)).toEqual(['touchid', 'password'])
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  expect(await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).toEqual({ ok: true })
  expect(m.prompts()).toBe(1)
  expect(JSON.parse(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).wrappers.map((w: { type: string }) => w.type).sort()).toEqual(['recovery', 'touchid'])
  expect((await openFromFile(join(m.root, 'test.sealed'), 'github-backup', 'test')).ok).toBe(true)
})

test('failed rekey verification reports its stage, keeps held proof and words for a safe retry', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const before = readFileSync(join(vaultDir(), 'vault.json'), 'utf8')
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  m.setFail(true)
  const log = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const failed = await confirmRecoveryKey(typed, S)
    expect(failed).toMatchObject({ ok: false, code: 'rekey-verify-failed' })
    expect(!failed.ok && failed.sentence).toContain('conferir')
    expect(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).toBe(before)
    expect(presenceHeldFor(S)).toBe('touchid')
    expect(log.mock.calls.flat().join(' ')).toContain('rekey-verify-failed')
    expect(log.mock.calls.flat().join(' ')).not.toContain('TEST VALUE')
    expect(log.mock.calls.flat().join(' ')).not.toContain(r.words.join(' '))
    expect(log.mock.calls.flat().join(' ')).not.toContain(typed.join(' '))
    for (const secret of m.keychain.values()) expect(log.mock.calls.flat().join(' ')).not.toContain(secret)
    m.setFail(false)
    expect(await confirmRecoveryKey(typed, S)).toEqual({ ok: true })
    expect(m.prompts()).toBe(1)
    expect((await ensureVaultOpen())?.vault.wrappers.map(w => w.type).sort()).toEqual(['recovery', 'touchid'])
  } finally { log.mockRestore() }
})

test('switching a held Touch ID attempt to the vault password discards its Keychain item', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  expect(m.keychain.size).toBe(1)
  expect((await withVaultPassword('Test-Only!Pw9', () => enrolPresence('password', S))).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  expect(await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).toEqual({ ok: true })
  expect((await ensureVaultOpen())?.vault.wrappers.map(w => w.type).sort()).toEqual(['password', 'recovery'])
  expect(m.keychain.size).toBe(0)
})

test('a denied initial journal write returns a specific refusal and remains retryable', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  m.setJournalFail(true)
  expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'vault-write-failed' })
  expect(presenceHeldFor(S)).toBe('touchid')
  m.setJournalFail(false)
  expect(await confirmRecoveryKey(typed, S)).toEqual({ ok: true })
  expect(m.prompts()).toBe(1)
})

test('recovery readback mismatch keeps the Mac credential intact for a verified retry', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  const read = realSecretFs.readFile
  const readback = spyOn(realSecretFs, 'readFile').mockImplementation(async path => path.endsWith('dek.recovery.rekey') ? new TextEncoder().encode('{}') : read(path))
  try {
    expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'recovery-verify-failed' })
    expect(presenceHeldFor(S)).toBe('touchid')
    expect(m.keychain.size).toBe(1)
    expect((await ensureVaultOpen())?.vault.wrappers.map(w => w.type)).toEqual(['keychain'])
  } finally { readback.mockRestore() }
  expect(await confirmRecoveryKey(typed, S)).toEqual({ ok: true })
  expect(m.prompts()).toBe(1)
})

test('words generated for a held Mac proof never finish setup after that proof expires', async () => {
  await mac()
  let now = Date.now()
  __setVaultClockForTests(() => now); __resetGateForTests(() => now)
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  now += 5 * 60_000
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  now += 6 * 60_000 // proof expired, but these recovery words are still inside their own lifetime
  expect(await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).toMatchObject({ ok: false, code: 'presence-held-stale' })
  expect((await ensureVaultOpen())?.vault.wrappers.map(w => w.type)).toEqual(['keychain'])
})

test('after the commit point a journal error cannot reuse a zeroed held key on retry', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  __rekeyCrashAtForTests('before-commit-mark')
  await expect(confirmRecoveryKey(typed, S)).rejects.toThrow('injected crash')
  expect(presenceHeldFor(S)).toBeNull()
  expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'no-recovery-pending' })
  const o = await ensureVaultOpen(); expect(o?.vault.wrappers.map(w => w.type).sort()).toEqual(['recovery', 'touchid'])
  await finishRekeyIfPending(o!.kid)
  expect((await openFromFile(join(m.root, 'test.sealed'), 'github-backup', 'test')).ok).toBe(true)
})

test('a save in progress refuses concurrent setup requests without changing its recovery entropy', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  let release!: () => void, reached!: () => void
  const pause = new Promise<void>(r => { release = r }), entered = new Promise<void>(r => { reached = r })
  m.onStagedRead(async () => { reached(); await pause })
  const saving = confirmRecoveryKey(typed, S)
  await entered
  try {
    expect(await beginRecoveryKey(S)).toMatchObject({ ok: false, code: 'enrol-busy' })
    expect(await enrolPresence('touchid', S)).toMatchObject({ ok: false, code: 'enrol-busy' })
    expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'enrol-busy' })
  } finally { release() }
  expect(await saving).toEqual({ ok: true })
})

test('locking during an authorized save cannot zero or delete the credential being committed', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  m.onStagedRead(async () => { lockVault('user') })
  expect(await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).toEqual({ ok: true })
  expect(presenceHeldFor(S)).toBeNull()
  const vault = JSON.parse(readFileSync(join(vaultDir(), 'vault.json'), 'utf8'))
  const u = await m.touch.unwrap({ type: 'touchid', createdAt: 'x' }, vault.kid)
  expect(u.ok).toBe(true)
  if (u.ok) {
    try { expect(openRecord({ dek: u.dek, kid: vault.kid, purpose: 'github-backup', name: 'test', bytes: readFileSync(join(m.root, 'test.sealed')) }).ok).toBe(true) }
    finally { u.dek.fill(0) }
  }
})

test('a failed save after a concurrent lock discards the old proof instead of restoring it', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  m.setFail(true); m.onStagedRead(async () => { lockVault('user') })
  expect(await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).toMatchObject({ ok: false, code: 'rekey-verify-failed' })
  expect(presenceHeldFor(S)).toBeNull(); expect(m.keychain.size).toBe(0)
  expect((await ensureVaultOpen())?.vault.wrappers.map(w => w.type)).toEqual(['keychain'])
})

// audit.jsonl is the append-only log of what happened; it is not vault state.
function vaultFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of readdirSync(vaultDir()).sort().filter(f => f !== 'audit.jsonl')) out[n] = readFileSync(join(vaultDir(), n)).toString('base64')
  return out
}

test('R1: a failed recovery confirmation leaves no dek.touchid and the vault files byte-identical', async () => {
  const m = await mac()
  const before = vaultFiles()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  const read = realSecretFs.readFile
  const readback = spyOn(realSecretFs, 'readFile').mockImplementation(async path => path.endsWith('dek.recovery.rekey') ? new TextEncoder().encode('{}') : read(path))
  try {
    expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'recovery-verify-failed' })
  } finally { readback.mockRestore() }
  expect(existsSync(join(vaultDir(), 'dek.touchid'))).toBe(false)
  expect(vaultFiles()).toEqual(before)
  expect(presenceHeldFor(S)).toBe('touchid') // the held proof still allows a verified retry
  expect(m.keychain.size).toBe(1)
  expect(await confirmRecoveryKey(typed, S)).toEqual({ ok: true })
  expect(existsSync(join(vaultDir(), 'dek.touchid'))).toBe(true)
})

test('R1: after a failed confirmation and the password-only fallback no dek.touchid is left behind', async () => {
  const m = await mac()
  const before = vaultFiles()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  const read = realSecretFs.readFile
  const readback = spyOn(realSecretFs, 'readFile').mockImplementation(async path => path.endsWith('dek.recovery.rekey') ? new TextEncoder().encode('{}') : read(path))
  try {
    expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'recovery-verify-failed' })
  } finally { readback.mockRestore() }
  expect((await withVaultPassword('Test-Only!Pw9', () => enrolPresence('password', S))).ok).toBe(true)
  expect(presenceHeldFor(S)).toBe('password')
  expect(m.keychain.size).toBe(0)
  expect(existsSync(join(vaultDir(), 'dek.touchid'))).toBe(false)
  expect(vaultFiles()).toEqual(before)
})

test('R1: an unreadable earlier dek.touchid refuses the save and is left byte-identical', async () => {
  await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const file = join(vaultDir(), 'dek.touchid')
  writeFileSync(file, '{"v":1,"wrapped":"earlier-valid-wrapper"}\n', { mode: 0o600 })
  const before = vaultFiles()
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  const read = realSecretFs.readFile
  const denied = spyOn(realSecretFs, 'readFile').mockImplementation(async path => {
    if (path.endsWith('dek.touchid')) throw Object.assign(new Error('read denied'), { code: 'EACCES' })
    return read(path)
  })
  try {
    expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'presence-file-read-failed' })
  } finally { denied.mockRestore() }
  expect(vaultFiles()).toEqual(before)
  expect(presenceHeldFor(S)).toBe('touchid')
})

test('R1: vault.json written then the directory sync throws — nothing it references is deleted', async () => {
  const m = await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  const oldKid = JSON.parse(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).kid
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  const sync = realSecretFs.fsyncDir
  const flaky = spyOn(realSecretFs, 'fsyncDir').mockImplementation(async dir => {
    await sync(dir)
    if (JSON.parse(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).kid !== oldKid) throw Object.assign(new Error('sync failed'), { code: 'EIO' })
  })
  try { await expect(confirmRecoveryKey(typed, S)).rejects.toThrow('sync failed') } finally { flaky.mockRestore() }
  expect(existsSync(join(vaultDir(), 'dek.touchid'))).toBe(true)
  expect(existsSync(join(vaultDir(), 'dek.recovery')) || existsSync(join(vaultDir(), 'dek.recovery.rekey'))).toBe(true)
  const vault = JSON.parse(readFileSync(join(vaultDir(), 'vault.json'), 'utf8'))
  expect(vault.wrappers.map((w: { type: string }) => w.type).sort()).toEqual(['recovery', 'touchid'])
  await finishRekeyIfPending(vault.kid) // what the next open does: vault.json names the new kid, so finish it
  expect(existsSync(join(vaultDir(), 'dek.recovery'))).toBe(true)
  const u = await m.touch.unwrap({ type: 'touchid', createdAt: 'x' }, vault.kid)
  expect(u.ok).toBe(true)
  if (u.ok) {
    try { expect(openRecord({ dek: u.dek, kid: vault.kid, purpose: 'github-backup', name: 'test', bytes: readFileSync(join(m.root, 'test.sealed')) }).ok).toBe(true) }
    finally { u.dek.fill(0) }
  }
})

test('R1: an abandoned attempt leaves a valid earlier dek.touchid byte-identical', async () => {
  await mac()
  expect((await enrolPresence('touchid', S)).ok).toBe(true)
  writeFileSync(join(vaultDir(), 'dek.touchid'), '{"v":1,"wrapped":"earlier-valid-wrapper"}\n', { mode: 0o600 })
  const before = vaultFiles()
  const r = await beginRecoveryKey(S); if (!r.ok) throw new Error(r.sentence)
  const typed = r.positions.map(p => r.words[p - 1]!)
  const read = realSecretFs.readFile
  const readback = spyOn(realSecretFs, 'readFile').mockImplementation(async path => path.endsWith('dek.recovery.rekey') ? new TextEncoder().encode('{}') : read(path))
  try {
    expect(await confirmRecoveryKey(typed, S)).toMatchObject({ ok: false, code: 'recovery-verify-failed' })
  } finally { readback.mockRestore() }
  expect(vaultFiles()).toEqual(before)
})
