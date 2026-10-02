import { describe, expect, it } from 'bun:test'
import { dpapiProtector, DPAPI_SCRIPT, POWERSHELL_ARGS, WSL_INTEROP, WSL_POWERSHELL } from './dpapi'
import { keychainProtector, SECURITY } from './keychain'
import { libsecretProtector, SECRET_TOOL_PATHS } from './libsecret'
import { systemdCredsProtector, SYSTEMD_CREDS_PATHS } from './systemd-creds'
import { checkPassphrase, passphraseProtector } from './passphrase'
import { memoryProtector, __forgetMemoryKey } from './memory'
import { chooseProtector, detectionOrder, initVault, openVault, checkedList, addPassphraseWrapper, rekeyVault } from '../vault'
import { newDataKey } from '../seal'
import { bytes, text, toHex, type ProtectorIo, type RunResult } from './types'

const FAST = { N: 2 ** 10, r: 8, p: 1 }

interface Call { cmd: string; args: readonly string[]; stdin: string }

/**
 * A fake machine. `answer` decides each command's result. It FAILS the test the moment any argv
 * element contains a payload that went to stdin — a secret on argv is visible to every user via ps.
 */
function fakeIo(answer: (c: Call) => RunResult | Promise<RunResult>, opts: { exists?: string[]; which?: Record<string, string> } = {}) {
  const files = new Map<string, Uint8Array>()
  const calls: Call[] = []
  const secretsSeen = new Set<string>()
  const io: ProtectorIo = {
    async run(cmd, args, stdin) {
      const s = stdin ? text(stdin) : ''
      for (const tok of s.split(/[\s\n]+/).filter(t => t.length >= 32)) secretsSeen.add(tok)
      for (const a of args) for (const sec of secretsSeen) if (a.includes(sec)) throw new Error(`SECRET IN ARGV: ${cmd}`)
      const c = { cmd, args, stdin: s }
      calls.push(c)
      return answer(c)
    },
    async readFile(p) { return files.get(p) ?? null },
    async writeFile(p, d) { files.set(p, d) },
    async removeFile(p) { files.delete(p) },
    async createExclusive(p, d) { if (files.has(p)) return false; files.set(p, d); return true },
    async firstExisting(cands) { return cands.find(c => (opts.exists ?? []).includes(c)) ?? null },
    async which(cmd) { return opts.which?.[cmd] ?? null },
  }
  return { io, files, calls }
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout: bytes(stdout), stderr: '' })
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: new Uint8Array(), stderr })

/** A fake DPAPI: "protect" = reversible tag with the entropy, so unprotect with the wrong entropy fails. */
function dpapiAnswer(c: Call): RunResult {
  const [verb, ent, data] = c.stdin.split('\n')
  if (verb === 'protect') return ok(Buffer.from(`${ent}|${data}`).toString('base64'))
  const raw = Buffer.from(data!, 'base64').toString()
  const [e, d] = raw.split('|')
  if (e !== ent) return fail('DPAPI-ERROR System.Security.Cryptography.CryptographicException', 3)
  return ok(d!)
}

describe('dpapi', () => {
  it('runs powershell.exe with the fixed script; the payload goes on stdin only', async () => {
    const { io, calls, files } = fakeIo(dpapiAnswer, { exists: [WSL_INTEROP, WSL_POWERSHELL] })
    const p = dpapiProtector({ io, vaultDir: '/v', wsl: true })
    expect((await p.probe()).ok).toBe(true)
    const { dek, kid } = newDataKey()
    const w = await p.wrap(dek, kid)
    expect(w.ok).toBe(true)
    expect(files.has('/v/dek.dpapi')).toBe(true)
    for (const c of calls) {
      expect(c.cmd).toBe(WSL_POWERSHELL)
      expect(c.args).toEqual([...POWERSHELL_ARGS])
    }
    expect(DPAPI_SCRIPT).not.toMatch(/[0-9a-f]{64}/)
    const u = await p.unwrap(w.ok ? w.record : (null as never), kid)
    expect(u.ok && toHex(u.dek)).toBe(toHex(dek))
  })
  it('the wrong vault (entropy) maps to missing → protector-lost', async () => {
    const { io } = fakeIo(dpapiAnswer, { exists: [WSL_INTEROP, WSL_POWERSHELL] })
    const p = dpapiProtector({ io, vaultDir: '/v', wsl: true })
    const { dek, kid } = newDataKey()
    const w = await p.wrap(dek, kid)
    const u = await p.unwrap(w.ok ? w.record : (null as never), 'ffffffffffffffff')
    expect(u.ok).toBe(false)
    if (!u.ok) { expect(u.kind).toBe('missing'); expect(u.reason).toContain('CryptographicException') }
  })
  it('interop off is unavailable, said in words', async () => {
    const { io } = fakeIo(dpapiAnswer, { exists: [WSL_POWERSHELL] })
    const r = await dpapiProtector({ io, vaultDir: '/v', wsl: true }).probe()
    expect(r).toEqual({ ok: false, reason: 'Windows interop is off or powershell.exe was not found' })
  })
  it('a probe whose round trip differs is rejected', async () => {
    const { io } = fakeIo(c => c.stdin.startsWith('protect') ? ok('QUJD') : ok(Buffer.from('xyz').toString('base64')), { exists: [WSL_INTEROP, WSL_POWERSHELL] })
    expect((await dpapiProtector({ io, vaultDir: '/v', wsl: true }).probe()).ok).toBe(false)
  })
})

