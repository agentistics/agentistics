/**
 * vault.ts — the envelope: one data key (DEK) per machine, stored ONLY wrapped, and the decisions
 * of creating, opening, re-wrapping and destroying it. Logic over `ProtectorIo`; no process state.
 *
 *   vault/            0700
 *     vault.json      0600  { v:1, kid, createdAt, wrappers: [ {type, createdAt, params?} ] }
 *     dek.dpapi       0600  DPAPI blob                      (Windows / WSL)
 *     dek.cred        0600  systemd-creds TPM2 credential   (Linux)
 *     dek.pass        0600  scrypt-wrapped key               (passphrase wrapper)
 *
 * Rules this module is held to:
 *  - **Detection runs once, at init.** Afterwards the vault uses the recorded wrapper and NEVER
 *    switches silently: a protector that stops answering yields `locked` or `protector-lost`, never a
 *    quiet fallback — a fallback could not open the existing key anyway, and minting a new one would
 *    orphan every sealed file. Moving is an explicit `rekey` while open.
 *  - **No key derived from the machine and stored beside the data**, and no passphrase-less
 *    fallback: with no protector and no passphrase there is no vault.
 */
import type { Lang } from './sentences'
import { newDataKey } from './seal'
import { isKid, type VaultScope } from './format'
import type { ProbeResult, Protector, ProtectorId, ProtectorIo, WrapperRecord } from './protectors/types'
import { bytes, text } from './protectors/types'

export const VAULT_FILE = 'vault.json'
export const VAULT_VERSION = 1
/** SECRETS.4 §1.1: v2 names the vault's scope. A v1 file is the HUMAN scope with SECRETS.2's wrappers. */
export const VAULT_VERSION_SCOPED = 2
/** The runner scope lives beside the human vault, never inside it (SECRETS.4 §1.1). */
export const RUNNER_VAULT_DIR = 'vault-runner'

export interface VaultJson {
  v: typeof VAULT_VERSION | typeof VAULT_VERSION_SCOPED
  /** Absent in a v1 file, which is read as `'human'`. */
  scope: VaultScope
  kid: string
  createdAt: string
  wrappers: WrapperRecord[]
  /** The paired machine (runner scope only, P1.4). */
  machineId?: string
}

const PROTECTOR_IDS: readonly ProtectorId[] = ['keychain', 'dpapi', 'libsecret', 'systemd-creds', 'passphrase', 'memory']

