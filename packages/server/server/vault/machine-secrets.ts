/**
 * vault/machine-secrets.ts — engine-api 1.23 `machineSecrets`: secrets sealed to THIS MACHINE, usable with the vault locked.
 *
 * The vault (`engine-secrets.ts`) is the right home for values handed to models during a session: it locks, and a
 * person unlocks it. A model-provider key is different — it has to work every time, unattended — yet it must still be
 * encrypted at rest and never printed. So an engine's unattended keys are sealed under a MACHINE KEY (MK): 32 random
 * bytes, wrapped by the platform's SILENT protector (macOS Keychain, Windows DPAPI also from WSL, Secret Service,
 * systemd-creds — the same adapters the vault uses, never a presence one), stored in `<vault>/machine/machine.json`
 * and never by the vault's own data key. The vault's lock state is not consulted anywhere in this file.
 *
 * When no silent protector answers, the fallback is EXPLICIT and weaker (`strength: 'file'`): the MK sits in
 * `machine.key` (0600), encrypted under a key derived from the machine id. That stops a copied file from opening
 * elsewhere and plaintext from ever reaching disk, but not another process of the same user on this machine; `status()`
 * says so. With neither a protector nor a machine id the answer is `uninitialized` — plaintext is NEVER stored.
 *
 * The envelope is `seal.ts`'s (AES-256-GCM, per-purpose HKDF subkey, AAD = purpose + name + kid) with the MK as the
 * "data key": a blob sealed on another machine, or by the vault, carries another kid and refuses `wrong-machine`.
 * The MK is held in memory for the process (it is a wrapping key, not the secret); the secrets it protects are handed
 * out per call as fresh buffers the caller zeroes. Nothing here logs, and no refusal sentence is built from input.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineMachineSecrets, EngineMachineSecretsStatus, OpenResult, SealResult, VaultRefusal } from '@agentistics/engine-api'
import {
  aeadOpen, aeadSeal, isEnginePurpose, newDataKey, openRecord, sealToBytes,
  type Protector, type WrapperRecord,
} from '@agentistics/vault'

const FILE_WRAP = 'machine-file' as const
const META = 'machine.json'
const FILE_KEY = 'machine.key'

interface MachineMeta {
  v: 1
  kid: string
  createdAt: string
  /** `os`: a protector's wrapper record. `file`: the MK is in `machine.key`. */
  strength: 'os' | 'file'
  wrapper?: WrapperRecord & { type: WrapperRecord['type'] }
  protectorLabel?: string
}

export interface MachineSecretsOptions {
  /** `<vault dir>/machine` — created 0700. */
  dir: string
  /** The SILENT OS protectors for this platform, best first. Never a presence protector. */
  protectors: () => Protector[]
  /** The machine id for the weaker file mode; `null` = none (then that mode is unavailable). */
  machineId: () => string | null
  lang?: () => 'en' | 'pt'
  /** Pauses (ms) before re-probing a DPAPI that did not answer: WSL interop can fail transiently right after login, and the weaker file mode must not be chosen for good because of one hiccup. Default [1500, 4000]. */
  retryMs?: number[]
}

const T = {
  none: { en: 'No keystore on this machine answered and there is no machine id, so keys cannot be stored encrypted here.', pt: 'Nenhum chaveiro desta máquina respondeu e não há identificador da máquina, então as chaves não podem ser guardadas cifradas aqui.' },
  weak: { en: 'This is the WEAKER mode: no keystore on this machine answered, so keys are encrypted with a key derived from the machine id. Another process of this user on this machine could open them.', pt: 'Este é o modo MAIS FRACO: nenhum chaveiro desta máquina respondeu, então as chaves são cifradas com uma chave derivada do identificador da máquina. Outro processo deste usuário nesta máquina poderia abri-las.' },
  lost: { en: 'The machine key can no longer be opened by its protector. Store the key again.', pt: 'A chave da máquina não abre mais pelo protetor dela. Guarde a chave de novo.' },
  copied: { en: 'This sealed file belongs to another machine or vault.', pt: 'Este arquivo selado pertence a outra máquina ou cofre.' },
  tampered: { en: 'This sealed file is damaged or was changed.', pt: 'Este arquivo selado está danificado ou foi alterado.' },
  purpose: { en: 'An engine may only seal and open its own secrets (a purpose starting with `engine/`).', pt: 'Um motor só pode selar e abrir os próprios segredos (um propósito que começa com `engine/`).' },
} as const

const refuse = <C extends VaultRefusal>(code: C, sentence: string): { ok: false; code: C; sentence: string } => ({ ok: false, code, sentence })

