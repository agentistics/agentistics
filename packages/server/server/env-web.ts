/**
 * `/api/env` — DOCKER.AMBIENTES S1: which backend a worker's environment runs on, the scoped choice, and the
 * install hint. One source for the CLI (`agentop env`) and the MCP tools (`agentistics_env_*`).
 *
 * Everything is behind the `docker-env` flag. With the flag off EVERY route answers 409 `flag_off` (reads included;
 * `agentop env status` says "off" locally). S1 creates no container, volume or image.
 *
 *   GET  /api/env/status?session=<id>&project=<key>&needs=a,b&image=<key>
 *   GET  /api/env/install-hint[?os=linux|wsl2|macos|windows]
 *   POST /api/env/use    { backend, scope?: session|project|all, target?, session?: {id, token} }
 *   POST /api/env/grant  { … }      — role gate only in S1; the concession itself is S2 (`grant_not_available`)
 *
* WHO MAY WRITE (`use`, `grant`): the PROVEN person (the connection's own identity, `deps.caller` — absence of a `session` field is not proof) or a VERIFIED session whose stored role is
 * `leader`. A worker is refused — it would be choosing where its own environment runs (the `away.ts` rule).
 */
import {
  applyEnvChoice, decideEnvBackend, envOfferKey, envOsOf, installHint, resolveEnvChoice, resolveEnvImage, ENV_IMAGES,
  type DockerFacts, type EnvBackend, type EnvBackendPrefs, type EnvChoiceSource, type EnvDecision, type EnvInstallHint,
  type EnvOs, type EnvPlatformState, type EnvUseError,
} from '@agentistics/core'

export interface EnvDeps {
  flag: () => boolean
  detect: () => Promise<DockerFacts>
  platform: () => { os: EnvOs; docker: EnvPlatformState }
  readPrefs: () => Promise<{ envBackend?: EnvBackendPrefs; envBackendOfferedFor?: string }>
  /** Writes ONE patch through the preferences write chain (never read-then-write here). */
  writePrefs: (mutate: (current: { envBackend?: EnvBackendPrefs }) => Record<string, unknown> | undefined) => Promise<void>
  verify: (id: unknown, token: unknown) => Promise<string | null>
  roleOf: (managedId: string) => Promise<'leader' | 'worker' | undefined>
  /** WHO is calling, read from the connection itself (never the body). Absent or anything but `person` refuses a write. */
  caller?: () => Promise<'person' | 'session' | 'unknown'>
  now: () => number
}

export interface EnvStatus {
  flag: boolean
  docker: DockerFacts
  platform: { os: EnvOs; docker: EnvPlatformState }
  decision: EnvDecision
  /** A stored `namespace` refusal that no longer applies because Docker's state changed since it was made. */
  refusalStale: boolean
  /** The choice that applied, and the scope it came from (`none` = nobody chose). */
  choice: { backend: EnvBackend | undefined; source: EnvChoiceSource }
  prefs: EnvBackendPrefs
  image: { ok: true; key: string; ref: string } | { ok: false; missing: string[] }
  /** The catalogue keys, so a person can see what a project may choose. */
  catalogue: string[]
  /** True when this exact Docker state was already offered (suggestion shown once; a refusal holds until it changes). */
  offeredFor: string
  alreadyOffered: boolean
  /** The install hint, present only when Docker is missing — the same text `GET /api/env/install-hint` gives. */
  install?: EnvInstallHint
}

/** Pure: the platform's Docker is validated only on native Linux/WSL Engine (§8.1); Desktop kinds and macOS/Windows are not. */
export function platformOf(proc: { platform: string; isWsl: boolean }, docker: DockerFacts): { os: EnvOs; docker: EnvPlatformState } {
  const os = envOsOf(proc.platform, proc.isWsl)
  const desktop = docker.kind === 'desktop' || docker.kind === 'wsl2-desktop'
  return { os, docker: (os === 'linux' || os === 'wsl2') && !desktop ? 'available' : 'unavailable' }
}

export interface StatusQuery { session?: string; project?: string; needs?: string[]; image?: string }