describe('keychain', () => {
  function keychainAnswer(store: Map<string, string>) {
    return (c: Call): RunResult => {
      if (c.args[0] === '-i') {
        const m = /-a (\S+) .* -w ([0-9a-f]+)/.exec(c.stdin)
        store.set(m![1]!, m![2]!)
        return ok()
      }
      if (c.args[0] === 'find-generic-password') {
        const v = store.get(c.args[4]!)
        return v ? ok(v + '\n') : fail('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.', 44)
      }
      if (c.args[0] === 'delete-generic-password') { store.delete(c.args[4]!); return ok() }
      return fail('?')
    }
  }
  it('writes through `security -i` on stdin; reads with argv holding only service and kid', async () => {
    const store = new Map<string, string>()
    const { io, calls } = fakeIo(keychainAnswer(store), { exists: [SECURITY] })
    const p = keychainProtector(io)
    expect((await p.probe()).ok).toBe(true)
    expect(store.size).toBe(0) // the probe cleans up
    const { dek, kid } = newDataKey()
    expect((await p.wrap(dek, kid)).ok).toBe(true)
    const u = await p.unwrap({ type: 'keychain', createdAt: '' }, kid)
    expect(u.ok && toHex(u.dek)).toBe(toHex(dek))
    expect(calls.some(c => c.cmd === SECURITY && c.args[0] === '-i')).toBe(true)
  })
  it('item not found → missing; a cancelled prompt → denied', async () => {
    const { io } = fakeIo(() => fail('The specified item could not be found in the keychain.', 44), { exists: [SECURITY] })
    const u = await keychainProtector(io).unwrap({ type: 'keychain', createdAt: '' }, 'aaaaaaaaaaaaaaaa')
    expect(!u.ok && u.kind).toBe('missing')
    const { io: io2 } = fakeIo(() => fail('security: User canceled the operation. (-128)', 128), { exists: [SECURITY] })
    const u2 = await keychainProtector(io2).unwrap({ type: 'keychain', createdAt: '' }, 'aaaaaaaaaaaaaaaa')
    expect(!u2.ok && u2.kind).toBe('denied')
  })
})

describe('libsecret', () => {
  it('no Secret Service is said in words', async () => {
    const { io } = fakeIo(() => fail('secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY'), { which: { 'secret-tool': '/usr/bin/secret-tool' } })
    expect(await libsecretProtector(io).probe()).toEqual({ ok: false, reason: 'no Secret Service answered' })
  })
  it('absent tool is refused before any run', async () => {
    const { io, calls } = fakeIo(() => ok())
    expect(await libsecretProtector(io).probe()).toEqual({ ok: false, reason: 'secret-tool is not installed' })
    expect(calls).toEqual([])
  })
  it('round-trips with the secret on stdin; an empty lookup is missing', async () => {
    const store = new Map<string, string>()
    const { io } = fakeIo(c => {
      const acct = c.args[c.args.length - 1]!
      if (c.args[0] === 'store') { store.set(acct, c.stdin); return ok() }
      if (c.args[0] === 'lookup') return ok(store.get(acct) ?? '')
      store.delete(acct); return ok()
    }, { which: { 'secret-tool': '/usr/bin/secret-tool' } })
    const p = libsecretProtector(io)
    expect((await p.probe()).ok).toBe(true)
    const { dek, kid } = newDataKey()
    await p.wrap(dek, kid)
    expect((await p.unwrap({ type: 'libsecret', createdAt: '' }, kid)).ok).toBe(true)
    const miss = await p.unwrap({ type: 'libsecret', createdAt: '' }, 'bbbbbbbbbbbbbbbb')
    expect(!miss.ok && miss.kind).toBe('missing')
  })
})

