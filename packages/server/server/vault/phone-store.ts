/**
 * vault/phone-store.ts — the phone copies of the data key on disk (VAULT.PERSONAL §10).
 *
 * `vault/phone-unlock.json` (0600) holds ONLY what a locked vault must read to let a phone in: each
 * copy's id, kind, the kid it belongs to, its salt, its ciphertext and — for a passkey — the PUBLIC key
 * an assertion is verified against. No label (the owner's phone names live in the sealed
 * `mobile.sealed`), no secret: the secret that opens each copy lives on the phone.
 *
 * Integrity, stated: anyone who can write this file can add a copy — of a key they made up. It opens
 * nothing real: the unwrapped key must then open the authenticator seed sealed under the REAL key
 * before anything is adopted (gate.ts `completeUnlock`). Deleting entries only removes ways in.
 */
import { join } from 'node:path'
import { isPhoneWrap, writePrivateAtomic, type PhoneWrap } from '@agentistics/vault'
import { secretFs, vaultDir } from './service'

interface PhoneFile { v: 1; wraps: PhoneWrap[] }
const file = () => join(vaultDir(), 'phone-unlock.json')

export async function readPhoneWraps(): Promise<PhoneWrap[]> {
  const raw = await secretFs().readFile(file())
  if (!raw) return []
  try {
    const o = JSON.parse(new TextDecoder().decode(raw)) as Partial<PhoneFile>
    return Array.isArray(o.wraps) ? o.wraps.filter(isPhoneWrap) : []
  } catch { return [] }
}

async function writePhoneWraps(wraps: PhoneWrap[]): Promise<void> {
  const body: PhoneFile = { v: 1, wraps }
  await writePrivateAtomic(secretFs(), file(), new TextEncoder().encode(JSON.stringify(body)))
}

/** Add (or replace by id) one copy. */
export async function putPhoneWrap(w: PhoneWrap): Promise<void> {
  const all = await readPhoneWraps()
  await writePhoneWraps([...all.filter(x => x.id !== w.id), w])
}

/** Drop copies matching `pred`; returns how many went. */
export async function dropPhoneWraps(pred: (w: PhoneWrap) => boolean): Promise<number> {
  const all = await readPhoneWraps()
  const keep = all.filter(w => !pred(w))
  if (keep.length !== all.length) await writePhoneWraps(keep)
  return all.length - keep.length
}

/** A passkey's counter moved forward: keep it, so a cloned authenticator is caught next time. */
export async function notePhoneSignCount(id: string, signCount: number): Promise<void> {
  const all = await readPhoneWraps()
  await writePhoneWraps(all.map(w => (w.id === id && w.passkey ? { ...w, passkey: { ...w.passkey, signCount } } : w)))
}