export async function envStatus(q: StatusQuery, deps: EnvDeps): Promise<EnvStatus> {
  const docker = await deps.detect()
  const platform = deps.platform()
  const prefs = await deps.readPrefs()
  const offeredFor = envOfferKey(docker, platform.docker)
  const found = resolveEnvChoice(prefs.envBackend, { sessionId: q.session, projectKey: q.project })
  // A refusal stands only while the state it was made against stands: Docker appearing or starting offers again.
  const stale = found.choice === 'namespace' && prefs.envBackendOfferedFor !== undefined && prefs.envBackendOfferedFor !== offeredFor
  const resolved = stale ? { choice: undefined, source: 'none' as const } : found
  const img = resolveEnvImage({ choose: q.image, needs: q.needs ?? [] })
  const decision = decideEnvBackend({
    flag: deps.flag(), docker, platform: platform.docker, choice: resolved.choice,
    image: img.ok ? { ok: true } : { ok: false, missing: img.missing },
  })
  return {
    flag: deps.flag(), docker, platform, decision, refusalStale: stale,
    choice: { backend: resolved.choice, source: resolved.source },
    prefs: prefs.envBackend ?? {},
    image: img.ok ? { ok: true, key: img.image.key, ref: img.image.ref } : { ok: false, missing: img.missing },
    catalogue: ENV_IMAGES.map(i => i.key),
    offeredFor, alreadyOffered: prefs.envBackendOfferedFor === offeredFor,
    ...(docker.present ? {} : { install: installHint(platform.os) }),
  }
}

export function envInstall(osParam: string | undefined, deps: EnvDeps): { ok: true; hint: EnvInstallHint; detectedOs: EnvOs } | { ok: false; error: 'bad_os' } {
  const detected = deps.platform().os
  if (osParam === undefined) return { ok: true, hint: installHint(detected), detectedOs: detected }
  if (osParam !== 'linux' && osParam !== 'wsl2' && osParam !== 'macos' && osParam !== 'windows') return { ok: false, error: 'bad_os' }
  return { ok: true, hint: installHint(osParam), detectedOs: detected }
}

export type EnvWriteError = EnvUseError | 'flag_off' | 'unverified_sender' | 'leader_only' | 'person_unproven' | 'grant_not_available'
export type EnvWriteReply =
  | { ok: true; scope: string; backend: EnvBackend; target?: string; prefs: EnvBackendPrefs }
  | { ok: false; error: EnvWriteError }

/** The caller's authority: the person (no proof), or a verified leader. Returns the verified id for self-scoping. */
async function authorise(body: unknown, deps: EnvDeps): Promise<{ ok: true; sender?: string } | { ok: false; error: 'unverified_sender' | 'leader_only' | 'person_unproven' }> {
  const o = (body && typeof body === 'object' ? body : {}) as { session?: { id?: unknown; token?: unknown } }
  // No session claim is NOT "the person": the person must be PROVEN. The proof is the connection's own identity —
  // the socket → process-tree reader the browser padlock and "delete profiles" already use for their person-only
  // acts (`browser-caller.ts`: `session` and `unknown` both refuse, fail-closed). No `caller` dep = no proof.
  if (o.session === undefined) {
    return (await deps.caller?.().catch(() => 'unknown' as const)) === 'person' ? { ok: true } : { ok: false, error: 'person_unproven' }
  }
  const sender = await deps.verify(o.session?.id, o.session?.token)
  if (!sender) return { ok: false, error: 'unverified_sender' }
  if ((await deps.roleOf(sender)) !== 'leader') return { ok: false, error: 'leader_only' }
  return { ok: true, sender }
}

let writes: Promise<unknown> = Promise.resolve()
const serial = <T>(f: () => Promise<T>): Promise<T> => { const r = writes.then(f); writes = r.catch(() => {}); return r }