describe('systemd-creds', () => {
  it('refuses without TPM2 and never emits --with-key=host', async () => {
    const { io, calls } = fakeIo(c => c.args[0] === 'has-tpm2' ? { code: 1, stdout: bytes('partial\n'), stderr: '' } : ok(), { which: { 'systemd-creds': '/usr/bin/systemd-creds' } })
    expect(await systemdCredsProtector(io, '/v').probe()).toEqual({ ok: false, reason: 'no TPM2' })
    for (const c of calls) expect(c.args.join(' ')).not.toContain('--with-key=host')
  })
  it('with TPM2: encrypt with --with-key=tpm2 via stdin/stdout, decrypt back', async () => {
    const { io, calls, files } = fakeIo(c => {
      if (c.args[0] === 'has-tpm2') return ok('yes\n')
      if (c.args[0] === 'encrypt') return ok('SEALED:' + c.stdin)
      if (c.args[0] === 'decrypt') return ok(c.stdin.replace('SEALED:', ''))
      return fail('?')
    }, { which: { 'systemd-creds': '/usr/bin/systemd-creds' } })
    const p = systemdCredsProtector(io, '/v')
    expect((await p.probe()).ok).toBe(true)
    const { dek, kid } = newDataKey()
    await p.wrap(dek, kid)
    expect(files.has('/v/dek.cred')).toBe(true)
    const u = await p.unwrap({ type: 'systemd-creds', createdAt: '' }, kid)
    expect(u.ok && toHex(u.dek)).toBe(toHex(dek))
    const encs = calls.filter(c => c.args[0] === 'encrypt')
    expect(encs.every(c => c.args.includes('--with-key=tpm2') && !c.args.includes('--with-key=host'))).toBe(true)
  })
  it('an old systemd names the version it needs', async () => {
    const { io } = fakeIo(c => c.args[0] === 'has-tpm2' ? ok('yes\n') : fail("systemd-creds: unrecognized option '--user'"), { which: { 'systemd-creds': '/usr/bin/systemd-creds' } })
    const r = await systemdCredsProtector(io, '/v').probe()
    expect(!r.ok && r.reason).toContain('256')
  })
})

describe('passphrase', () => {
  it('empty, short and equal-to-a-secret are refused', () => {
    expect(checkPassphrase('')).toEqual({ ok: false, reason: 'empty' })
    expect(checkPassphrase('short')).toEqual({ ok: false, reason: 'short' })
    expect(checkPassphrase('TEST-NOT-A-SECRET-abcdef', ['TEST-NOT-A-SECRET-abcdef'])).toEqual({ ok: false, reason: 'equals-secret' })
    expect(checkPassphrase('a long enough phrase')).toEqual({ ok: true })
  })
  it('reads the scrypt parameters from the file; a wrong passphrase is denied with no detail', async () => {
    const { io, files } = fakeIo(() => ok())
    const { dek, kid } = newDataKey()
    const w = await passphraseProtector({ io, vaultDir: '/v', passphrase: 'correct horse battery', params: FAST }).wrap(dek, kid)
    expect(w.ok).toBe(true)
    const stored = JSON.parse(text(files.get('/v/dek.pass')!))
    expect(stored).toMatchObject({ kdf: 'scrypt', N: FAST.N, r: 8, p: 1 })
    const good = await passphraseProtector({ io, vaultDir: '/v', passphrase: 'correct horse battery' }).unwrap({ type: 'passphrase', createdAt: '' }, kid)
    expect(good.ok && toHex(good.dek)).toBe(toHex(dek))
    const bad = await passphraseProtector({ io, vaultDir: '/v', passphrase: 'wrong horse battery!' }).unwrap({ type: 'passphrase', createdAt: '' }, kid)
    expect(bad).toEqual({ ok: false, kind: 'denied', reason: 'wrong passphrase' })
  })
})