/** PURE. Parse `vault.json`; `null` for anything that is not exactly this schema. */
export function parseVaultJson(raw: Uint8Array | string | null): VaultJson | null {
  if (raw === null) return null
  let o: unknown
  try { o = JSON.parse(typeof raw === 'string' ? raw : text(raw)) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if ((r.v !== VAULT_VERSION && r.v !== VAULT_VERSION_SCOPED) || !isKid(r.kid) || typeof r.createdAt !== 'string' || !Array.isArray(r.wrappers)) return null
  // v1 has no scope and is the human vault; v2 must name a scope this build knows.
  const scope: VaultScope | null = r.v === VAULT_VERSION ? 'human' : r.scope === 'human' || r.scope === 'cloud-runner' ? r.scope : null
  if (!scope) return null
  if (r.machineId !== undefined && (typeof r.machineId !== 'string' || !r.machineId)) return null
  const wrappers: WrapperRecord[] = []
  for (const w of r.wrappers) {
    if (!w || typeof w !== 'object') return null
    const x = w as Record<string, unknown>
    if (!PROTECTOR_IDS.includes(x.type as ProtectorId) || typeof x.createdAt !== 'string') return null
    const params = x.params && typeof x.params === 'object' && !Array.isArray(x.params) ? x.params as Record<string, string | number> : undefined
    wrappers.push({ type: x.type as ProtectorId, createdAt: x.createdAt, ...(params ? { params } : {}) })
  }
  if (wrappers.length === 0) return null
  return { v: r.v as VaultJson['v'], scope, kid: r.kid, createdAt: r.createdAt, wrappers, ...(typeof r.machineId === 'string' ? { machineId: r.machineId } : {}) }
}

/**
 * A human vault with nothing v2-only stays a v1 FILE: an older agentop that reads it back after a
 * downgrade must still recognise its own vault (an unreadable `vault.json` would read as "no vault").
 * The enrolment flow (SECRETS.4 §7.3) is what writes the human scope as v2.
 */
export function serializeVaultJson(v: VaultJson): Uint8Array {
  const out = v.scope === 'human' && v.v === VAULT_VERSION && !v.machineId
    ? { v: VAULT_VERSION, kid: v.kid, createdAt: v.createdAt, wrappers: v.wrappers }
    : { v: VAULT_VERSION_SCOPED, scope: v.scope, kid: v.kid, createdAt: v.createdAt, wrappers: v.wrappers, ...(v.machineId ? { machineId: v.machineId } : {}) }
  return bytes(JSON.stringify(out, null, 2) + '\n')
}

export type Platform = 'darwin' | 'win32' | 'linux' | 'other'

/**
 * PURE. Which protectors to try, in order. macOS: Keychain. Windows: DPAPI. WSL: Windows DPAPI
 * through interop first (verified to work from the agentop service), then libsecret if a Secret
 * Service answers (WSLg), then a TPM. Linux: libsecret first (no root, no group membership), then
 * systemd-creds with a TPM2. Anything else: none — the passphrase is the only way.
 */
export function detectionOrder(platform: Platform, wsl: boolean): ProtectorId[] {
  if (platform === 'darwin') return ['keychain']
  if (platform === 'win32') return ['dpapi']
  if (platform === 'linux') return wsl ? ['dpapi', 'libsecret', 'systemd-creds'] : ['libsecret', 'systemd-creds']
  return []
}

export interface Checked {
  id: ProtectorId
  reason: string
}

/** PURE. "libsecret — no Secret Service answered; systemd-creds — no TPM2". */
export function checkedList(checked: readonly Checked[], lang: Lang): string {
  if (checked.length === 0) return lang === 'pt' ? 'nenhum chaveiro suportado nesta plataforma' : 'no supported keychain on this platform'
  return checked.map(c => `${c.id} — ${c.reason}`).join('; ')
}

export type Choice = { ok: true; protector: Protector } | { ok: false; checked: Checked[] }

/**
 * Probe the candidates in order and take the FIRST that completes a real round trip. Every failure
 * is kept, in words, because the no-protector sentence must name what was checked.
 */
export async function chooseProtector(candidates: readonly Protector[]): Promise<Choice> {
  const checked: Checked[] = []
  for (const p of candidates) {
    let r: ProbeResult
    try { r = await p.probe() } catch { r = { ok: false, reason: 'the probe failed to run' } }
    if (r.ok) return { ok: true, protector: p }
    checked.push({ id: p.id, reason: r.reason })
  }
  return { ok: false, checked }
}

export interface VaultPaths {
  dir: string
  file: string
}
export function vaultPaths(dir: string): VaultPaths {
  return { dir, file: `${dir}/${VAULT_FILE}` }
}

export type InitResult =
  | { ok: true; kid: string; dek: Uint8Array; vault: VaultJson }
  | { ok: false; reason: 'exists' | 'wrap-failed'; detail?: string }

/** Create a vault under `protector`, plus optional extra wrappers (the passphrase beside the OS one). */
export async function initVault(
  io: ProtectorIo, dir: string, protector: Protector, extras: readonly Protector[] = [], now = new Date(),
): Promise<InitResult> {
  const paths = vaultPaths(dir)
  if (parseVaultJson(await io.readFile(paths.file))) return { ok: false, reason: 'exists' }
  const { dek, kid } = newDataKey()
  const wrappers: WrapperRecord[] = []
  for (const p of [protector, ...extras]) {
    const w = await p.wrap(dek, kid)
    if (!w.ok) {
      for (const done of wrappers) await protectorFor(done, [protector, ...extras])?.remove(done, kid)
      return { ok: false, reason: 'wrap-failed', detail: w.reason }
    }
    wrappers.push(w.record)
  }
  const vault: VaultJson = { v: VAULT_VERSION, kid, createdAt: now.toISOString(), wrappers }
  // vault.json is written LAST and EXCLUSIVELY: until it exists there is no vault, so a crash in
  // between leaves only an unreferenced wrapped blob; and a second process that got here first wins —
  // this one then reports `exists` and the caller opens the winner's vault.
  if (!(await io.createExclusive(paths.file, serializeVaultJson(vault)))) return { ok: false, reason: 'exists' }
  return { ok: true, kid, dek, vault }
}

function protectorFor(w: WrapperRecord, ps: readonly Protector[]): Protector | undefined {
  return ps.find(p => p.id === w.type)
}

export type OpenState =
  | { state: 'open'; kid: string; dek: Uint8Array; vault: VaultJson; via: ProtectorId }
  | { state: 'uninitialized' }
  /** The protector could not be reached now, or the vault needs its passphrase. Retry later. */
  | { state: 'locked'; kid: string; vault: VaultJson; protector: ProtectorId; reason: string }
  /** The protector answered and no longer holds this vault's key. */
  | { state: 'protector-lost'; kid: string; vault: VaultJson; protector: ProtectorId; reason: string }
  /** vault.json exists and is not a vault this code can read. Never "fixed" by re-initialising. */
  | { state: 'corrupt' }

/**
 * Open the vault. `protectors` are the adapters for the RECORDED wrappers (the caller builds them
 * from `vault.wrappers`, giving the passphrase protector the passphrase when it has one). The
 * primary wrapper (the first that is not a passphrase) is tried first; the passphrase wrapper is
 * tried only when a passphrase was supplied — that is how a container, which has no OS protector,
 * opens the same key.
 */
export async function openVault(io: ProtectorIo, dir: string, protectors: readonly Protector[]): Promise<OpenState> {
  const paths = vaultPaths(dir)
  const raw = await io.readFile(paths.file)
  if (raw === null) return { state: 'uninitialized' }
  const vault = parseVaultJson(raw)
  if (!vault) return { state: 'corrupt' }
  const primary = vault.wrappers.find(w => w.type !== 'passphrase') ?? vault.wrappers[0]!
  const pass = vault.wrappers.find(w => w.type === 'passphrase')
  const primaryP = protectorFor(primary, protectors)

  let primaryFailure: { kind: 'missing' | 'unavailable' | 'denied'; reason: string } | null = null
  if (primaryP) {
    const u = await primaryP.unwrap(primary, vault.kid)
    if (u.ok) return { state: 'open', kid: vault.kid, dek: u.dek, vault, via: primary.type }
    primaryFailure = u
  } else {
    primaryFailure = { kind: 'unavailable', reason: `${primary.type} is not available in this process` }
  }
  if (pass && pass !== primary) {
    const pp = protectorFor(pass, protectors)
    if (pp) {
      const u = await pp.unwrap(pass, vault.kid)
      if (u.ok) return { state: 'open', kid: vault.kid, dek: u.dek, vault, via: 'passphrase' }
    }
  }
  if (primaryFailure.kind === 'missing') {
    return { state: 'protector-lost', kid: vault.kid, vault, protector: primary.type, reason: primaryFailure.reason }
  }
  return { state: 'locked', kid: vault.kid, vault, protector: primary.type, reason: primaryFailure.reason }
}

/**
 * Re-wrap the OPEN key under another primary protector — the only way a vault changes protector.
 * The passphrase wrapper, if any, is kept. The old primary's stored key is removed only after the
 * new vault.json is written.
 */
export async function rekeyVault(
  io: ProtectorIo, dir: string, open: Extract<OpenState, { state: 'open' }>, next: Protector, old: readonly Protector[],
): Promise<{ ok: true; vault: VaultJson } | { ok: false; reason: string }> {
  const w = await next.wrap(open.dek, open.kid)
  if (!w.ok) return { ok: false, reason: w.reason }
  const keptPass = next.id === 'passphrase' ? [] : open.vault.wrappers.filter(x => x.type === 'passphrase')
  const replaced = open.vault.wrappers.filter(x => x.type !== 'passphrase' && x.type !== next.id)
  const vault: VaultJson = { ...open.vault, wrappers: [w.record, ...keptPass] }
  await io.writeFile(vaultPaths(dir).file, serializeVaultJson(vault))
  for (const r of replaced) await protectorFor(r, old)?.remove(r, open.kid)
  return { ok: true, vault }
}

/** Add (or replace) the passphrase wrapper beside the primary one. */
export async function addPassphraseWrapper(
  io: ProtectorIo, dir: string, open: Extract<OpenState, { state: 'open' }>, pass: Protector,
): Promise<{ ok: true; vault: VaultJson } | { ok: false; reason: string }> {
  if (pass.id !== 'passphrase') return { ok: false, reason: 'not a passphrase protector' }
  const w = await pass.wrap(open.dek, open.kid)
  if (!w.ok) return { ok: false, reason: w.reason }
  const vault: VaultJson = { ...open.vault, wrappers: [...open.vault.wrappers.filter(x => x.type !== 'passphrase'), w.record] }
  await io.writeFile(vaultPaths(dir).file, serializeVaultJson(vault))
  return { ok: true, vault }
}

/** Remove every stored wrapped key and `vault.json`. The CALLER deletes the sealed files, after a
 *  confirmation naming each one — there is no verb that decrypts them back to plain text. */
export async function destroyVault(io: ProtectorIo, dir: string, protectors: readonly Protector[]): Promise<void> {
  const paths = vaultPaths(dir)
  const vault = parseVaultJson(await io.readFile(paths.file))
  if (vault) for (const w of vault.wrappers) await protectorFor(w, protectors)?.remove(w, vault.kid)
  await io.removeFile(paths.file).catch(() => {})
}