export function envUse(body: unknown, deps: EnvDeps): Promise<EnvWriteReply> {
  return serial(async () => {
    if (!deps.flag()) return { ok: false, error: 'flag_off' }
    const who = await authorise(body, deps)
    if (!who.ok) return who
    const o = (body && typeof body === 'object' ? body : {}) as { backend?: unknown; scope?: unknown; target?: unknown }
    // A leader choosing "only this session" without naming one means its own.
    const target = o.target ?? (o.scope === 'session' ? who.sender : undefined)
    let reply: EnvWriteReply | undefined
    // A refusal (`namespace`) is made against the Docker state of THIS moment and holds until that state changes.
    const offeredFor = o.backend === 'namespace' ? envOfferKey(await deps.detect(), deps.platform().docker) : undefined
    await deps.writePrefs(current => {
      const r = applyEnvChoice(current.envBackend, { scope: o.scope, backend: o.backend, target })
      if (!r.ok) { reply = { ok: false, error: r.error }; return undefined }
      reply = { ok: true, scope: String(o.scope ?? 'all'), backend: o.backend as EnvBackend, ...(typeof target === 'string' ? { target } : {}), prefs: r.prefs }
      return { envBackend: r.prefs, envBackendChosenAt: new Date(deps.now()).toISOString(), ...(offeredFor ? { envBackendOfferedFor: offeredFor } : {}) }
    })
    return reply ?? { ok: false, error: 'bad_backend' }
  })
}

/** S1 ships the gate only: who may grant is decided here; what a grant IS lands with S2 (§5.1). */
export async function envGrant(body: unknown, deps: EnvDeps): Promise<EnvWriteReply> {
  if (!deps.flag()) return { ok: false, error: 'flag_off' }
  const who = await authorise(body, deps)
  if (!who.ok) return who
  return { ok: false, error: 'grant_not_available' }
}

/**
 * WHO is calling, from the connection's verdict. A REMOTE peer (LAN opt-in) is a network address, not a person: it
 * counts as the person for a write only with the owner's grant (the same one the personal-browser padlock uses).
 */
export function envCallerFrom(verdict: { kind: string; via?: string }, hasOwnerGrant: boolean): 'person' | 'session' | 'unknown' {
  if (verdict.kind === 'session') return 'session'
  if (verdict.kind !== 'person') return 'unknown'
  return verdict.via === 'remote' && !hasOwnerGrant ? 'unknown' : 'person'
}

export function envStatusCode(r: { ok: boolean; error?: string }): number {
  if (r.ok) return 200
  switch (r.error) {
    case 'unverified_sender': return 401
    case 'leader_only': case 'person_unproven': return 403
    case 'flag_off': return 409
    case 'grant_not_available': return 501
    default: return 400
  }
}

/** Dispatch for index.ts. Returns `null` for a path/method this module does not own. */
export async function handleEnvRequest(req: Request, url: URL, deps: EnvDeps): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname
  // Flag off: the whole surface answers as disabled — reads included (the person sees WHY via `agentop env status`,
  // which says off locally). Only the paths this module owns are answered; anything else stays `null`.
  const owned = (p === '/api/env/status' || p === '/api/env/install-hint') ? req.method === 'GET'
    : (p === '/api/env/use' || p === '/api/env/grant') ? req.method === 'POST' : false
  if (owned && !deps.flag()) return { status: 409, body: { ok: false, error: 'flag_off' } }
  if (p === '/api/env/status' && req.method === 'GET') {
    const q = url.searchParams
    const needs = (q.get('needs') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return { status: 200, body: await envStatus({ session: q.get('session') ?? undefined, project: q.get('project') ?? undefined, needs, image: q.get('image') ?? undefined }, deps) }
  }
  if (p === '/api/env/install-hint' && req.method === 'GET') {
    await deps.detect().catch(() => undefined)
    const r = envInstall(url.searchParams.get('os') ?? undefined, deps)
    return { status: r.ok ? 200 : 400, body: r }
  }
  if ((p === '/api/env/use' || p === '/api/env/grant') && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const r = p === '/api/env/use' ? await envUse(body, deps) : await envGrant(body, deps)
    return { status: envStatusCode(r), body: r }
  }
  return null
}
