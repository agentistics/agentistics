import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMachineSecrets } from './machine-secrets'
import { readMachineId } from './machine-secrets-host'
import { excludeFor } from '../backup/backup-plan'
import type { Protector, UnwrapResult, WrapperRecord } from '@agentistics/vault'

const KEY = 'TEST-NOT-A-SECRET-eleven-0123456789'
const pt = () => new TextEncoder().encode(KEY)
const fresh = async () => join(await mkdtemp(join(tmpdir(), 'machine-secrets-')), 'machine')

/** A fake silent protector: keeps the wrapped key in memory, can be made to lose it or to go away. */
function fakeProtector(id: 'dpapi' | 'libsecret' = 'dpapi', behaviour: { probe?: boolean; unwrap?: 'ok' | 'missing' | 'unavailable' } = {}): Protector & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  return {
    id, store,
    label: () => `fake ${id}`,
    probe: async () => (behaviour.probe === false ? { ok: false, reason: 'nope' } : { ok: true }),
    wrap: async (dek: Uint8Array, kid: string) => { store.set(kid, new Uint8Array(dek)); return { ok: true, record: { type: id, createdAt: 'now', params: { kid } } as WrapperRecord } },
    unwrap: async (_rec: WrapperRecord, kid: string): Promise<UnwrapResult> => {
      if (behaviour.unwrap === 'unavailable') return { ok: false, kind: 'unavailable', reason: 'down' }
      const v = store.get(kid)
      return behaviour.unwrap === 'missing' || !v ? { ok: false, kind: 'missing', reason: 'gone' } : { ok: true, dek: new Uint8Array(v) }
    },
    remove: async () => {},
  } as unknown as Protector & { store: Map<string, Uint8Array> }
}

