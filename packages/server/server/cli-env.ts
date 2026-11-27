/**
 * `agentop env status|use|install-hint|grant` — DOCKER.AMBIENTES S1 from the terminal.
 *
 *   agentop env status [--json] [--session [id]] [--project [key]] [--needs git,…] [--image key]
 *   agentop env use docker|namespace [--session [id] | --project [key] | --all]    (default scope: --all)
 *   agentop env install-hint [--os linux|wsl2|macos|windows] [--json]
 *   agentop env grant …                                                            (role gate only; the grant is S2)
 *
 * `install` is the INSTALL HINT for Docker itself — what to install on this operating system, what it costs, the
 * steps and the official page. It never installs anything and never runs `sudo`. (Installing the project's
 * dependencies inside a container, SPEC §3.5, is S2 and will not share this verb.)
 *
 * It asks the running server (`/api/env/*`, so the write goes through the server's chain) and, when none answers,
 * runs the very same handler in-process and says so (the machine-facing parts are injected: see `envCliIo`). Inside a session it carries that session's proof, so a
 * worker's shell is judged as a worker (a worker is refused on `use`/`grant`).
 */
import type { EnvInstallHint } from '@agentistics/core'
import type { EnvStatus } from './env-web'

export type EnvCommand =
  | { kind: 'status'; json: boolean; query: { session?: string; project?: string; needs?: string[]; image?: string } }
  | { kind: 'use'; body: { backend: string; scope: 'session' | 'project' | 'all'; target?: string } }
  | { kind: 'install-hint'; json: boolean; os?: string }
  | { kind: 'grant'; body: Record<string, unknown> }
  | { kind: 'error'; message: string }

const USAGE = [
  'usage: agentop env status [--json] [--session [id]] [--project [key]] [--needs git,…] [--image key]',
  '       agentop env use docker|namespace [--session [id] | --project [key] | --all]',
  '       agentop env install-hint [--os linux|wsl2|macos|windows] [--json]',
  '       agentop env install   (Docker backend: install the dependencies into this session\'s node_modules volume)',
].join('\n')

/** `--flag` with an optional value: the next token is the value unless it is another flag. */
function optionalValue(args: readonly string[], i: number): { value?: string; skip: number } {
  const next = args[i + 1]
  return next !== undefined && !next.startsWith('-') ? { value: next, skip: 1 } : { skip: 0 }
}

export function parseEnvArgs(args: readonly string[], env: Record<string, string | undefined> = {}, cwdProject?: string): EnvCommand {
  const [verb, ...rest] = args
  if (verb === undefined || verb === '--help' || verb === '-h') return { kind: 'error', message: USAGE }
  if (verb === 'grant') return { kind: 'grant', body: {} }
  if (verb === 'install-hint') {
    let json = false
    let os: string | undefined
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') json = true
      else if (rest[i] === '--os' && rest[i + 1]) os = rest[++i]
      else return { kind: 'error', message: `unknown argument ${rest[i]}\n${USAGE}` }
    }
    return { kind: 'install-hint', json, ...(os ? { os } : {}) }
  }
  if (verb === 'status') {
    let json = false
    const query: { session?: string; project?: string; needs?: string[]; image?: string } = {}
    const session = env.AGENTOP_MANAGED_ID
    if (session) query.session = session
    if (cwdProject) query.project = cwdProject
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--json') json = true
      else if (a === '--session') { const o = optionalValue(rest, i); i += o.skip; if (o.value) query.session = o.value }
      else if (a === '--project') { const o = optionalValue(rest, i); i += o.skip; if (o.value) query.project = o.value }
      else if (a === '--needs' && rest[i + 1]) query.needs = rest[++i]!.split(',').map(s => s.trim()).filter(Boolean)
      else if (a === '--image' && rest[i + 1]) query.image = rest[++i]
      else return { kind: 'error', message: `unknown argument ${a}\n${USAGE}` }
    }
    return { kind: 'status', json, query }
  }
  if (verb === 'use') {
    const backend = rest[0]
    if (backend !== 'docker' && backend !== 'namespace') return { kind: 'error', message: `use needs docker or namespace\n${USAGE}` }
    let scope: 'session' | 'project' | 'all' = 'all'
    let target: string | undefined
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--all') { scope = 'all'; target = undefined }
      else if (a === '--session') { const o = optionalValue(rest, i); i += o.skip; scope = 'session'; target = o.value ?? env.AGENTOP_MANAGED_ID }
      else if (a === '--project') { const o = optionalValue(rest, i); i += o.skip; scope = 'project'; target = o.value ?? cwdProject }
      else return { kind: 'error', message: `unknown argument ${a}\n${USAGE}` }
    }
    if (scope !== 'all' && !target) return { kind: 'error', message: `--${scope} needs a ${scope === 'session' ? 'session id (or run this inside a session)' : 'project key (or run this inside a repository)'}` }
    return { kind: 'use', body: { backend, scope, ...(target ? { target } : {}) } }
  }
  return { kind: 'error', message: `unknown verb "${verb}"\n${USAGE}` }
}

