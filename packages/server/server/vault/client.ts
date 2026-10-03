/**
 * vault/client.ts — what a process that is NOT the agentop service uses instead of opening the vault
 * (SECRETS.4 §5.2). Every function here asks the running service over `vault.sock` (ops.ts); none of
 * them can return a human-scope plaintext, because no op does. When nothing answers, the refusal is
 * `service-down`, in words — never a quiet fallback to opening the vault here.
 */
import { VaultRefusalError } from '@agentistics/vault'
import { refusal } from './service'
import { askVault, type AskOptions } from './socket'

function fail(r: Awaited<ReturnType<typeof askVault>>): VaultRefusalError {
  if (!r) return refusal('service-down')
  const rep = r.reply as { code?: string; sentence?: string }
  return new VaultRefusalError((rep.code ?? 'locked') as never, rep.sentence ?? 'the vault service refused')
}

/** Seal through the service: the plaintext goes in, the sealed file's bytes come back. THROWS a refusal. */
export async function remoteSeal(purpose: string, name: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const r = await askVault({ op: 'seal', purpose, name }, { body: plaintext })
  if (!r || !r.reply.ok || !r.body) throw fail(r)
  return r.body
}

/** The preferences write's token half, done by the service. `null` = no service answered. */
export async function remotePrefsTokens(prefsFile: string, next: Record<string, unknown>, previous: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  const r = await askVault({ op: 'prefs-tokens', prefsFile, next, previous })
  if (!r) return null
  if (!r.reply.ok) throw fail(r)
  return (r.reply as unknown as { stripped: Record<string, unknown> }).stripped
}

export type RemoteGithubConfig =
  | { state: 'absent' }
  | { state: 'refused'; sentence: string }
  | { state: 'ok'; config: Record<string, unknown>; hasToken: boolean }

export async function remoteGithubConfig(): Promise<RemoteGithubConfig> {
  const r = await askVault({ op: 'github-config' })
  if (!r) return { state: 'refused', sentence: refusal('service-down').message }
  const rep = r.reply as Record<string, unknown>
  if (!rep.ok) return { state: 'refused', sentence: String(rep.sentence ?? '') }
  if (rep.state === 'ok') return { state: 'ok', config: rep.config as Record<string, unknown>, hasToken: rep.hasToken === true }
  if (rep.state === 'refused') return { state: 'refused', sentence: String(rep.sentence ?? '') }
  return { state: 'absent' }
}

/**
 * A `fetch` that sends the request through the service, which adds the stored GitHub token and only
 * for the configured repository. Returns a real `Response` so `gh()` reads it exactly as it reads one
 * from the network. A refusal comes back as a synthetic 4xx with the sentence as the GitHub message.
 */
export async function serviceGithubFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((v, k) => { if (k !== 'authorization') headers[k] = v })
  let body: Uint8Array | undefined
  if (init.body != null) body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
  const o: AskOptions = { timeoutMs: 30 * 60_000, ...(body ? { body } : {}) }
  const r = await askVault({ op: 'github-fetch', method: (init.method ?? 'GET').toUpperCase(), url, headers }, o)
  if (!r) throw new Error(refusal('service-down').message)
  const rep = r.reply as Record<string, unknown>
  if (!rep.ok) {
    return new Response(JSON.stringify({ message: String(rep.sentence ?? 'refused') }), { status: rep.code === 'absent' ? 401 : 403, headers: { 'content-type': 'application/json' } })
  }
  return new Response((r.body ?? new Uint8Array(0)) as unknown as BodyInit, { status: Number(rep.httpStatus), headers: rep.headers as Record<string, string> })
}

export type MongoKind = 'none' | 'bundled' | 'external'
export async function remoteCentralMongoKind(envFile: string): Promise<MongoKind | null> {
  const r = await askVault({ op: 'central-mongo-kind', envFile })
  const k = r?.reply.ok ? (r.reply as { kind?: unknown }).kind : null
  return k === 'none' || k === 'bundled' || k === 'external' ? k : null
}

/** Run a command the service spawns for us; its output is written to OUR stdout/stderr. */
export async function remoteSpawn(req: Record<string, unknown> & { op: string }, write: { out(s: string): void; err(s: string): void }): Promise<{ ok: true; exit: number } | { ok: false; sentence: string }> {
  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.once('SIGINT', onSig)
  try {
    const r = await askVault(req, { signal: ac.signal, timeoutMs: 0, onStream: (s, d) => (s === 'out' ? write.out(d) : write.err(d)) })
    if (!r) return { ok: false, sentence: ac.signal.aborted ? 'stopped' : refusal('service-down').message }
    const rep = r.reply as Record<string, unknown>
    if (!rep.ok) return { ok: false, sentence: String(rep.sentence ?? 'refused') }
    return { ok: true, exit: Number(rep.exit ?? 1) }
  } finally {
    process.off('SIGINT', onSig)
  }
}
