/**
 * cloud/identity.ts — the machine's Cloud keys and credential, SEALED by the machine's vault.
 *
 * `~/.agentistics/cloud-identity.sealed` holds the Ed25519 signing key (DPoP) and the X25519
 * envelope key; `~/.agentistics/cloud-credential.sealed` holds what the Cloud gave this machine at
 * pairing (the refresh token). Same rule as `backup/github-store.ts`: never plain text — with no
 * vault able to seal, the write REFUSES with the vault's sentence. Both are `secret` rows in
 * `backup-plan.ts`. Only the agentop service opens them (SECRETS.4 §5.2), so this module touches no
 * file itself: the service hands it a `SealedStore` (`cloudSealedStore` in vault/ops.ts).
 * `publicIdentity()` is the only shape of the identity that may leave.
 *
 * A stored identity that cannot be read is never silently replaced: a new key would orphan the
 * paired machine, so the caller gets the refusal and decides.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { Ed25519PublicJwk } from './dpop'

export const IDENTITY_FILE = 'cloud-identity.sealed'
export const CREDENTIAL_FILE = 'cloud-credential.sealed'
const IDENTITY_PURPOSE = 'cloud-identity'
const CREDENTIAL_PURPOSE = 'cloud-credential'

/** The two sealed files, as the vault holder reads and writes them. */
export interface SealedStore {
  /** Where the files are; also the key two concurrent creations are serialised on. */
  readonly dir: string
  /** null = absent. THROWS the vault's refusal for a file that exists and cannot be opened. */
  read(file: string, purpose: string): Promise<Uint8Array | null>
  write(file: string, purpose: string, plaintext: Uint8Array): Promise<void>
  /** Removes the file; idempotent. */
  remove(file: string): Promise<void>
}

interface StoredIdentity {
  version: 1
  /** base64 SPKI / PKCS8 DER */
  signing: { publicKey: string; privateKey: string }
  envelope: { publicKey: string; privateKey: string }
}

export interface MachineIdentity {
  signingKey: KeyObject
  signingJwk: Ed25519PublicJwk
  signingPublic: string
  envelope: { publicKey: string; privateKey: string }
}

/** What the Cloud gave this machine at pairing; the refresh token is useless without the signing key. */
export interface StoredCredential {
  version: 1
  /** The Cloud this credential was issued by. The token is only ever sent there. */
  cloudUrl: string
  machineId: string
  workspaceId: string
  refreshToken: string
}

/** A stored cloud file opens but does not hold what it should. */
export class CloudStoreError extends Error {
  override readonly name = 'CloudStoreError'
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const spkiOf = (key: KeyObject) => (key.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
const pkcs8Of = (key: KeyObject) => (key.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64')

/** The Cloud's rule: first 16 bytes of sha256 over the SPKI DER, groups of four hex characters. */
export function fingerprintOf(spkiB64: string): string {
  const hex = createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').slice(0, 32)
  return (hex.match(/.{4}/g) ?? []).join(' ')
}

async function readSealed(store: SealedStore, file: string, purpose: string): Promise<unknown | undefined> {
  const bytes = await store.read(file, purpose)
  if (bytes === null) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  } finally {
    bytes.fill(0)
  }
}

const writeSealed = (store: SealedStore, file: string, purpose: string, value: unknown): Promise<void> =>
  store.write(file, purpose, new TextEncoder().encode(JSON.stringify(value)))

const damaged = (file: string) => new CloudStoreError('damaged',
  `${file} is damaged and was left as it is. Delete it to start over; this machine must then pair again.`)

function fromStored(stored: StoredIdentity): MachineIdentity | null {
  try {
    const signingKey = createPrivateKey({ key: Buffer.from(stored.signing.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    const pub = createPublicKey(signingKey)
    if (signingKey.asymmetricKeyType !== 'ed25519' || spkiOf(pub) !== stored.signing.publicKey) return null
    const envelope = createPublicKey({ key: Buffer.from(stored.envelope.publicKey, 'base64'), format: 'der', type: 'spki' })
    if (envelope.asymmetricKeyType !== 'x25519') return null
    const jwk = pub.export({ format: 'jwk' }) as { x: string }
    return { signingKey, signingJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, signingPublic: stored.signing.publicKey, envelope: stored.envelope }
  } catch {
    return null
  }
}

function generate(): StoredIdentity {
  const signing = generateKeyPairSync('ed25519')
  const envelope = generateKeyPairSync('x25519')
  return {
    version: 1,
    signing: { publicKey: spkiOf(signing.publicKey), privateKey: pkcs8Of(signing.privateKey) },
    envelope: { publicKey: spkiOf(envelope.publicKey), privateKey: pkcs8Of(envelope.privateKey) },
  }
}

/** One creation at a time per file: two requests at once must end with ONE identity. */
const creating = new Map<string, Promise<MachineIdentity>>()

/** This machine's identity, generated and sealed the first time. */
export function loadOrCreateIdentity(store: SealedStore): Promise<MachineIdentity> {
  const running = creating.get(store.dir)
  if (running) return running
  const p = (async () => {
    const stored = await readSealed(store, IDENTITY_FILE, IDENTITY_PURPOSE)
    if (stored !== undefined) {
      const s = stored as StoredIdentity | null
      const identity = s?.version === 1 ? fromStored(s) : null
      if (!identity) throw damaged(IDENTITY_FILE)
      return identity
    }
    const fresh = generate()
    await writeSealed(store, IDENTITY_FILE, IDENTITY_PURPOSE, fresh)
    return fromStored(fresh)!
  })().finally(() => creating.delete(store.dir))
  creating.set(store.dir, p)
  return p
}

/** The only shape of the identity that may be shown or sent. */
export function publicIdentity(identity: MachineIdentity) {
  return {
    signingFingerprint: fingerprintOf(identity.signingPublic),
    envelopeKey: identity.envelope.publicKey,
    envelopeFingerprint: fingerprintOf(identity.envelope.publicKey),
  }
}

export async function saveCredential(store: SealedStore, credential: Omit<StoredCredential, 'version'>): Promise<void> {
  await writeSealed(store, CREDENTIAL_FILE, CREDENTIAL_PURPOSE, { version: 1, ...credential })
}

/** `null` = not paired. A file that exists and cannot be opened THROWS: it is never read as "not paired". */
export async function loadCredential(store: SealedStore): Promise<StoredCredential | null> {
  const raw = await readSealed(store, CREDENTIAL_FILE, CREDENTIAL_PURPOSE)
  if (raw === undefined) return null
  const c = raw as Partial<StoredCredential> | null
  if (!c || c.version !== 1 || typeof c.cloudUrl !== 'string' || typeof c.machineId !== 'string'
    || typeof c.workspaceId !== 'string' || typeof c.refreshToken !== 'string') throw damaged(CREDENTIAL_FILE)
  return c as StoredCredential
}

/** Removes the credential (the identity keys stay, per the contract). Needs no key; idempotent. */
export async function removeCredential(store: SealedStore): Promise<void> {
  await store.remove(CREDENTIAL_FILE)
}