export function describeStatus(s: EnvStatus): string[] {
  const l: string[] = []
  l.push(`docker-env flag: ${s.flag ? 'ON' : 'off (nothing below is offered; enable with `agentop experimental enable` or AGENTISTICS_DOCKER_ENV=1)'}`)
  const d = s.docker
  l.push(`docker: ${!d.present ? 'not installed' : d.running ? `running (engine ${d.version ?? '?'}, API ${d.apiVersion ?? '?'}, ${d.kind})` : `installed, not running (${d.kind})`}`)
  l.push(`system: ${s.platform.os} — Docker here is ${s.platform.docker === 'available' ? 'validated' : 'not validated yet'}`)
  l.push(`backend: ${s.decision.backend} (${s.decision.reason})${s.decision.line ? ` — ${s.decision.line}` : ''}`)
  l.push(`choice: ${s.choice.backend ?? 'none'} (scope: ${s.choice.source})${s.refusalStale ? ' — an earlier refusal lapsed because Docker changed' : ''}`)
  l.push(`image: ${s.image.ok ? `${s.image.key}` : `none for this project (${s.image.missing.join(', ')})`}; catalogue: ${s.catalogue.join(', ')}`)
  if (s.decision.suggest === 'install-docker') l.push('suggestion: run `agentop env install-hint` to see how to install Docker on this system')
  if (s.decision.suggest === 'use-docker') l.push('suggestion: `agentop env use docker [--session|--project|--all]`, or `agentop env use namespace` to decline')
  return l
}

export function describeInstall(h: EnvInstallHint, detectedOs: string): string[] {
  const l = [
    `${h.what}${h.os === detectedOs ? '' : `  (for ${h.os}; this machine is ${detectedOs})`}`,
    `cost: ${h.cost}`,
    ...h.steps.map((s, i) => `  ${i + 1}. ${s}`),
    `official page: ${h.officialUrl}`,
  ]
  if (h.note) l.push(h.note)
  l.push('agentop installs nothing and runs no sudo; these are steps for you to follow.')
  return l
}

export interface EnvCliDeps {
  /** One door to `/api/env/*`; default: the running server on `port`, else `local` (the same handler in-process). */
  call?: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: any; viaServer: boolean }>
  env?: Record<string, string | undefined>
  /** The machine-facing parts, injected by `bin/cli.ts` from `flows/host-ops.ts` (this module stays free of file/process access). */
  io?: {
    port: number
    cwdProject: () => Promise<string | undefined>
    proof: (env: Record<string, string | undefined>) => Promise<{ id: string; token: string } | undefined>
    local: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
  }
  cwdProject?: () => Promise<string | undefined>
  log?: (l: string) => void
  error?: (l: string) => void
}

