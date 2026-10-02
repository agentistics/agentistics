/**
 * SECRETS.4 §12.1 — the two scopes. Pure, in-memory protector only.
 */
import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { HOST_PURPOSES, HUMAN_EXTRA_PURPOSES, isPurpose, scopeOfPurpose } from './format'
import { makeHandle } from './handle'
import { newDataKey, openRecord, sealRecord, sealToBytes } from './seal'
import { initVault, openVault, parseVaultJson, serializeVaultJson, VAULT_VERSION, VAULT_VERSION_SCOPED } from './vault'
import { memoryProtector } from './protectors/memory'
import type { ProtectorIo } from './protectors/types'

const MARKER = 'TEST-NOT-A-SECRET-' + randomBytes(8).toString('hex')
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

function memIo(): ProtectorIo {
  const files = new Map<string, Uint8Array>()
  return {
    async run() { throw new Error('no process may be spawned here') },
    async readFile(p) { return files.get(p) ?? null },
    async writeFile(p, d) { files.set(p, new Uint8Array(d)) },
    async removeFile(p) { files.delete(p) },
    async createExclusive(p, d) { if (files.has(p)) return false; files.set(p, new Uint8Array(d)); return true },
    async firstExisting() { return null },
    async which() { return null },
  }
}

describe('purpose → scope map (closed)', () => {
  it('is total over every known purpose', () => {
    for (const p of [...HOST_PURPOSES, ...HUMAN_EXTRA_PURPOSES, 'engine/provider-key']) expect(scopeOfPurpose(p)).toBe('human')
    expect(scopeOfPurpose('vault/totp-seed')).toBe('human')
    expect(scopeOfPurpose('cloud-runner/identity')).toBe('cloud-runner')
    expect(scopeOfPurpose('cloud-runner/refresh')).toBe('cloud-runner')
  })
  it('refuses an unknown purpose, a path-shaped one and a non-string', () => {
    for (const p of ['', 'nope', 'cloud-runner/', 'cloud-runner/../x', 'engine/', 'vault/other', 'CLOUD-RUNNER/x', 42, null]) {
      expect(scopeOfPurpose(p)).toBe(null)
      expect(isPurpose(p)).toBe(false)
    }
  })
})

describe('seal under one scope, open under the other', () => {
  it('a human purpose under the runner scope is `purpose`, refused before any crypto', () => {
    const { dek, kid } = newDataKey()
    const bytes = sealToBytes({ dek, kid, purpose: 'github-backup', name: 'n', plaintext: enc(MARKER) })
    expect(openRecord({ dek, kid, scope: 'cloud-runner', purpose: 'github-backup', name: 'n', bytes })).toEqual({ ok: false, code: 'purpose' })
    expect(() => sealRecord({ dek, kid, scope: 'cloud-runner', purpose: 'central-token', name: 'n', plaintext: enc(MARKER) })).toThrow()
    expect(() => sealRecord({ dek, kid, scope: 'human', purpose: 'cloud-runner/identity', name: 'n', plaintext: enc(MARKER) })).toThrow()
  })

  it('bypassing the check, the other DEK fails anyway: wrong-machine by kid, tampered with a forged kid', () => {
    const human = newDataKey()
    const runner = newDataKey()
    const bytes = sealToBytes({ dek: human.dek, kid: human.kid, purpose: 'github-backup', name: 'n', plaintext: enc(MARKER) })
    const a = openRecord({ dek: runner.dek, kid: runner.kid, scope: 'human', purpose: 'github-backup', name: 'n', bytes })
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.code).toBe('wrong-machine')
    // The runner DEK presented under the human kid: the AAD binds the kid, the subkey is different.
    const b = openRecord({ dek: runner.dek, kid: human.kid, scope: 'human', purpose: 'github-backup', name: 'n', bytes })
    expect(b).toEqual({ ok: false, code: 'tampered' })
  })
})

describe('the runner handle', () => {
  it('cannot open ANY human purpose (runtime), and cannot even name one (type)', () => {
    const human = newDataKey()
    const runner = newDataKey()
    const h = makeHandle('cloud-runner', runner.dek, runner.kid)
    for (const p of [...HOST_PURPOSES, ...HUMAN_EXTRA_PURPOSES, 'engine/provider-key']) {
      const bytes = sealToBytes({ dek: human.dek, kid: human.kid, purpose: p, name: 'n', plaintext: enc(MARKER) })
      // @ts-expect-error — a human purpose is not a RunnerPurpose: the runner path cannot name it.
      const r = h.open(p, 'n', bytes)
      expect(r).toEqual({ ok: false, code: 'purpose' })
      // @ts-expect-error — same for seal.
      expect(() => h.seal(p, 'n', enc(MARKER))).toThrow()
    }
  })

  it('round-trips its own purposes, and the human handle cannot read them', () => {
    const runner = newDataKey()
    const human = newDataKey()
    const r = makeHandle('cloud-runner', runner.dek, runner.kid)
    const h = makeHandle('human', human.dek, human.kid)
    const bytes = r.seal('cloud-runner/refresh', 'n', enc(MARKER))
    const back = r.open('cloud-runner/refresh', 'n', bytes)
    expect(back.ok && dec(back.plaintext)).toBe(MARKER)
    // @ts-expect-error — and the human handle cannot name a runner purpose either.
    expect(h.open('cloud-runner/refresh', 'n', bytes)).toEqual({ ok: false, code: 'purpose' })
  })

  it('keeps its own copy of the DEK and close() zeroes it', () => {
    const { dek, kid } = newDataKey()
    const h = makeHandle('human', dek, kid)
    const bytes = h.seal('central-token', 'n', enc(MARKER))
    dek.fill(0) // the caller's copy going away does not break the handle
    expect(h.open('central-token', 'n', bytes).ok).toBe(true)
    h.close()
    expect(h.closed).toBe(true)
    expect(h.open('central-token', 'n', bytes)).toEqual({ ok: false, code: 'closed' })
    expect(() => h.seal('central-token', 'n', enc(MARKER))).toThrow()
  })
})

