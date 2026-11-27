/**
 * cloud/ops.ts — what the SERVICE does for `agentop cloud …` (vault/ops.ts dispatches the
 * `cloud-*` ops here). Only the service opens the sealed keys and credential (SECRETS.4 §5.2), so
 * pairing, refresh and every Cloud request run here; a reply carries only what a person is shown.
 * The device code, both tokens and the private keys never leave this process.
 */
import { randomUUID } from 'node:crypto'
import { CloudError, MachineClient, PairingRequiredError, type CloudFetch } from './client'
import { CloudStoreError, loadCredential, loadOrCreateIdentity, publicIdentity, removeCredential, type SealedStore } from './identity'
import { normalizeCloudUrl } from './url'

export type CloudReply =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; code: string; sentence: string }

export interface CloudDeps {
  store: SealedStore
  fetch?: CloudFetch
  now?: () => number
}

export const CLOUD_OPS = ['cloud-login-start', 'cloud-login-poll', 'cloud-status', 'cloud-logout'] as const
export type CloudOp = (typeof CLOUD_OPS)[number]

/** Pairings waiting for the person's approval: in memory only, gone with the code or a restart. */
const MAX_PENDING = 4
const pending = new Map<string, { client: MachineClient; deviceCode: string; url: string; expiresAt: number }>()

const refuse = (code: string, sentence: string): CloudReply => ({ ok: false, code, sentence })

const PAIR_AGAIN = 'The Cloud no longer accepts this machine\'s credential. Run `agentop cloud login` to pair again.'

function failure(err: unknown, url: string): CloudReply {
  if (err instanceof CloudStoreError) return refuse(err.code, err.message)
  // By name: importing the class would pull the vault's file writers into this module.
  if (err instanceof Error && err.name === 'VaultRefusalError') return refuse(String((err as { code?: unknown }).code), err.message)
  if (err instanceof PairingRequiredError) return refuse('pairing_required', PAIR_AGAIN)
  if (err instanceof CloudError) return refuse(err.code, `The Cloud at ${url} refused the request: ${err.message}.`)
  // Never the transport's own text: it can quote the request.
  return refuse('unreachable', `The Cloud at ${url} could not be reached.`)
}

export async function handleCloudOp(op: CloudOp, header: Record<string, unknown>, deps: CloudDeps): Promise<CloudReply> {
  const { store } = deps
  const now = deps.now ?? Date.now
  const client = (url: string) => new MachineClient({ cloudUrl: url, store, ...(deps.fetch ? { fetch: deps.fetch } : {}), now })
  let url = ''
  try {
    if (op === 'cloud-login-start') {
      const target = normalizeCloudUrl(header.url)
      const name = typeof header.name === 'string' ? header.name.trim() : ''
      if (!target || !name || name.length > 80) return refuse('bad-request', 'bad request')
      url = target
      const existing = await loadCredential(store)
      if (existing) {
        url = existing.cloudUrl
        try {
          await client(url).refresh()
          return refuse('already_connected', `This machine is already connected to ${url}. Run \`agentop cloud logout\` first.`)
        } catch (err) {
          // Only a credential the Cloud rejected may be paired over; anything else is left alone.
          if (!(err instanceof PairingRequiredError)) throw err
        }
        url = target
      }
      const c = client(url)
      const start = await c.startPairing({ name })
      for (const [h, p] of pending) if (p.expiresAt <= now()) pending.delete(h)
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
      const handle = randomUUID()
      pending.set(handle, { client: c, deviceCode: start.deviceCode, url, expiresAt: now() + start.expiresIn * 1000 })
      return {
        ok: true, handle,
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete,
        expiresIn: start.expiresIn,
        interval: start.interval,
      }
    }

    if (op === 'cloud-login-poll') {
      const handle = typeof header.handle === 'string' ? header.handle : ''
      const p = pending.get(handle)
      if (!p) return refuse('no_pairing', 'That pairing is no longer waiting (the service may have restarted). Run `agentop cloud login` again.')
      url = p.url
      const r = await p.client.poll(p.deviceCode)
      if (r.status !== 'pending' && r.status !== 'slow_down') pending.delete(handle)
      return { ok: true, ...r }
    }

    const credential = await loadCredential(store)
    if (!credential) return { ok: true, connected: false }
    url = credential.cloudUrl

    if (op === 'cloud-status') {
      const local = publicIdentity(await loadOrCreateIdentity(store))
      try {
        const m = await client(url).getMachine()
        return {
          ok: true, connected: true, cloudUrl: url,
          machine: { id: m.id, name: m.name, kind: m.kind, workspaceId: m.workspaceId, pairedAt: m.pairedAt, flows: m.flows },
          signingFingerprint: local.signingFingerprint,
          envelopeFingerprint: local.envelopeFingerprint,
        }
      } catch (err) {
        if (err instanceof PairingRequiredError) return { ok: true, connected: false, cloudUrl: url, pairAgain: PAIR_AGAIN }
        throw err
      }
    }

    // cloud-logout
    if (header.local === true) {
      await removeCredential(store)
      return { ok: true, connected: true, cloudUrl: url, outcome: 'removed-locally' }
    }
    return { ok: true, connected: true, cloudUrl: url, outcome: await client(url).disconnect() }
  } catch (err) {
    return failure(err, url)
  }
}