async function serverOrLocal(io: NonNullable<EnvCliDeps['io']>, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any; viaServer: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${io.port}${path}`, {
      method, signal: AbortSignal.timeout(10_000),
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    })
    // A server that does not know the route answers its SPA/404: only a JSON answer counts as the server's.
    if ((res.headers.get('content-type') ?? '').includes('json')) return { status: res.status, body: await res.json(), viaServer: true }
  } catch { /* no server — in-process below */ }
  return { ...(await io.local(method, path, body)), viaServer: false } as { status: number; body: any; viaServer: boolean }
}

export async function runEnv(args: readonly string[], deps: EnvCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l))
  const error = deps.error ?? ((l: string) => console.error(l))
  const env = deps.env ?? process.env
  const cwdProject = await (deps.cwdProject ?? deps.io?.cwdProject ?? (async () => undefined))()
  const cmd = parseEnvArgs(args, env, cwdProject)
  if (cmd.kind === 'error') { (cmd.message === USAGE ? log : error)(cmd.message); return cmd.message === USAGE ? 0 : 2 }
  const call = deps.call ?? (deps.io ? (m: 'GET' | 'POST', p: string, b?: unknown) => serverOrLocal(deps.io!, m, p, b) : async () => ({ status: 500, body: { error: 'no_io' }, viaServer: false }))
  const note = (viaServer: boolean) => viaServer ? undefined : '(agentistics server not reachable: answered locally)'
  if (cmd.kind === 'status') {
    const q = new URLSearchParams()
    if (cmd.query.session) q.set('session', cmd.query.session)
    if (cmd.query.project) q.set('project', cmd.query.project)
    if (cmd.query.needs?.length) q.set('needs', cmd.query.needs.join(','))
    if (cmd.query.image) q.set('image', cmd.query.image)
    const r = await call('GET', `/api/env/status?${q}`)
    if (r.body?.error === 'flag_off') { log('docker-env flag: off (agentop experimental enable, or AGENTISTICS_DOCKER_ENV=1)'); return 0 }
    if (r.status !== 200) { error(`refused: ${r.body?.error ?? r.status}`); return 1 }
    if (cmd.json) { log(JSON.stringify(r.body, null, 2)); return 0 }
    for (const line of describeStatus(r.body as EnvStatus)) log(line)
    const n = note(r.viaServer); if (n) log(n)
    return 0
  }
  if (cmd.kind === 'install-hint') {
    const r = await call('GET', `/api/env/install-hint${cmd.os ? `?os=${encodeURIComponent(cmd.os)}` : ''}`)
    if (r.body?.error === 'flag_off') { log('docker-env flag: off (agentop experimental enable, or AGENTISTICS_DOCKER_ENV=1)'); return 0 }
    if (r.status !== 200) { error(`refused: ${r.body?.error ?? r.status} (use linux, wsl2, macos or windows)`); return 1 }
    if (cmd.json) { log(JSON.stringify(r.body, null, 2)); return 0 }
    for (const line of describeInstall(r.body.hint, r.body.detectedOs)) log(line)
    return 0
  }
  const session = await deps.io?.proof(env)
  const body = cmd.kind === 'use' ? { ...cmd.body, ...(session ? { session } : {}) } : { ...cmd.body, ...(session ? { session } : {}) }
  const r = await call('POST', cmd.kind === 'use' ? '/api/env/use' : '/api/env/grant', body)
  if (r.status !== 200) {
    const why: Record<string, string> = {
      flag_off: 'the docker-env feature is off (agentop experimental enable, or AGENTISTICS_DOCKER_ENV=1)',
      leader_only: 'only the person or a leader session may do this — a worker may not',
      unverified_sender: 'this session could not prove who it is',
      grant_not_available: 'grants arrive with a later slice',
    }
    error(`refused: ${r.body?.error ?? r.status}${why[r.body?.error] ? ` — ${why[r.body.error]}` : ''}`)
    return 1
  }
  log(`environment backend: ${r.body.backend} for ${r.body.scope}${r.body.target ? ` ${r.body.target}` : ''}`)
  const n = note(r.viaServer); if (n) log(n)
  return 0
}