describe('machineSecrets (engine-api 1.23)', () => {
  test('seals and opens with NO vault involved; the sealed bytes hold no plaintext; a fresh buffer per open', async () => {
    const dir = await fresh()
    const ms = createMachineSecrets({ dir, protectors: () => [fakeProtector()], machineId: () => null })
    expect(ms.status().available).toBe(false) // nothing settled yet
    const sealed = await ms.seal('engine/voice-elevenlabs-key', 'elevenlabs', pt())
    expect(sealed.ok).toBe(true); if (!sealed.ok) return
    expect(Buffer.from(sealed.sealed).includes(Buffer.from(KEY))).toBe(false)
    const a = await ms.open('engine/voice-elevenlabs-key', 'elevenlabs', sealed.sealed)
    const b = await ms.open('engine/voice-elevenlabs-key', 'elevenlabs', sealed.sealed)
    expect(a.ok && b.ok).toBe(true); if (!a.ok || !b.ok) return
    expect(new TextDecoder().decode(a.plaintext)).toBe(KEY)
    a.plaintext.fill(0)
    expect(new TextDecoder().decode(b.plaintext)).toBe(KEY) // zeroing one copy leaves the other, and the next open
    expect(ms.status()).toMatchObject({ available: true, strength: 'os', protector: 'fake dpapi', sentence: null })
  })

  test('survives a restart: a new instance over the same directory opens what the old one sealed', async () => {
    const dir = await fresh(), p = fakeProtector()
    const one = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    const sealed = await one.seal('engine/provider-key', 'openrouter', pt()); if (!sealed.ok) throw new Error('seal')
    one.dispose()
    const two = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    expect(await two.ready()).toMatchObject({ available: true })
    const o = await two.open('engine/provider-key', 'openrouter', sealed.sealed)
    expect(o.ok && new TextDecoder().decode(o.plaintext)).toBe(KEY)
  })

  test('WRONG MACHINE: a blob sealed elsewhere (another machine key) is refused, with a fixed sentence', async () => {
    const mine = createMachineSecrets({ dir: await fresh(), protectors: () => [fakeProtector()], machineId: () => null })
    const theirs = createMachineSecrets({ dir: await fresh(), protectors: () => [fakeProtector()], machineId: () => null })
    const s = await theirs.seal('engine/voice-elevenlabs-key', 'elevenlabs', pt()); if (!s.ok) throw new Error('seal')
    await mine.seal('engine/voice-elevenlabs-key', 'other', pt()) // mine has a machine key of its own
    const r = await mine.open('engine/voice-elevenlabs-key', 'elevenlabs', s.sealed)
    expect(r).toMatchObject({ ok: false, code: 'wrong-machine' })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  test('a machine with no machine key yet refuses a foreign blob as wrong-machine (the migration signal) and does not create one', async () => {
    const dir = await fresh()
    const ms = createMachineSecrets({ dir, protectors: () => [fakeProtector()], machineId: () => null })
    const donor = createMachineSecrets({ dir: await fresh(), protectors: () => [fakeProtector()], machineId: () => null })
    const s = await donor.seal('engine/voice-elevenlabs-key', 'elevenlabs', pt()); if (!s.ok) throw new Error('seal')
    expect(await ms.open('engine/voice-elevenlabs-key', 'elevenlabs', s.sealed)).toMatchObject({ ok: false, code: 'wrong-machine' })
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })

  test('purpose and name are bound: another name or purpose is tampered/purpose; non-engine purposes never reach crypto', async () => {
    const ms = createMachineSecrets({ dir: await fresh(), protectors: () => [fakeProtector()], machineId: () => null })
    const s = await ms.seal('engine/provider-key', 'anthropic', pt()); if (!s.ok) throw new Error('seal')
    expect(await ms.open('engine/provider-key', 'openai', s.sealed)).toMatchObject({ ok: false, code: 'tampered' })
    expect(await ms.open('engine/voice-elevenlabs-key', 'anthropic', s.sealed)).toMatchObject({ ok: false, code: 'tampered' })
    expect(await ms.seal('github-backup' as never, 'x', pt())).toMatchObject({ ok: false, code: 'purpose' })
    expect(await ms.open('engine/provider-key', 'anthropic', new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false, code: 'tampered' })
  })

  test('the protector losing the machine key refuses protector-lost; a protector that is merely unreachable is retried', async () => {
    const dir = await fresh(), p = fakeProtector()
    const ms = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    const s = await ms.seal('engine/provider-key', 'x', pt()); if (!s.ok) throw new Error('seal')
    ms.dispose()
    p.store.clear()
    const lost = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    expect(await lost.open('engine/provider-key', 'x', s.sealed)).toMatchObject({ ok: false, code: 'protector-lost' })
    let reachable = false
    const flaky = fakeProtector(); flaky.unwrap = async (_r, kid) => (reachable ? { ok: true, dek: new Uint8Array(32) } : { ok: false, kind: 'unavailable', reason: 'x' }) as UnwrapResult
    flaky.store.set('k', new Uint8Array(32))
    const dir2 = await fresh()
    const a = createMachineSecrets({ dir: dir2, protectors: () => [flaky], machineId: () => null })
    await a.seal('engine/provider-key', 'x', pt()); a.dispose()
    const b = createMachineSecrets({ dir: dir2, protectors: () => [flaky], machineId: () => null })
    expect(await b.open('engine/provider-key', 'x', s.sealed)).toMatchObject({ ok: false, code: 'uninitialized' })
    reachable = true
    expect((await b.ready()).available).toBe(true) // the failure was not cached
  })

  test('NO PROTECTOR: the explicit weaker file mode (0600, machine id), shown in status; works without any vault', async () => {
    const dir = await fresh()
    const ms = createMachineSecrets({ dir, protectors: () => [fakeProtector('dpapi', { probe: false })], retryMs: [], machineId: () => 'a'.repeat(32) })
    const s = await ms.seal('engine/voice-elevenlabs-key', 'elevenlabs', pt()); if (!s.ok) throw new Error('seal')
    expect(ms.status()).toMatchObject({ available: true, strength: 'file', protector: 'machine id (file)' })
    expect(ms.status().sentence).toMatch(/WEAKER mode/)
    expect((await stat(join(dir, 'machine.key'))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    const onDisk = Buffer.concat(await Promise.all((await readdir(dir)).map(f => readFile(join(dir, f)))))
    expect(onDisk.includes(Buffer.from(KEY))).toBe(false)
    ms.dispose()
    const again = createMachineSecrets({ dir, protectors: () => [], machineId: () => 'a'.repeat(32) })
    const o = await again.open('engine/voice-elevenlabs-key', 'elevenlabs', s.sealed)
    expect(o.ok && new TextDecoder().decode(o.plaintext)).toBe(KEY)
    // copied to another machine (another machine id): the file mode does not open
    const other = createMachineSecrets({ dir, protectors: () => [], machineId: () => 'b'.repeat(32) })
    expect(await other.open('engine/voice-elevenlabs-key', 'elevenlabs', s.sealed)).toMatchObject({ ok: false, code: 'protector-lost' })
  })

  test('RACE: two processes creating the first machine key at once end up with ONE key, and each opens what the other sealed', async () => {
    const dir = await fresh(), p = fakeProtector()
    const slow = p.wrap
    p.wrap = async (dek, kid) => { await new Promise(r => setTimeout(r, 40)); return slow(dek, kid) }
    const a = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    const b = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    const [sa, sb] = await Promise.all([a.ready(), b.ready()])
    expect(sa.available && sb.available).toBe(true)
    expect(p.store.size).toBe(1) // one wrap happened, not two
    const sealed = await a.seal('engine/provider-key', 'x', pt()); if (!sealed.ok) throw new Error('seal')
    const o = await b.open('engine/provider-key', 'x', sealed.sealed)
    expect(o.ok && new TextDecoder().decode(o.plaintext)).toBe(KEY)
    expect((await readdir(dir)).filter(n => n.startsWith('.create')).length).toBe(0) // the lock is released
  })

  test('the protector (DPAPI/powershell) is hit ONCE per process: the wrapped machine key is cached', async () => {
    const dir = await fresh(), p = fakeProtector()
    const first = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    const s = await first.seal('engine/provider-key', 'x', pt()); if (!s.ok) throw new Error('seal')
    first.dispose()
    let unwraps = 0, probes = 0
    const un = p.unwrap, pr = p.probe
    p.unwrap = async (r, k) => { unwraps++; return un(r, k) }
    p.probe = async () => { probes++; return pr() }
    const again = createMachineSecrets({ dir, protectors: () => [p], machineId: () => null })
    for (let i = 0; i < 5; i++) { const o = await again.open('engine/provider-key', 'x', s.sealed); if (o.ok) o.plaintext.fill(0) }
    await again.seal('engine/provider-key', 'y', pt()); await again.ready()
    expect(unwraps).toBe(1); expect(probes).toBe(0)
  })

  test('a DPAPI that fails once (WSL interop hiccup) is re-probed and still chosen, not the weaker mode', async () => {
    const p = fakeProtector(); let n = 0; const pr = p.probe
    p.probe = async () => (n++ === 0 ? { ok: false, reason: 'accept4 failed 110' } : pr())
    const ms = createMachineSecrets({ dir: await fresh(), protectors: () => [p], retryMs: [5], machineId: () => 'a'.repeat(32) })
    expect(await ms.ready()).toMatchObject({ available: true, strength: 'os' })
  })

  test('no protector AND no machine id: refuses (uninitialized) and writes NOTHING, never plaintext', async () => {
    const dir = await fresh()
    const ms = createMachineSecrets({ dir, protectors: () => [], machineId: () => null })
    const r = await ms.seal('engine/voice-elevenlabs-key', 'elevenlabs', pt())
    expect(r).toMatchObject({ ok: false, code: 'uninitialized' })
    expect(ms.status()).toMatchObject({ available: false, strength: null })
    expect(ms.status().sentence).toBeTruthy()
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })

  test('NO PLAINTEXT in logs, statuses or refusals — across every path', async () => {
    const spent: string[] = []
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info }
    for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { spent.push(a.map(String).join(' ')) }
    const seen: string[] = []
    try {
      const ms = createMachineSecrets({ dir: await fresh(), protectors: () => [fakeProtector()], machineId: () => null })
      const s = await ms.seal('engine/provider-key', 'x', pt()); if (!s.ok) throw new Error('seal')
      seen.push(JSON.stringify(ms.status()), JSON.stringify(await ms.ready()))
      seen.push(JSON.stringify(await ms.open('engine/provider-key', 'y', s.sealed)), JSON.stringify(await ms.open('engine/provider-key', 'x', new Uint8Array(4))), JSON.stringify(await ms.seal('nope' as never, 'x', pt())))
      const down = createMachineSecrets({ dir: await fresh(), protectors: () => [], machineId: () => null })
      seen.push(JSON.stringify(await down.seal('engine/provider-key', 'x', pt())), JSON.stringify(down.status()))
    } finally { Object.assign(console, orig) }
    expect([...spent, ...seen].join('\n')).not.toContain(KEY)
    expect(spent).toEqual([])
  })

  test('independent of the vault: never imports or consults it', async () => {
    const src = await readFile(join(import.meta.dir, 'machine-secrets.ts'), 'utf8')
    expect(src).not.toMatch(/from '\.\/service'|vaultStatusSync|ensureVaultOpen|openBytes|sealBytes/)
  })

  test('backup: the machine directory sits inside `.agentistics/vault`, excluded with a reason (a machine-bound key is useless on another machine)', () => {
    expect(excludeFor('.agentistics/vault/machine')).not.toBeNull()
    expect(excludeFor('.agentistics/vault/machine/machine.json')).not.toBeNull()
  })

  test('readMachineId reads the first valid id file and rejects junk', () => {
    expect(readMachineId(p => (p === '/etc/machine-id' ? '0123456789abcdef0123456789abcdef\n' : ''))).toBe('0123456789abcdef0123456789abcdef')
    expect(readMachineId(() => { throw new Error('x') })).toBeNull()
    expect(readMachineId(() => 'not an id')).toBeNull()
  })
})
