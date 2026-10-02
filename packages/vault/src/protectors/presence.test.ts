import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { helloProtector, HELLO_ARGS, HELLO_FILE, HELLO_SCRIPT, helloCredentialName } from './hello'
import { fido2Protector, FIDO2_FILE, WEBAUTHN_ARGS, WEBAUTHN_SCRIPT, cliFailure } from './fido2'
import { WSL_INTEROP, WSL_POWERSHELL } from './dpapi'
import { presenceCode, presenceSentence, kindOf, deriveKek, sealDek, openDek } from './presence'
import { bytes, text, type ProtectorIo, type RunResult, type WrapperRecord } from './types'

interface Call { cmd: string; args: readonly string[]; stdin: string }

function fakeIo(answer: (c: Call) => RunResult | Promise<RunResult>, opts: { exists?: string[]; which?: Record<string, string> } = {}) {
  const files = new Map<string, Uint8Array>()
  const calls: Call[] = []
  const secretsSeen = new Set<string>()
  const io: ProtectorIo = {
    async run(cmd, args, stdin) {
      const s = stdin ? text(stdin) : ''
      for (const tok of s.split(/[\s\n]+/).filter(t => t.length >= 16)) secretsSeen.add(tok)
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
const fail = (stderr: string, code = 3): RunResult => ({ code, stdout: new Uint8Array(), stderr })
const DEK = new Uint8Array(32).fill(7)
function rec(w: { ok: boolean } & Partial<{ record: WrapperRecord }>): WrapperRecord { if (!w.record) throw new Error('wrap failed'); return w.record }

/** A fake Hello: a credential registry and a deterministic "signature" = sha256(name | challenge). */
function helloMachine(opts: { sign?: () => RunResult | null } = {}) {
  const creds = new Set<string>()
  const answer = (c: Call): RunResult => {
    const [verb, nameB64, chal] = c.stdin.split('\n')
    const name = Buffer.from(nameB64!, 'base64').toString()
    if (verb === 'check') return ok('ok')
    if (verb === 'create') { creds.add(name); return ok('ok') }
    if (verb === 'delete') { creds.delete(name); return ok('ok') }
    if (!creds.has(name)) return fail('PRESENCE-ERROR lost the credential was deleted')
    const forced = opts.sign?.()
    if (forced) return forced
    return ok(createHash('sha256').update(name + '|' + chal).digest().toString('base64'))
  }
  return { creds, answer }
}
const WSL = { exists: [WSL_INTEROP, WSL_POWERSHELL] }

describe('hello', () => {
  it('runs the fixed script; only verb, name and challenge on stdin; wrap → unwrap round trips', async () => {
    const m = helloMachine()
    const { io, calls, files } = fakeIo(m.answer, WSL)
    const p = helloProtector({ io, vaultDir: '/v', wsl: true })
    const w = await p.wrap(DEK, 'k1')
    expect(w.ok).toBe(true)
    expect(calls.every(c => c.cmd === WSL_POWERSHELL && JSON.stringify(c.args) === JSON.stringify(HELLO_ARGS))).toBe(true)
    expect(HELLO_SCRIPT).not.toMatch(/[A-Za-z0-9+/]{40,}/)
    expect(files.has(`/v/${HELLO_FILE}`)).toBe(true)
    expect(text(files.get(`/v/${HELLO_FILE}`)!)).not.toContain(Buffer.from(DEK).toString('hex'))
    const u = await p.unwrap(rec(w), 'k1')
    expect(u.ok && Buffer.from(u.dek).equals(Buffer.from(DEK))).toBe(true)
  })

  it('same signature → same KEK; a different challenge → a different KEK', () => {
    const sig = (name: string, chal: string) => createHash('sha256').update(name + '|' + chal).digest()
    const a = deriveKek(sig('n', 'c1'), 'k', 'hello')
    expect(Buffer.from(deriveKek(sig('n', 'c1'), 'k', 'hello')).equals(Buffer.from(a))).toBe(true)
    expect(Buffer.from(deriveKek(sig('n', 'c2'), 'k', 'hello')).equals(Buffer.from(a))).toBe(false)
    expect(Buffer.from(deriveKek(sig('n', 'c1'), 'k2', 'hello')).equals(Buffer.from(a))).toBe(false)
    const sealed = sealDek(a, DEK, 'hello', 'k')
    expect(openDek(a, sealed, 'hello', 'k')).not.toBeNull()
    expect(openDek(a, sealed, 'hello', 'other-kid')).toBeNull() // AAD binds the kid
    expect(openDek(a, sealed, 'fido2', 'k')).toBeNull() // and the type
  })

  const cases: [string, string, string, 'missing' | 'unavailable' | 'denied'][] = [
    ['cancel', 'PRESENCE-ERROR cancelled', 'presence-cancelled', 'denied'],
    ['timeout', 'PRESENCE-ERROR timeout', 'presence-timeout', 'unavailable'],
    ['unavailable', 'PRESENCE-ERROR unavailable Windows Hello answered SecurityDeviceLocked', 'presence-unavailable', 'unavailable'],
    ['credential deleted', 'PRESENCE-ERROR lost the credential was deleted', 'presence-lost', 'missing'],
    ['unparseable bridge failure', 'some profile script blew up', 'presence-unavailable', 'unavailable'],
  ]
  for (const [name, stderr, code, kind] of cases) {
    it(`unwrap: ${name} → ${code}`, async () => {
      const m = helloMachine()
      const { io } = fakeIo(m.answer, WSL)
      const p = helloProtector({ io, vaultDir: '/v', wsl: true })
      const w = await p.wrap(DEK, 'k1')
      const bad = fakeIo(() => fail(stderr), WSL)
      bad.files.set(`/v/${HELLO_FILE}`, (await io.readFile(`/v/${HELLO_FILE}`))!)
      const u = await helloProtector({ io: bad.io, vaultDir: '/v', wsl: true }).unwrap(rec(w), 'k1')
      expect(u.ok).toBe(false)
      if (!u.ok) {
        expect(presenceCode(u.reason)).toBe(code as never)
        expect(u.kind).toBe(kind)
        expect(kindOf(code as never)).toBe(kind)
      }
    })
  }

  it('a recreated credential (signature differs) is presence-lost; a missing file too', async () => {
    const m = helloMachine()
    const { io, files } = fakeIo(m.answer, WSL)
    const p = helloProtector({ io, vaultDir: '/v', wsl: true })
    const w = await p.wrap(DEK, 'k1')
    const f = JSON.parse(text(files.get(`/v/${HELLO_FILE}`)!))
    f.challenge = Buffer.from('another challenge entirely, 32 by').toString('base64')
    files.set(`/v/${HELLO_FILE}`, bytes(JSON.stringify(f)))
    const u = await p.unwrap(rec(w), 'k1')
    expect(!u.ok && presenceCode(u.reason)).toBe('presence-lost')
    files.delete(`/v/${HELLO_FILE}`)
    const u2 = await p.unwrap(rec(w), 'k1')
    expect(!u2.ok && u2.kind).toBe('missing')
  })

  it('wrap that is cancelled or fails to sign leaves no file and no credential behind', async () => {
    const m = helloMachine({ sign: () => fail('PRESENCE-ERROR cancelled') })
    const { io, files } = fakeIo(m.answer, WSL)
    const w = await helloProtector({ io, vaultDir: '/v', wsl: true }).wrap(DEK, 'k1')
    expect(!w.ok && presenceCode(w.reason)).toBe('presence-cancelled')
    expect(files.size).toBe(0)
    expect(m.creds.size).toBe(0)
  })

  it('probe proves determinism, cleans up, and says so when the signature varies', async () => {
    const m = helloMachine()
    const { io } = fakeIo(m.answer, WSL)
    expect((await helloProtector({ io, vaultDir: '/v', wsl: true }).probe()).ok).toBe(true)
    expect(m.creds.size).toBe(0)
    let n = 0
    const m2 = helloMachine({ sign: () => ok(Buffer.from(`sig${n++}`).toString('base64')) })
    const r = await helloProtector({ io: fakeIo(m2.answer, WSL).io, vaultDir: '/v', wsl: true }).probe()
    expect(!r.ok && r.reason).toContain('signs differently')
    expect(m2.creds.size).toBe(0)
  })

  it('no interop / no powershell → unavailable, nothing run; native Windows uses SystemRoot first', async () => {
    const a = fakeIo(() => ok(), { exists: [WSL_POWERSHELL] })
    const r = await helloProtector({ io: a.io, vaultDir: '/v', wsl: true }).probe()
    expect(r.ok).toBe(false)
    expect(a.calls).toHaveLength(0)
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const b = fakeIo(helloMachine().answer, { exists: [ps], which: { 'powershell.exe': 'C:\\evil\\powershell.exe' } })
    await helloProtector({ io: b.io, vaultDir: 'C:\\v', wsl: false }).wrap(DEK, 'k')
    expect(b.calls.every(c => c.cmd === ps)).toBe(true)
  })

  it('a throwing run (host timeout) maps to presence-timeout', async () => {
    const m = helloMachine()
    const { io } = fakeIo(m.answer, WSL)
    const p = helloProtector({ io, vaultDir: '/v', wsl: true })
    const w = await p.wrap(DEK, 'k1')
    const t = fakeIo(() => { throw new Error('timed out after 65000 ms') }, WSL)
    t.files.set(`/v/${HELLO_FILE}`, (await io.readFile(`/v/${HELLO_FILE}`))!)
    const u = await helloProtector({ io: t.io, vaultDir: '/v', wsl: true }).unwrap(rec(w), 'k1')
    expect(!u.ok && presenceCode(u.reason)).toBe('presence-timeout')
  })

  it('remove deletes the credential and the file; the name is per vault', async () => {
    const m = helloMachine()
    const { io, files } = fakeIo(m.answer, WSL)
    const p = helloProtector({ io, vaultDir: '/v', wsl: true })
    const w = await p.wrap(DEK, 'k1')
    expect(m.creds.has(helloCredentialName('k1'))).toBe(true)
    await p.remove(rec(w), 'k1')
    expect(m.creds.size).toBe(0)
    expect(files.size).toBe(0)
  })
})

describe('sentences', () => {
  it('every code renders en + pt with the presence word and no secret', () => {
    for (const c of ['presence-cancelled', 'presence-timeout', 'presence-unavailable', 'presence-lost'] as const) {
      expect(presenceSentence(c, 'en', 'Windows Hello', `${c}: why`)).toContain('Windows Hello')
      expect(presenceSentence(c, 'pt', 'o Windows Hello', 'why')).toContain('o Windows Hello')
    }
    expect(presenceSentence('presence-lost', 'en', 'your security key', 'presence-lost: gone')).toContain('(gone)')
  })
})

// ---- FIDO2 ----

const DEVICE_LINE = '/dev/hidraw3: vendor=0x1050, product=0x0407 (Yubico YubiKey)\n'
function cliMachine(opts: { hmac?: boolean; devices?: boolean; assertErr?: string } = {}) {
  const hmac = opts.hmac ?? true
  const answer = (c: Call): RunResult => {
    if (c.cmd.endsWith('fido2-token')) {
      if (c.args[0] === '-L') return opts.devices === false ? ok('') : ok(DEVICE_LINE)
      return ok(`extension strings: credProtect${hmac ? ', hmac-secret' : ''}\n`)
    }
    if (c.cmd.endsWith('fido2-cred')) return ok(['cdh', 'agentistics-vault', 'packed', 'authdata', 'Y3JlZGVudGlhbC1pZC1BQUFBQUFBQQ==', 'sig'].join('\n') + '\n')
    const [, , credId, salt] = c.stdin.split('\n')
    if (opts.assertErr) return fail(opts.assertErr, 1)
    // hmac-secret = sha256(credId | salt): deterministic, key-bound
    return ok(['cdh', 'rp', 'authdata', createHash('sha256').update(credId + '|' + salt).digest().toString('base64'), 'sig'].join('\n') + '\n')
  }
  return { answer }
}
const TOOLS = ['/usr/bin/fido2-token', '/usr/bin/fido2-cred', '/usr/bin/fido2-assert']

describe('fido2 (libfido2 CLIs)', () => {
  it('wrap → unwrap with a deterministic hmac-secret; absolute tool paths; payload on stdin only', async () => {
    const { io, calls, files } = fakeIo(cliMachine().answer, { exists: TOOLS, which: { 'fido2-assert': '/tmp/evil/fido2-assert' } })
    const p = fido2Protector({ io, vaultDir: '/v', transport: 'cli' })
    const w = await p.wrap(DEK, 'k1')
    expect(w.ok).toBe(true)
    expect(calls.map(c => c.cmd).every(c => c.startsWith('/usr/bin/'))).toBe(true)
    expect(calls.find(c => c.cmd.endsWith('fido2-assert'))!.args).toEqual(['-G', '-h', '/dev/hidraw3'])
    expect(files.has(`/v/${FIDO2_FILE}`)).toBe(true)
    const u = await p.unwrap(rec(w), 'k1')
    expect(u.ok && Buffer.from(u.dek).equals(Buffer.from(DEK))).toBe(true)
  })

  it('a key WITHOUT hmac-secret is refused at enrol, in words, and nothing is stored', async () => {
    const { io, files, calls } = fakeIo(cliMachine({ hmac: false }).answer, { exists: TOOLS })
    const p = fido2Protector({ io, vaultDir: '/v', transport: 'cli' })
    const w = await p.wrap(DEK, 'k1')
    expect(!w.ok && w.reason).toContain('does not support hmac-secret')
    expect(files.size).toBe(0)
    expect(calls.some(c => c.cmd.endsWith('fido2-cred'))).toBe(false)
    const pr = await p.probe()
    expect(!pr.ok && pr.reason).toContain('hmac-secret')
  })

  it('missing tools say how to install them; no key plugged in is unavailable', async () => {
    const a = await fido2Protector({ io: fakeIo(() => ok()).io, vaultDir: '/v', transport: 'cli' }).probe()
    expect(!a.ok && a.reason).toContain('apt install fido2-tools')
    const b = await fido2Protector({ io: fakeIo(cliMachine({ devices: false }).answer, { exists: TOOLS }).io, vaultDir: '/v', transport: 'cli' }).probe()
    expect(!b.ok && presenceCode(b.reason)).toBe('presence-unavailable')
  })

  it('maps libfido2 errors to §3.5 codes', async () => {
    expect(cliFailure('fido_dev_get_assert: FIDO_ERR_ACTION_TIMEOUT').code).toBe('presence-timeout')
    expect(cliFailure('FIDO_ERR_OPERATION_DENIED').code).toBe('presence-cancelled')
    expect(cliFailure('FIDO_ERR_NO_CREDENTIALS').code).toBe('presence-lost')
    expect(cliFailure('FIDO_ERR_TX').code).toBe('presence-unavailable')
    for (const [err, code] of [['FIDO_ERR_ACTION_TIMEOUT', 'presence-timeout'], ['FIDO_ERR_OPERATION_DENIED', 'presence-cancelled'], ['FIDO_ERR_NO_CREDENTIALS', 'presence-lost']] as const) {
      const w = fakeIo(cliMachine().answer, { exists: TOOLS })
      const p = fido2Protector({ io: w.io, vaultDir: '/v', transport: 'cli' })
      const wr = await p.wrap(DEK, 'k1')
      const bad = fakeIo(cliMachine({ assertErr: err }).answer, { exists: TOOLS })
      bad.files.set(`/v/${FIDO2_FILE}`, w.files.get(`/v/${FIDO2_FILE}`)!)
      const u = await fido2Protector({ io: bad.io, vaultDir: '/v', transport: 'cli' }).unwrap(rec(wr), 'k1')
      expect(!u.ok && presenceCode(u.reason)).toBe(code)
    }
  })

  it('a different key (different hmac) opens nothing: presence-lost', async () => {
    const w = fakeIo(cliMachine().answer, { exists: TOOLS })
    const p = fido2Protector({ io: w.io, vaultDir: '/v', transport: 'cli' })
    const wr = await p.wrap(DEK, 'k1')
    const f = JSON.parse(text(w.files.get(`/v/${FIDO2_FILE}`)!))
    f.salt = Buffer.from('a different salt than the enrolled').toString('base64')
    w.files.set(`/v/${FIDO2_FILE}`, bytes(JSON.stringify(f)))
    const u = await p.unwrap(rec(wr), 'k1')
    expect(!u.ok && presenceCode(u.reason)).toBe('presence-lost')
  })
})

describe('fido2 (webauthn.dll bridge, Windows / WSL)', () => {
  function bridgeMachine(opts: { noHmac?: boolean } = {}) {
    return (c: Call): RunResult => {
      const [verb, a, salt] = c.stdin.split('\n')
      if (verb === 'check') return ok('ok')
      if (verb === 'make') return opts.noHmac ? fail('PRESENCE-ERROR no-hmac-secret x') : ok('Y3JlZC1pZC1mcm9tLXdpbmRvd3M=')
      return ok(createHash('sha256').update(a + '|' + salt).digest().toString('base64'))
    }
  }
  it('uses the absolute powershell, the fixed script, stdin-only payload; round trips', async () => {
    const { io, calls } = fakeIo(bridgeMachine(), WSL)
    const p = fido2Protector({ io, vaultDir: '/v', transport: 'webauthn', wsl: true })
    const w = await p.wrap(DEK, 'k1')
    expect(w.ok).toBe(true)
    expect(calls.every(c => c.cmd === WSL_POWERSHELL && JSON.stringify(c.args) === JSON.stringify(WEBAUTHN_ARGS))).toBe(true)
    expect(WEBAUTHN_SCRIPT).toContain('webauthn.dll')
    const u = await p.unwrap(rec(w), 'k1')
    expect(u.ok && Buffer.from(u.dek).equals(Buffer.from(DEK))).toBe(true)
  })
  it('refuses a key without hmac-secret at enrol, and an interop-off WSL is unavailable', async () => {
    const a = await fido2Protector({ io: fakeIo(bridgeMachine({ noHmac: true }), WSL).io, vaultDir: '/v', transport: 'webauthn', wsl: true }).wrap(DEK, 'k')
    expect(!a.ok && a.reason).toContain('does not support hmac-secret')
    const n = fakeIo(bridgeMachine(), { exists: [WSL_POWERSHELL] })
    const b = await fido2Protector({ io: n.io, vaultDir: '/v', transport: 'webauthn', wsl: true }).probe()
    expect(!b.ok && presenceCode(b.reason)).toBe('presence-unavailable')
    expect(n.calls).toHaveLength(0)
  })
})
