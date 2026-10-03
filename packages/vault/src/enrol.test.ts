/**
 * SECRETS.4 §12.3 (the enrolment half): presence becomes the primary and the silent OS wrapper is
 * removed ONLY after the presence wrap succeeded (its seal checked in memory by the protector) — and a crash at every step leaves the DEK
 * recoverable. Fake protectors over an in-memory io; nothing is spawned.
 */
import { describe, expect, it } from 'bun:test'
import { finishRetirement, enrollPresence, hasPresence, initVault, openVault, parseVaultJson } from './vault'
import type { Protector, ProtectorId, ProtectorIo, UnwrapResult } from './protectors/types'

class Crash extends Error {}

function memIo(crashAtWrite = -1) {
  const files = new Map<string, Uint8Array>()
  let writes = 0
  const io: ProtectorIo = {
    async run() { throw new Error('no process may be spawned here') },
    async readFile(p) { return files.get(p) ?? null },
    async writeFile(p, d) { if (writes++ === crashAtWrite) throw new Crash('crash'); files.set(p, new Uint8Array(d)) },
    async removeFile(p) { files.delete(p) },
    async createExclusive(p, d) { if (files.has(p)) return false; files.set(p, new Uint8Array(d)); return true },
    async firstExisting() { return null },
    async which() { return null },
  }
  return { io, files, arm(n: number) { writes = 0; crashAtWrite = n } }
}

/** A file-backed protector: `dek.<id>` holds the key XOR a per-protector pad (enough to tell copies apart). */
function fileProtector(id: ProtectorId, io: ProtectorIo, opts: { unwrapGives?: 'other' | 'cancel'; crashOnRemove?: boolean } = {}): Protector & { gestures: number } {
  const file = `/v/dek.${id}`
  const pad = id.charCodeAt(0)
  const self = {
    id, gestures: 0,
    label: () => id,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array) {
      await io.writeFile(file, dek.map(b => b ^ pad))
      return { ok: true as const, record: { type: id, createdAt: 'x', params: { file } } }
    },
    async unwrap(): Promise<UnwrapResult> {
      self.gestures++
      if (opts.unwrapGives === 'cancel') return { ok: false, kind: 'denied', reason: 'presence-cancelled' }
      const raw = await io.readFile(file)
      if (!raw) return { ok: false, kind: 'missing', reason: 'gone' }
      const dek = raw.map(b => b ^ pad)
      if (opts.unwrapGives === 'other') dek[0] = dek[0]! ^ 1
      return { ok: true, dek }
    },
    async remove() { if (opts.crashOnRemove) throw new Crash('crash'); await io.removeFile(file) },
  }
  return self
}

async function setup(crashAtWrite = -1) {
  const m = memIo()
  const dpapi = fileProtector('dpapi', m.io)
  const init = await initVault(m.io, '/v', dpapi)
  if (!init.ok) throw new Error('init')
  const open = await openVault(m.io, '/v', [dpapi])
  if (open.state !== 'open') throw new Error('open')
  m.arm(crashAtWrite)
  return { ...m, dpapi, open, dek: new Uint8Array(init.dek) }
}