describe('vault.json v1 / v2', () => {
  it('a v1 file reads as the human scope', () => {
    const v = parseVaultJson(JSON.stringify({ v: 1, kid: '0123456789abcdef', createdAt: 'x', wrappers: [{ type: 'dpapi', createdAt: 'x' }] }))
    expect(v?.scope).toBe('human')
    expect(v?.v).toBe(VAULT_VERSION)
  })
  it('a v2 file must name a known scope', () => {
    const base = { v: 2, kid: '0123456789abcdef', createdAt: 'x', wrappers: [{ type: 'memory', createdAt: 'x' }] }
    expect(parseVaultJson(JSON.stringify({ ...base, scope: 'cloud-runner', machineId: 'm1' }))?.scope).toBe('cloud-runner')
    expect(parseVaultJson(JSON.stringify(base))).toBe(null)
    expect(parseVaultJson(JSON.stringify({ ...base, scope: 'root' }))).toBe(null)
  })
  it('a plain human vault is still WRITTEN as v1 (downgrade safety); a runner vault as v2', () => {
    const human = parseVaultJson(serializeVaultJson({ v: VAULT_VERSION, scope: 'human', kid: '0123456789abcdef', createdAt: 'x', wrappers: [{ type: 'dpapi', createdAt: 'x' }] }))!
    expect(JSON.parse(dec(serializeVaultJson(human))).v).toBe(1)
    expect(JSON.parse(dec(serializeVaultJson(human))).scope).toBeUndefined()
    const runner = { v: VAULT_VERSION_SCOPED as 2, scope: 'cloud-runner' as const, kid: '0123456789abcdef', createdAt: 'x', wrappers: [{ type: 'memory' as const, createdAt: 'x' }], machineId: 'm1' }
    expect(JSON.parse(dec(serializeVaultJson(runner)))).toMatchObject({ v: 2, scope: 'cloud-runner', machineId: 'm1' })
  })
})

describe('two vaults, two DEKs', () => {
  it('initVault makes a separate runner vault (v2, own kid) and each opens only as its own scope', async () => {
    const io = memIo()
    const h = await initVault(io, '/vault', memoryProtector())
    const r = await initVault(io, '/vault-runner', memoryProtector(), [], new Date(), { scope: 'cloud-runner', machineId: 'machine-1' })
    expect(h.ok && r.ok).toBe(true)
    if (!h.ok || !r.ok) return
    expect(h.kid).not.toBe(r.kid)
    expect(Buffer.from(h.dek).equals(Buffer.from(r.dek))).toBe(false)
    expect(h.vault.v).toBe(1)
    expect(r.vault).toMatchObject({ v: 2, scope: 'cloud-runner', machineId: 'machine-1' })
    expect((await openVault(io, '/vault', [memoryProtector()])).state).toBe('open')
    expect((await openVault(io, '/vault-runner', [memoryProtector()], 'cloud-runner')).state).toBe('open')
    // Each directory refuses to open as the other scope.
    expect((await openVault(io, '/vault-runner', [memoryProtector()])).state).toBe('corrupt')
    expect((await openVault(io, '/vault', [memoryProtector()], 'cloud-runner')).state).toBe('corrupt')
  })
  it('a runner vault without a machine id is refused', async () => {
    const r = await initVault(memIo(), '/vr', memoryProtector(), [], new Date(), { scope: 'cloud-runner' })
    expect(r.ok).toBe(false)
  })
  it('a v1 vault written by SECRETS.2 opens unchanged', async () => {
    const io = memIo()
    const made = await initVault(io, '/v', memoryProtector())
    if (!made.ok) throw new Error('init')
    const raw = dec((await io.readFile('/v/vault.json'))!)
    expect(JSON.parse(raw).v).toBe(1)
    const o = await openVault(io, '/v', [memoryProtector()])
    expect(o.state).toBe('open')
    if (o.state === 'open') expect(Buffer.from(o.dek).equals(Buffer.from(made.dek))).toBe(true)
  })
})
