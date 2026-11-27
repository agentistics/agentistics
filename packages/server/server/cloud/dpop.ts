/**
 * cloud/dpop.ts — proof of possession of the machine key: a DPoP proof (RFC 9449) signed with the
 * machine's Ed25519 key, `alg: EdDSA` only (`@agentistics/contract` DPOP). PURE apart from the
 * random `jti`.
 *
 * A proof names the HTTP method and URL it was made for, a unique `jti` and an `iat`; on API
 * requests it also carries `ath`, the hash of the access token, so a token copied without the key
 * is useless. The machine is identified by the RFC 7638 thumbprint of the header's `jwk`.
 */
import { createHash, sign, type KeyObject } from 'node:crypto'
import { DPOP } from '@agentistics/contract'

export interface Ed25519PublicJwk {
  kty: 'OKP'
  crv: 'Ed25519'
  x: string
}

const b64url = (value: string | Uint8Array) => Buffer.from(value).toString('base64url')

/** `ath`: base64url sha256 of the access token's ASCII bytes. */
export function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('base64url')
}

/** The request a proof is for: method and URL without query or fragment (RFC 9449 §4.3). */
export function proofTarget(method: string, url: string): { htm: string; htu: string } {
  const u = new URL(url)
  return { htm: method.toUpperCase(), htu: `${u.origin}${u.pathname}` }
}

export function createProof(opts: {
  privateKey: KeyObject
  publicJwk: Ed25519PublicJwk
  method: string
  url: string
  now?: number
  jti?: string
  /** Binds the proof to this access token (`ath`); required on API requests. */
  accessToken?: string
}): string {
  const { htm, htu } = proofTarget(opts.method, opts.url)
  const header = { typ: DPOP.typ, alg: DPOP.alg, jwk: { kty: 'OKP', crv: DPOP.crv, x: opts.publicJwk.x } }
  const payload = {
    jti: opts.jti ?? b64url(crypto.getRandomValues(new Uint8Array(24))),
    htm,
    htu,
    iat: Math.floor((opts.now ?? Date.now()) / 1000),
    ...(opts.accessToken ? { ath: accessTokenHash(opts.accessToken) } : {}),
  }
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  return `${input}.${b64url(sign(null, Buffer.from(input), opts.privateKey))}`
}