describe('enrollPresence', () => {
  it('makes presence primary with NO verifying gesture, then removes the silent wrapper (owner decision 2026-10-02)', async () => {
    const { io, files, dpapi, open, dek } = await setup()
    const hello = fileProtector('hello', io)
    const r = await enrollPresence(io, '/v', open, hello, [dpapi, hello])
    expect(r.ok).toBe(true)
    expect(hello.gestures).toBe(0) // the enrolment is wrap only (create + ONE sign); no unwrap
    const v = parseVaultJson(files.get('/v/vault.json')!)!
    expect(v.v).toBe(2)
    expect(v.wrappers.map(w => w.type)).toEqual(['hello'])
    expect(v.retired).toBeUndefined()
    expect(hasPresence(v)).toBe(true)
    expect(files.has('/v/dek.dpapi')).toBe(false)
    // The FIRST real unlock is the reproducibility check — one gesture.
    const o = await openVault(io, '/v', [dpapi, hello])
    expect(o.state === 'open' && o.via).toBe('hello')
    expect(hello.gestures).toBe(1)
    if (o.state === 'open') expect([...o.dek]).toEqual([...dek])
  })

  it('a wrap that fails leaves the silent wrapper and the vault file exactly as they were', async () => {
    const { io, files, dpapi, open } = await setup()
    const before = files.get('/v/vault.json')
    const bad = { ...fileProtector('hello', io), async wrap() { return { ok: false as const, reason: 'presence-cancelled' } } }
    const r = await enrollPresence(io, '/v', open, bad, [dpapi, bad])
    expect(r).toMatchObject({ ok: false, step: 'wrap' })
    expect(files.get('/v/vault.json')).toEqual(before)
    expect(files.has('/v/dek.dpapi')).toBe(true)
  })

  // Writes during enrolment: 0 = dek.hello, 1 = vault.json (presence + retired), 2 = vault.json (retired cleared).
  for (const at of [0, 1, 2]) {
    it(`a crash at write #${at} never loses the DEK, and the next open finishes the job`, async () => {
      const { io, files, dpapi, open, dek } = await setup(at)
      const hello = fileProtector('hello', io)
      await enrollPresence(io, '/v', open, hello, [dpapi, hello]).catch(e => { if (!(e instanceof Crash)) throw e })
      const o = await openVault(io, '/v', [dpapi, hello])
      expect(o.state).toBe('open')
      if (o.state !== 'open') return
      expect([...o.dek]).toEqual([...dek])
      const fin = await finishRetirement(io, '/v', o.vault, [dpapi, hello])
      if (hasPresence(fin.vault)) {
        // Presence was recorded: the silent copy must be gone once the retirement is finished.
        expect(files.has('/v/dek.dpapi')).toBe(false)
        expect(fin.vault.retired).toBeUndefined()
      } else {
        // Presence was never recorded: the silent wrapper is still the way in.
        expect(files.has('/v/dek.dpapi')).toBe(true)
      }
    })
  }

  it('a crash while removing the silent key leaves it listed in `retired`, finished later', async () => {
    const { io, files, open } = await setup()
    const flaky = fileProtector('dpapi', io, { crashOnRemove: true })
    const hello = fileProtector('hello', io)
    await enrollPresence(io, '/v', open, hello, [flaky, hello]).catch(e => { if (!(e instanceof Crash)) throw e })
    const v = parseVaultJson(files.get('/v/vault.json')!)!
    expect(v.wrappers.map(w => w.type)).toEqual(['hello'])
    expect(v.retired?.map(w => w.type)).toEqual(['dpapi'])
    const fixed = fileProtector('dpapi', io)
    const fin = await finishRetirement(io, '/v', v, [fixed, hello])
    expect(fin.removed).toEqual(['dpapi'])
    expect(files.has('/v/dek.dpapi')).toBe(false)
  })

  it('a second presence credential keeps the first; a cancelled gesture on the first is not re-asked through the second', async () => {
    const { io, dpapi, open } = await setup()
    const hello = fileProtector('hello', io)
    const r1 = await enrollPresence(io, '/v', open, hello, [dpapi, hello])
    if (!r1.ok) throw new Error('enrol')
    const o1 = await openVault(io, '/v', [hello])
    if (o1.state !== 'open') throw new Error('open')
    const key = fileProtector('fido2', io)
    const r2 = await enrollPresence(io, '/v', o1, key, [hello, key])
    expect(r2.ok && r2.vault.wrappers.map(w => w.type)).toEqual(['fido2', 'hello'])
    const cancelFido = fileProtector('fido2', io, { unwrapGives: 'cancel' })
    const hello2 = fileProtector('hello', io)
    const o = await openVault(io, '/v', [cancelFido, hello2])
    expect(o.state).toBe('locked')
    expect(hello2.gestures).toBe(0)
  })

  it('refuses a non-presence protector and the runner scope', async () => {
    const { io, dpapi, open } = await setup()
    expect((await enrollPresence(io, '/v', open, dpapi, [dpapi])).ok).toBe(false)
    const hello = fileProtector('hello', io)
    const runner = { ...open, vault: { ...open.vault, scope: 'cloud-runner' as const } }
    expect((await enrollPresence(io, '/v', runner, hello, [hello])).ok).toBe(false)
  })

  it('a v1 file claiming a presence wrapper is not a vault this code reads', () => {
    expect(parseVaultJson(JSON.stringify({ v: 1, kid: '0123456789abcdef', createdAt: 'x', wrappers: [{ type: 'hello', createdAt: 'x' }] }))).toBe(null)
  })
})
