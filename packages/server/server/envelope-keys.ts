/**
 * envelope-keys.ts — the I/O edge of the sealed envelope: this machine's own keypair, and the
 * peer public keys it has PINNED.
 *
 * The private key is generated here, stored here — SEALED by the machine's vault
 * (`connections/envelope-key.sealed`, purpose `envelope-key`; never plain text, the legacy
 * `envelope-key.json` is migrated on the first open) — and goes nowhere else. It is never put in `preferences.json` (which is served, redacted, over
 * `GET /api/preferences`), never logged, never audited, and never included in any response body —
 * `publicKeyOnly()` is the only thing any route may see.
 *
 * Pinning is trust-on-first-use, and the decision itself is the pure `decidePin`
 * (`envelope-message.ts`). The honest limit — a central that substitutes a key at the moment of
 * FIRST sight reads that peer's envelopes — is documented in docs/security.md. What the pin buys
 * is that every substitution AFTER the first is loud: `'changed'` refuses to decrypt and surfaces
 * a warning, because a reinstall and an attack look identical from here and the machine must not
 * choose for the user.
 */
import { VaultRefusalError, writePrivateAtomic } from '@agentistics/vault'
import { envelopeKeyFile, envelopePinsFile } from './config'
import { openFromFile, refusal, registerVaultMigrator, sealToFile, secretFs } from './vault/service'
import { migrateWholeFile, sealedPathFor, wholeFileMigrator } from './vault/whole-file'
import { safeReadJson } from './utils'
import { generateMachineKeypair, fingerprintOf, type MachineKeypair } from './envelope-crypto'
import { decidePin, type PinDecision } from './envelope-message'

/**
 * Only the PUBLIC half is cached (SECRETS.4 §5.2: no module-level variable holds a secret). The
 * private key is opened from the vault at each use — a cheap AES open — and not kept.
 */
let _cachedPublic: string | null = null

/** Test-only: drop the in-process cache. */
export function __resetEnvelopeKeysForTests(): void {
  _cachedPublic = null
}

/** The pins (public keys — integrity, not confidentiality) go through the same atomic writer. */
async function writePrivate(path: string, body: string): Promise<void> {
  const r = await writePrivateAtomic(secretFs(), path, new TextEncoder().encode(body))
  if (r.chmodFailed) process.stderr.write(`agentop: could not set ${path} to mode 600 (${r.chmodFailed}).\n`)
}

const PURPOSE = 'envelope-key'
const NAME = 'machine'

function keyItem() {
  const plainPath = envelopeKeyFile()
  return { purpose: PURPOSE, name: NAME, plainPath, sealedPath: sealedPathFor(plainPath) }
}

registerVaultMigrator(wholeFileMigrator('envelope-key', keyItem))

function parseKeypair(raw: string): MachineKeypair | null {
  try {
    const o = JSON.parse(raw) as Partial<MachineKeypair>
    return typeof o.publicKey === 'string' && typeof o.privateKey === 'string' && o.publicKey !== '' && o.privateKey !== ''
      ? { publicKey: o.publicKey, privateKey: o.privateKey } : null
  } catch { return null }
}

/**
 * This machine's keypair, generating and persisting one the first time. Automatic and
 * passphrase-less by design — the product requirement is that a second machine joining an account
 * works with nothing to type. The vault is what keeps it: a vault that cannot open makes this THROW
 * its sentence rather than mint a fresh key per process, which would re-pin this machine on every
 * sibling at every start.
 */
