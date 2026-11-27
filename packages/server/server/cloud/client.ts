/**
 * cloud/client.ts — the machine side of pairing with Agentistics Cloud, per
 * `@agentistics/contract`: the device-authorization grant (RFC 8628) with every request signed by
 * the machine key (DPoP, RFC 9449), and key-bound refresh of short-lived access tokens.
 *
 * `cloudUrl` is only used to PAIR. Once paired, every request goes to the URL stored in the
 * credential, so a changed setting can never send the refresh token somewhere else. Redirects are
 * refused for the same reason. The access token lives in memory only.
 */
import {
  DEVICE_CODE_GRANT, FLOW_NAMES, MACHINE_CLIENT_ID, PAIRING, PATHS,
  type MachineKind, type MachineSelf, type PairingFlows,
} from '@agentistics/contract'
import { createProof } from './dpop'
import {
  loadCredential, loadOrCreateIdentity, removeCredential, saveCredential,
  type MachineIdentity, type SealedStore, type StoredCredential,
} from './identity'

export type CloudFetch = (req: Request) => Promise<Response>

/** Refresh this long before the access token expires, so a request never races the expiry. */
export const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

export interface PairingStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type PollResult =
  | { status: 'pending' | 'slow_down' | 'denied' | 'expired' }
  | { status: 'paired'; machineId: string; workspaceId: string; flows: PairingFlows }

/** The Cloud refused the stored credential (revoked, idle too long, owner left) or there is none. */
export class PairingRequiredError extends Error {
  override readonly name = 'PairingRequiredError'
  constructor() {
    super('pairing_required')
  }
}

/** The Cloud answered something the contract does not allow, or an error the caller cannot act on. */
export class CloudError extends Error {
  override readonly name = 'CloudError'
  constructor(readonly code: string, readonly status: number) {
    super(`${code} (HTTP ${status})`)
  }
}

type Body = Record<string, unknown>

const readBody = async (res: Response): Promise<Body> => {
  const v: unknown = await res.json().catch(() => ({}))
  return v && typeof v === 'object' ? (v as Body) : {}
}

/** An error code is an open set; only a code-shaped one is repeated, anything else is the status. */
const errorCode = (body: Body, status: number): string =>
  typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : String(status)

/** Exactly the contract's switches (`FLOW_NAMES`): one the Cloud does not send is off. */
export function readFlows(raw: unknown): PairingFlows {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return Object.fromEntries(FLOW_NAMES.map((n) => [n, f[n] === true])) as PairingFlows
}

function need(body: Body, key: string, status: number): string {
  const v = body[key]
  if (typeof v !== 'string' || v === '') throw new CloudError('invalid_response', status)
  return v
}

/**
 * Polls at the server's interval (+5 s after each `slow_down`, RFC 8628 §3.5) until a final answer
 * or the code's expiry.
 */
