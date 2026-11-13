/**
 * delivery/owner-mode.ts — the `delivery.ownerProof` mode (ENTREGA.GARANTIDA §2.3, D1, amended by S0d.1).
 *
 * QA 13/11 (F1, CRITICAL): the mode lived in `preferences.json` and "absent / unreadable = legacy", so a worker
 * that edited, dropped or garbled that file (§1.1: the adversary edits `~/.agentistics/*.json`) turned `required`
 * back into `legacy` and then approved a human gate with forged browser headers. Now:
 *
 *   - The mode is a RECORD, `<vault dir>/delivery-owner-mode.json` = `{ v:1, kid, mode, atMs, mac }`, MACed with a key
 *     derived from the open vault's DEK (`vaultDerivedMac`). It is written only by `setOwnerProofMode`, right after the
 *     owner's fresh vault proof. `preferences.json` keeps a display mirror for older readers and is never trusted to
 *     mean `legacy` once a record exists.
 *   - Reading is the PURE `resolveOwnerMode`: `required` wins from any source; an unreadable / forged / replayed /
 *     vanished record is `required` plus a tamper reason (health WARN `delivery-owner-mode-tampered`); `legacy` needs
 *     a record whose MAC verifies NOW, or no record ever (the machines that never chose `required` are unchanged).
 *   - The process LATCH keeps the last trusted record: a file edit while the server runs changes nothing, and only
 *     `writeOwnerProofMode` (behind the owner proof) moves it.
 *
 * Stated limit (spec S0d.1): deleting the record AND the preference AND restarting the server reads as "never chosen".
 */
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { writePrivateAtomic } from '@agentistics/vault'
import { readPreferences, updatePreferences } from '../preferences'
import { parseOwnerProofMode, type OwnerProofMode } from './principal'

export const OWNER_MODE_FILE = 'delivery-owner-mode.json'
export const OWNER_MODE_MAC_INFO = 'agentistics/delivery-owner-mode/v1'

export type ModeRecordView =
  | { state: 'absent' }
  | { state: 'unreadable' }
  /** `mac`: `ok` verified under the open vault now, `bad` verified and wrong, `unknown` cannot be checked here. */
  | { state: 'present'; mode: OwnerProofMode; atMs: number; mac: 'ok' | 'bad' | 'unknown' }

export type ModeTamper = 'unreadable' | 'forged' | 'replayed' | 'vanished' | 'disagree'

/** The last record this process trusted. */
export interface ModeLatch { mode: OwnerProofMode; atMs: number }

export interface ModeSources {
  record: ModeRecordView
  /** `preferences.json`'s `delivery.ownerProof`, raw (`undefined` when absent or the file was unreadable). */
  prefs: unknown
  latch: ModeLatch | null
}

export interface ModeResolution { mode: OwnerProofMode; tampered?: ModeTamper; latch: ModeLatch | null }

/** PURE. See the header; every branch that cannot PROVE `legacy` answers `required`. */
export function resolveOwnerMode(s: ModeSources): ModeResolution {
  const prefsRequired = s.prefs === 'required'
  const r = s.record
  if (r.state === 'unreadable') return { mode: 'required', tampered: 'unreadable', latch: s.latch }
  if (r.state === 'absent') {
    if (s.latch) return { mode: 'required', tampered: 'vanished', latch: s.latch }
    return { mode: prefsRequired ? 'required' : 'legacy', latch: null }
  }
  if (r.mac === 'bad') return { mode: 'required', tampered: 'forged', latch: s.latch }
  // An older record than one this process already trusted is a replay of a stale (valid) file.
  if (s.latch && r.atMs < s.latch.atMs) return { mode: 'required', tampered: 'replayed', latch: s.latch }
  if (r.mode === 'required') {
    const latch = { mode: 'required' as const, atMs: r.atMs }
    return s.prefs === 'legacy' ? { mode: 'required', tampered: 'disagree', latch } : { mode: 'required', latch }
  }
  // r.mode === 'legacy': believed only when the MAC verifies now, or it is the very record this process verified.
  if (r.mac === 'ok') return { mode: 'legacy', latch: { mode: 'legacy', atMs: r.atMs } }
  if (s.latch && s.latch.mode === 'legacy' && s.latch.atMs === r.atMs) return { mode: 'legacy', latch: s.latch }
  return { mode: 'required', latch: s.latch }
}

/** PURE. The message the record's MAC covers. */
export const ownerModeMessage = (kid: string, mode: OwnerProofMode, atMs: number): string => `${kid}\0${mode}\0${atMs}`

