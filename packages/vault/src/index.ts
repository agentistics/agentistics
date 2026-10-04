/**
 * @agentistics/vault — secrets at rest.
 *
 * Every secret Agentistics writes is sealed (AES-256-GCM under a per-purpose HKDF subkey of one
 * per-machine data key), and that data key is stored only WRAPPED by the operating system's
 * protector — or by a passphrase, said in words, when there is none. Never plain text; `0600` is a
 * second layer, not the protection. See docs/security.md § "Secrets at rest".
 *
 * Pure apart from randomness and `node:crypto`: every file, process and keychain is reached through
 * an injected interface (`ProtectorIo`, `SecretFs`). It is NOT part of `@agentistics/core`, which
 * the web bundle imports.
 */
export * from './format'
export * from './seal'
export * from './sentences'
export * from './vault'
export * from './handle'
export * from './atomic'
export * from './migrate'
export * from './totp'
export * from './bip39-english'
export * from './recovery'
export * from './stepup-policy'
export * from './autolock'
export * from './unlock-policy'
export * from './protectors/types'
export * from './protectors/dpapi'
export * from './protectors/presence'
export * from './protectors/hello'
export * from './protectors/fido2'
export * from './protectors/keychain'
export * from './protectors/libsecret'
export * from './protectors/systemd-creds'
export * from './protectors/passphrase'
export * from './protectors/memory'
export * from './personal'
export * from './webauthn'
export * from './scrub'
export * from './bundle'
export * from './phone-wrap'