export async function pollUntilFinal<R extends { status: string }>(
  start: { interval: number; expiresIn: number },
  poll: () => Promise<R>,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<R | { status: 'expired' }> {
  let interval = start.interval
  for (let waited = 0; waited < start.expiresIn; waited += interval) {
    await sleep(interval * 1000)
    const result = await poll()
    if (result.status === 'slow_down') interval += PAIRING.slowDownIncrementS
    else if (result.status !== 'pending') return result
  }
  return { status: 'expired' }
}

export class MachineClient {
  private identity: MachineIdentity | null = null
  private credential: StoredCredential | null = null
  private access: { token: string; expiresAt: number } | null = null
  private readonly fetchImpl: CloudFetch
  private readonly now: () => number

  constructor(
    private readonly opts: {
      cloudUrl: string
      /** The sealed identity and credential. */
      store: SealedStore
      fetch?: CloudFetch
      now?: () => number
    },
  ) {
    this.fetchImpl = opts.fetch ?? ((req) => fetch(req))
    this.now = opts.now ?? Date.now
  }

  async loadIdentity(): Promise<MachineIdentity> {
    this.identity ??= await loadOrCreateIdentity(this.opts.store)
    return this.identity
  }

  private send(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(new Request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
  }

  private async post(base: string, path: string, form: Record<string, string>): Promise<{ status: number; body: Body }> {
    const identity = await this.loadIdentity()
    const url = `${base}${path}`
    const proof = createProof({ privateKey: identity.signingKey, publicJwk: identity.signingJwk, method: 'POST', url, now: this.now() })
    const res = await this.send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: proof },
      body: new URLSearchParams({ client_id: MACHINE_CLIENT_ID, ...form }).toString(),
    })
    return { status: res.status, body: await readBody(res) }
  }

  /** Step 1: register the public keys and get the code the person types in the browser. */
  async startPairing(machine: { name: string; kind?: MachineKind }): Promise<PairingStart> {
    const identity = await this.loadIdentity()
    const { status, body } = await this.post(this.opts.cloudUrl, PATHS.deviceAuthorization, {
      envelope_key: identity.envelope.publicKey,
      name: machine.name,
      kind: machine.kind ?? 'device',
    })
    if (status !== 200) throw new CloudError(errorCode(body, status), status)
    const expiresIn = Number(body.expires_in)
    const interval = Number(body.interval)
    if (!(expiresIn > 0) || !(interval > 0)) throw new CloudError('invalid_response', status)
    return {
      deviceCode: need(body, 'device_code', status),
      userCode: need(body, 'user_code', status),
      verificationUri: need(body, 'verification_uri', status),
      verificationUriComplete: need(body, 'verification_uri_complete', status),
      expiresIn,
      interval,
    }
  }

  /** Step 2: one poll. On success the credential is sealed on disk before this returns. */
  async poll(deviceCode: string): Promise<PollResult> {
    const { status, body } = await this.post(this.opts.cloudUrl, PATHS.token, { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode })
    if (status === 200) {
      const credential = {
        cloudUrl: this.opts.cloudUrl,
        machineId: need(body, 'machine_id', status),
        workspaceId: need(body, 'workspace_id', status),
        refreshToken: need(body, 'refresh_token', status),
      }
      const token = need(body, 'access_token', status)
      await saveCredential(this.opts.store, credential)
      this.credential = { version: 1, ...credential }
      this.setAccess(token, body)
      return { status: 'paired', machineId: credential.machineId, workspaceId: credential.workspaceId, flows: readFlows(body.flows) }
    }
    switch (body.error) {
      case 'authorization_pending':
        return { status: 'pending' }
      case 'slow_down':
      // A 429 from the Cloud's per-address limits: back off the same way.
      case 'rate_limited':
        return { status: 'slow_down' }
      case 'access_denied':
        return { status: 'denied' }
      case 'expired_token':
        return { status: 'expired' }
    }
    throw new CloudError(errorCode(body, status), status)
  }

  private setAccess(token: string, body: Body): void {
    const expiresIn = Number(body.expires_in)
    this.access = { token, expiresAt: this.now() + (expiresIn > 0 ? expiresIn : 0) * 1000 }
  }

  private async loadPaired(): Promise<StoredCredential> {
    this.credential ??= await loadCredential(this.opts.store)
    if (!this.credential) throw new PairingRequiredError()
    return this.credential
  }

  /** A valid access token, refreshing with a key-signed request when it is about to expire. */
  async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.access.token
    return this.refresh()
  }

  async refresh(): Promise<string> {
    const credential = await this.loadPaired()
    const { status, body } = await this.post(credential.cloudUrl, PATHS.token, { grant_type: 'refresh_token', refresh_token: credential.refreshToken })
    if (status !== 200) {
      this.access = null
      if (body.error === 'invalid_grant') throw new PairingRequiredError()
      throw new CloudError(errorCode(body, status), status)
    }
    const token = need(body, 'access_token', status)
    this.setAccess(token, body)
    return token
  }

  /**
   * A request to the Cloud API as this machine: the DPoP-bound token plus a fresh proof for this
   * exact request. An `invalid_token` answer refreshes once and retries (the contract's rule).
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const identity = await this.loadIdentity()
    const { cloudUrl } = await this.loadPaired()
    const url = `${cloudUrl}${path}`
    const method = (init.method ?? 'GET').toUpperCase()
    const attempt = async () => {
      const accessToken = await this.accessToken()
      const headers = new Headers(init.headers)
      headers.set('authorization', `DPoP ${accessToken}`)
      headers.set('dpop', createProof({ privateKey: identity.signingKey, publicJwk: identity.signingJwk, method, url, now: this.now(), accessToken }))
      return this.send(url, { ...init, method, headers })
    }
    const res = await attempt()
    if (res.status !== 401 || (await readBody(res.clone())).error !== 'invalid_token') return res
    this.access = null
    return attempt()
  }

  /** `GET /v1/machine`: this machine's own record as the Cloud holds it. */
  async getMachine(): Promise<MachineSelf> {
    const res = await this.request(PATHS.machine)
    const body = await readBody(res)
    if (res.status !== 200) throw new CloudError(errorCode(body, res.status), res.status)
    need(body, 'id', res.status)
    need(body, 'name', res.status)
    return { ...(body as unknown as MachineSelf), flows: readFlows(body.flows) }
  }

  /**
   * `POST /v1/machine/disconnect`, then the local credential is removed. `already-revoked`: the
   * Cloud no longer accepts this credential, so only the local copy was left to remove. Any other
   * failure keeps the credential, so the person can try again.
   */
  async disconnect(): Promise<'disconnected' | 'already-revoked'> {
    let outcome: 'disconnected' | 'already-revoked' = 'disconnected'
    try {
      const res = await this.request(PATHS.disconnect, { method: 'POST' })
      if (res.status !== 204) throw new CloudError(errorCode(await readBody(res), res.status), res.status)
    } catch (err) {
      if (!(err instanceof PairingRequiredError)) throw err
      outcome = 'already-revoked'
    }
    await removeCredential(this.opts.store)
    this.credential = null
    this.access = null
    return outcome
  }
}