/** What the IO needs from the vault service; injected in tests. */
export interface OwnerModeIo {
  vaultDir(): string
  readFile(path: string): Promise<Uint8Array | null>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /** `vaultDerivedMac(OWNER_MODE_MAC_INFO, message, kid)` — null when the vault is not open in this process. */
  mac(message: string, kid?: string): { kid: string; mac: string } | null
  now(): number
}

async function realIo(): Promise<OwnerModeIo> {
  const svc = await import('../vault/service')
  return {
    vaultDir: svc.vaultDir,
    readFile: p => svc.secretFs().readFile(p),
    async writeFile(p, b) { await writePrivateAtomic(svc.secretFs(), p, b) },
    mac: (m, kid) => svc.vaultDerivedMac(OWNER_MODE_MAC_INFO, m, kid),
    now: () => Date.now(),
  }
}

let _io: OwnerModeIo | null = null
let _latch: ModeLatch | null = null
let _lastTamper: ModeTamper | undefined
const io = async () => (_io ??= await realIo())

const eqMac = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

/** IO: the record as it is on disk, with its MAC checked where the vault can check it. */
export async function readModeRecord(o: OwnerModeIo): Promise<ModeRecordView> {
  let raw: Uint8Array | null
  try { raw = await o.readFile(join(o.vaultDir(), OWNER_MODE_FILE)) } catch { return { state: 'unreadable' } }
  if (!raw) return { state: 'absent' }
  try {
    const j = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
    if (j.v !== 1 || (j.mode !== 'legacy' && j.mode !== 'required') || typeof j.atMs !== 'number' || !Number.isFinite(j.atMs) || typeof j.kid !== 'string') return { state: 'unreadable' }
    const mode = j.mode
    if (typeof j.mac !== 'string') return { state: 'present', mode, atMs: j.atMs, mac: mode === 'required' ? 'unknown' : 'bad' }
    const want = o.mac(ownerModeMessage(j.kid, mode, j.atMs), j.kid)
    return { state: 'present', mode, atMs: j.atMs, mac: want === null ? 'unknown' : eqMac(want.mac, j.mac) ? 'ok' : 'bad' }
  } catch { return { state: 'unreadable' } }
}

/** The effective mode for this process, and why it is not the file's word when it is not (`tampered`). */
export async function readOwnerModeState(): Promise<{ mode: OwnerProofMode; tampered?: ModeTamper }> {
  const o = await io()
  const record = await readModeRecord(o)
  let prefs: unknown
  try { prefs = (await readPreferences()).delivery?.ownerProof } catch { prefs = undefined }
  const r = resolveOwnerMode({ record, prefs, latch: _latch })
  _latch = r.latch
  _lastTamper = r.tampered
  return r.tampered ? { mode: r.mode, tampered: r.tampered } : { mode: r.mode }
}

export async function readOwnerProofMode(): Promise<OwnerProofMode> {
  try { return (await readOwnerModeState()).mode } catch { return _latch ? 'required' : parseOwnerProofMode(undefined) }
}

/**
 * Write the mode. ONLY behind the owner's fresh proof (`vault/gate.ts` `setOwnerProofMode`) or a test seed. The record
 * is MACed when the vault is open here; a `legacy` record that cannot be MACed would read `required`, so it refuses.
 */
export async function writeOwnerProofMode(mode: OwnerProofMode): Promise<void> {
  const o = await io()
  const atMs = Math.max(o.now(), (_latch?.atMs ?? 0) + 1)
  const probe = o.mac('probe')
  const kid = probe?.kid ?? 'none'
  const sealed = probe ? o.mac(ownerModeMessage(kid, mode, atMs), kid) : null
  if (mode === 'legacy' && !sealed) throw new Error('the vault must be open to record the legacy owner-proof mode')
  const body = { v: 1, kid, mode, atMs, ...(sealed ? { mac: sealed.mac } : {}) }
  await o.writeFile(join(o.vaultDir(), OWNER_MODE_FILE), new TextEncoder().encode(JSON.stringify(body)))
  _latch = { mode, atMs }
  _lastTamper = undefined
  await updatePreferences(cur => ({ delivery: { ...(cur.delivery ?? {}), ownerProof: mode } }))
}

/** The last tamper reason this process saw (health), without touching the disk. */
export function lastOwnerModeTamper(): ModeTamper | undefined { return _lastTamper }

export function __resetOwnerModeForTests(o: OwnerModeIo | null = null): void { _io = o; _latch = null; _lastTamper = undefined }