describe('detection and the recorded wrapper', () => {
  it('order per platform', () => {
    expect(detectionOrder('darwin', false)).toEqual(['keychain'])
    expect(detectionOrder('win32', false)).toEqual(['dpapi'])
    expect(detectionOrder('linux', true)).toEqual(['dpapi', 'libsecret', 'systemd-creds'])
    expect(detectionOrder('linux', false)).toEqual(['libsecret', 'systemd-creds'])
    expect(detectionOrder('other', false)).toEqual([])
  })
  it('takes the first that round-trips, and names every one that failed', async () => {
    const { io } = fakeIo(() => fail('secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY'), { which: { 'secret-tool': '/x', 'systemd-creds': '/y' } })
    const none = await chooseProtector([libsecretProtector(io), systemdCredsProtector(io, '/v')])
    expect(none.ok).toBe(false)
    if (!none.ok) expect(checkedList(none.checked, 'en')).toBe('libsecret — no Secret Service answered; systemd-creds — no TPM2')
    const some = await chooseProtector([libsecretProtector(io), memoryProtector()])
    expect(some.ok && some.protector.id).toBe('memory')
  })
  it('a vault never switches protector on a later failure: locked or protector-lost, never a quiet fallback', async () => {
    let up = true
    const store = new Map<string, string>()
    const { io, files } = fakeIo(c => {
      if (!up) return fail('Cannot autolaunch D-Bus')
      const acct = c.args[c.args.length - 1]!
      if (c.args[0] === 'store') { store.set(acct, c.stdin); return ok() }
      if (c.args[0] === 'lookup') return ok(store.get(acct) ?? '')
      store.delete(acct); return ok()
    }, { which: { 'secret-tool': '/x' } })
    const lib = libsecretProtector(io)
    const init = await initVault(io, '/v', lib)
    expect(init.ok).toBe(true)
    const vaultJson = text(files.get('/v/vault.json')!)
    up = false
    const locked = await openVault(io, '/v', [lib, memoryProtector()])
    expect(locked.state).toBe('locked')
    up = true
    store.clear()
    const lost = await openVault(io, '/v', [lib, memoryProtector()])
    expect(lost.state).toBe('protector-lost')
    expect(text(files.get('/v/vault.json')!)).toBe(vaultJson)
  })
  it('a passphrase wrapper beside the OS one opens the same key; rekey moves protectors explicitly', async () => {
    const { io, files } = fakeIo(() => ok())
    const mem = memoryProtector()
    const init = await initVault(io, '/v', mem)
    if (!init.ok) throw new Error('init')
    const open = await openVault(io, '/v', [mem])
    if (open.state !== 'open') throw new Error(open.state)
    await addPassphraseWrapper(io, '/v', open, passphraseProtector({ io, vaultDir: '/v', passphrase: 'a container passphrase', params: FAST }))
    __forgetMemoryKey(init.kid)
    const viaPass = await openVault(io, '/v', [mem, passphraseProtector({ io, vaultDir: '/v', passphrase: 'a container passphrase' })])
    expect(viaPass.state === 'open' && viaPass.via).toBe('passphrase')
    expect(viaPass.state === 'open' && toHex(viaPass.dek)).toBe(toHex(init.dek))
    const noPass = await openVault(io, '/v', [mem, passphraseProtector({ io, vaultDir: '/v' })])
    expect(noPass.state).toBe('protector-lost')
    if (viaPass.state !== 'open') throw new Error('x')
    const re = await rekeyVault(io, '/v', viaPass, mem, [mem])
    expect(re.ok).toBe(true)
    expect(JSON.parse(text(files.get('/v/vault.json')!)).wrappers.map((w: { type: string }) => w.type)).toEqual(['memory', 'passphrase'])
  })
})

describe('absolute paths first, PATH only as the fallback', () => {
  const evil = { 'powershell.exe': '/evil/powershell.exe', 'secret-tool': '/evil/secret-tool', 'systemd-creds': '/evil/systemd-creds' }
  it('powershell.exe on WSL', async () => {
    const { io, calls } = fakeIo(dpapiAnswer, { exists: [WSL_INTEROP, WSL_POWERSHELL], which: evil })
    await dpapiProtector({ io, vaultDir: '/v', wsl: true }).probe()
    expect(new Set(calls.map(c => c.cmd))).toEqual(new Set([WSL_POWERSHELL]))
  })
  it('secret-tool and systemd-creds', async () => {
    const a = fakeIo(() => ok(), { exists: [SECRET_TOOL_PATHS[0]], which: evil })
    await libsecretProtector(a.io).probe()
    expect(a.calls.every(c => c.cmd === SECRET_TOOL_PATHS[0])).toBe(true)
    const b = fakeIo(() => ok('no\n'), { exists: [SYSTEMD_CREDS_PATHS[0]], which: evil })
    await systemdCredsProtector(b.io, '/v').probe()
    expect(b.calls.every(c => c.cmd === SYSTEMD_CREDS_PATHS[0])).toBe(true)
  })
  it('PATH is used only when the absolute path is absent', async () => {
    const { io, calls } = fakeIo(() => ok(), { which: evil })
    await libsecretProtector(io).probe()
    expect(calls.every(c => c.cmd === '/evil/secret-tool')).toBe(true)
  })
})