async function writeAtomic(dir: string, name: string, data: Uint8Array): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, join(dir, name))
}
const readOrNull = async (p: string): Promise<Uint8Array | null> => { try { return new Uint8Array(await readFile(p)) } catch { return null } }

/** The key the file mode derives from the machine id; the kid and a salt bind it to this machine key. */
function fileKek(machineId: string, salt: Uint8Array, kid: string): Uint8Array {
  const ikm = createHash('sha256').update(`agentistics-machine-file/v1\n${machineId}`).digest()
  return new Uint8Array(hkdfSync('sha256', ikm, salt, `agentistics machine-file ${kid}`, 32))
}
const fileAad = (kid: string) => new TextEncoder().encode(`agentistics-machine-file/v1/${kid}`)

export function createMachineSecrets(o: MachineSecretsOptions): EngineMachineSecrets & { dispose(): void } {
  const lang = () => o.lang?.() ?? 'en'
  const say = (k: keyof typeof T) => T[k][lang()]
  let mk: { key: Uint8Array; kid: string } | null = null
  let st: EngineMachineSecretsStatus = { available: false, protector: null, strength: null, sentence: null }
  let settling: Promise<EngineMachineSecretsStatus> | null = null
  /** The refusal that explains why `mk` is missing, for seal/open. */
  let why: { code: VaultRefusal; sentence: string } | null = null

  const metaPath = join(o.dir, META)
  const adopt = (key: Uint8Array, kid: string, s: EngineMachineSecretsStatus) => { mk?.key.fill(0); mk = { key, kid }; st = s; why = null }
  const down = (code: VaultRefusal, sentence: string) => { mk?.key.fill(0); mk = null; st = { available: false, protector: null, strength: null, sentence }; why = { code, sentence } }

  async function openExisting(meta: MachineMeta): Promise<boolean> {
    if (meta.strength === 'file') {
      const id = o.machineId()
      const raw = await readOrNull(join(o.dir, FILE_KEY))
      if (!id || !raw || raw.length < 16 + 12 + 17) { down('protector-lost', say('lost')); return false }
      const kek = fileKek(id, raw.subarray(0, 16), meta.kid)
      try {
        const key = aeadOpen(kek, raw.subarray(16, 28), fileAad(meta.kid), raw.subarray(28))
        if (!key) { down('protector-lost', say('lost')); return false }
        adopt(key, meta.kid, { available: true, protector: 'machine id (file)', strength: 'file', sentence: say('weak') })
        return true
      } finally { kek.fill(0) }
    }
    const p = o.protectors().find(x => x.id === meta.wrapper?.type)
    if (!p || !meta.wrapper) { down('protector-lost', say('lost')); return false }
    const r = await p.unwrap(meta.wrapper, meta.kid).catch(() => ({ ok: false as const, kind: 'unavailable' as const, reason: '' }))
    if (!r.ok) {
      // `unavailable` is retried on the next use (nothing cached); `missing`/`denied` means the key is gone for good
      st = { available: false, protector: null, strength: null, sentence: say(r.kind === 'unavailable' ? 'none' : 'lost') }
      why = { code: r.kind === 'unavailable' ? 'uninitialized' : 'protector-lost', sentence: st.sentence! }
      return false
    }
    adopt(r.dek, meta.kid, { available: true, protector: meta.protectorLabel ?? p.label(lang()), strength: 'os', sentence: null })
    return true
  }

  /** Create the machine key under an exclusive lock (`mkdir` is atomic): of two processes starting at once ONE creates it, the other waits and opens the winner's. */
  async function createNew(): Promise<boolean> {
    await mkdir(o.dir, { recursive: true, mode: 0o700 })
    const lock = join(o.dir, '.create.lock')
    for (let i = 0; ; i++) {
      try { await mkdir(lock); break } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const raw = await readOrNull(metaPath)
        if (raw) return reopen(raw)
        const age = await stat(lock).then(st => Date.now() - st.mtimeMs, () => 0)
        if (age > 30_000 || i > 300) await rmdir(lock).catch(() => {}) // a crashed creator's lock
        else await new Promise(r => setTimeout(r, 50))
      }
    }
    try {
      const raw = await readOrNull(metaPath) // the winner may have finished between our check and our lock
      if (raw) return reopen(raw)
      return await createLocked()
    } finally { await rmdir(lock).catch(() => {}) }
  }
  async function reopen(raw: Uint8Array): Promise<boolean> {
    try { const j = JSON.parse(new TextDecoder().decode(raw)) as MachineMeta; if (j?.v === 1 && typeof j.kid === 'string') return await openExisting(j) } catch { /* unreadable */ }
    down('protector-lost', say('lost')); return false
  }

  async function createLocked(): Promise<boolean> {
    const { dek, kid } = newDataKey()
    for (const p of o.protectors()) {
      let probe = await p.probe().catch(() => ({ ok: false as const, reason: '' }))
      if (!probe.ok && p.id === 'dpapi') for (const wait of o.retryMs ?? [1500, 4000]) {
        await new Promise(r => setTimeout(r, wait))
        probe = await p.probe().catch(() => ({ ok: false as const, reason: '' }))
        if (probe.ok) break
      }
      if (!probe.ok) continue
      await mkdir(o.dir, { recursive: true, mode: 0o700 })
      const w = await p.wrap(dek, kid).catch(() => ({ ok: false as const, reason: '' }))
      if (!w.ok) continue
      const meta: MachineMeta = { v: 1, kid, createdAt: new Date().toISOString(), strength: 'os', wrapper: w.record, protectorLabel: p.label(lang()) }
      await writeAtomic(o.dir, META, new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n'))
      adopt(dek, kid, { available: true, protector: meta.protectorLabel!, strength: 'os', sentence: null })
      return true
    }
    const id = o.machineId()
    if (!id) { dek.fill(0); down('uninitialized', say('none')); return false }
    const salt = new Uint8Array(randomBytes(16)), nonce = new Uint8Array(randomBytes(12))
    const kek = fileKek(id, salt, kid)
    try {
      const ct = aeadSeal(kek, nonce, fileAad(kid), dek)
      const blob = new Uint8Array(16 + 12 + ct.length); blob.set(salt, 0); blob.set(nonce, 16); blob.set(ct, 28)
      await writeAtomic(o.dir, FILE_KEY, blob)
    } finally { kek.fill(0) }
    const meta: MachineMeta = { v: 1, kid, createdAt: new Date().toISOString(), strength: 'file' }
    await writeAtomic(o.dir, META, new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n'))
    adopt(dek, kid, { available: true, protector: 'machine id (file)', strength: 'file', sentence: say('weak') })
    return true
  }

  /** Settle the machine key once (a failure is not cached: the next use tries again). */
  function settle(create: boolean): Promise<EngineMachineSecretsStatus> {
    if (mk) return Promise.resolve(st)
    return (settling ??= (async () => {
      try {
        const raw = await readOrNull(metaPath)
        let meta: MachineMeta | null = null
        if (raw) { try { const j = JSON.parse(new TextDecoder().decode(raw)) as MachineMeta; if (j?.v === 1 && typeof j.kid === 'string') meta = j } catch { /* unreadable: treated as lost below */ } }
        if (raw && !meta) down('protector-lost', say('lost'))
        else if (meta) await openExisting(meta)
        else if (create) await createNew()
        else st = { available: false, protector: null, strength: null, sentence: null }
      } catch { down('uninitialized', say('none')) }
      return st
    })().finally(() => { settling = null }))
  }

  return {
    status: () => ({ ...st }),
    ready: () => settle(true),
    async seal(purpose, name, plaintext): Promise<SealResult> {
      if (!isEnginePurpose(purpose) || typeof name !== 'string' || name === '') return refuse('purpose', say('purpose'))
      await settle(true)
      if (!mk) return why ? refuse(why.code, why.sentence) : refuse('uninitialized', say('none'))
      return { ok: true, sealed: sealToBytes({ dek: mk.key, kid: mk.kid, purpose, name, plaintext }) }
    },
    async open(purpose, name, sealed): Promise<OpenResult> {
      if (!isEnginePurpose(purpose) || typeof name !== 'string' || name === '') return refuse('purpose', say('purpose'))
      await settle(false)
      // no machine key yet (never sealed here): whatever the file is, it is not ours
      if (!mk) return why ? refuse(why.code, why.sentence) : refuse('wrong-machine', say('copied'))
      const r = openRecord({ dek: mk.key, kid: mk.kid, purpose, name, bytes: sealed })
      if (r.ok) return { ok: true, plaintext: r.plaintext }
      return refuse(r.code === 'wrong-machine' ? 'wrong-machine' : r.code === 'purpose' ? 'purpose' : 'tampered', say(r.code === 'wrong-machine' ? 'copied' : r.code === 'purpose' ? 'purpose' : 'tampered'))
    },
    dispose() { mk?.key.fill(0); mk = null },
  }
}

export async function removeMachineKeyForTests(dir: string): Promise<void> {
  for (const f of [META, FILE_KEY]) await unlink(join(dir, f)).catch(() => {})
}