export async function loadOrCreateKeypair(): Promise<MachineKeypair> {
  const item = keyItem()
  let r = await openFromFile(item.sealedPath, PURPOSE, NAME)
  if (!r.ok && r.absent && (await secretFs().lstat(item.plainPath))) {
    await migrateWholeFile(item)
    r = await openFromFile(item.sealedPath, PURPOSE, NAME)
    if (!r.ok && r.absent) throw refusal('plaintext-pending', { n: 1 })
  }
  if (r.ok) {
    const kp = parseKeypair(new TextDecoder().decode(r.plaintext))
    r.plaintext.fill(0)
    if (kp) { _cachedPublic = kp.publicKey; return kp }
    throw refusal('tampered', { file: item.sealedPath, restoreWith: 'nothing — siblings re-pin this machine on its next announcement' })
  }
  if (!r.absent) throw new VaultRefusalError(r.code, r.sentence)
  const fresh = generateMachineKeypair()
  const body = new TextEncoder().encode(JSON.stringify(fresh))
  try { await sealToFile(item.sealedPath, PURPOSE, NAME, body) } finally { body.fill(0) }
  _cachedPublic = fresh.publicKey
  return fresh
}

/** The public half plus its human-comparable fingerprint. The ONLY shape any route may return. */
export async function publicKeyOnly(): Promise<{ publicKey: string; fingerprint: string }> {
  const publicKey = _cachedPublic ?? (await loadOrCreateKeypair()).publicKey
  return { publicKey, fingerprint: fingerprintOf(publicKey) }
}

/** What is pinned for one peer. The NAME is display only and carries no authority — it is stored
 *  so the fingerprint list can say "Laptop B" instead of a token-hash prefix, which is what the
 *  "if you do not recognise a machine" instruction actually asks the user to read. */
interface Pin {
  publicKey: string
  machineName: string
}

type PinMap = Record<string, Pin>

async function readPins(connId: string): Promise<PinMap> {
  const raw = await safeReadJson<unknown>(envelopePinsFile(connId))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PinMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // A bare string is the earlier on-disk form (key only, no name). Read it rather than discard
    // it: dropping a pin would silently downgrade an established peer back to first sight.
    if (typeof v === 'string' && v !== '') { out[k] = { publicKey: v, machineName: '' }; continue }
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    if (typeof o.publicKey !== 'string' || o.publicKey === '') continue
    out[k] = { publicKey: o.publicKey, machineName: typeof o.machineName === 'string' ? o.machineName : '' }
  }
  return out
}

/** The key pinned for a peer on this connection, or `null` at first sight. */
export async function pinnedKeyFor(connId: string, machineId: string): Promise<string | null> {
  return (await readPins(connId))[machineId]?.publicKey ?? null
}

/**
 * Apply trust-on-first-use to a peer key the central just handed over. Returns what happened; the
 * caller decides what that means. A `'changed'` decision NEVER overwrites the stored pin — the
 * whole point is that the old key stays the reference until a human resolves it.
 */
export async function pinPeerKey(
  connId: string,
  machineId: string,
  publicKey: string,
  machineName = '',
): Promise<PinDecision> {
  if (!machineId || !publicKey) return 'changed'
  const pins = await readPins(connId)
  const decision = decidePin(pins[machineId]?.publicKey, publicKey)
  if (decision === 'new') {
    pins[machineId] = { publicKey, machineName }
    await writePrivate(envelopePinsFile(connId), JSON.stringify(pins, null, 2))
    return decision
  }
  // A machine can be RENAMED on the central, and a stale label in the fingerprint list is worse
  // than none. Only the display name is refreshed, and only when it actually differs — never the
  // key, and never a write per poll. The name is not authority: `decidePin` has already run.
  if (decision === 'same' && machineName && pins[machineId]!.machineName !== machineName) {
    pins[machineId] = { publicKey, machineName }
    await writePrivate(envelopePinsFile(connId), JSON.stringify(pins, null, 2))
  }
  return decision
}

/** Every pinned peer on a connection, with fingerprints — for the "compare two machines you own"
 *  affordance in the UI. Public keys only; there is nothing secret in this list. */
export async function pinnedPeers(
  connId: string,
): Promise<{ machineId: string; machineName: string; fingerprint: string }[]> {
  const pins = await readPins(connId)
  return Object.entries(pins)
    .map(([machineId, pin]) => ({
      machineId,
      machineName: pin.machineName,
      fingerprint: fingerprintOf(pin.publicKey),
    }))
    .sort((a, b) => (a.machineName || a.machineId).localeCompare(b.machineName || b.machineId))
}
