/**
 * login-env.ts — the environment a session should START in, resolved by the service itself.
 *
 * A background service carries a PATH SNAPSHOT copied from the shell that installed it
 * (`service-path.ts`). A tool installed afterwards in a new directory, or a variable exported only
 * in `~/.bashrc` (nvm, volta, bun), never reached a session until somebody ran `agentop restart`
 * from a terminal — and the people this product is for never open one after installing.
 *
 * So the service asks the one thing that always knows: the user's LOGIN SHELL. `$SHELL -lic 'env
 * -0'` prints what a fresh terminal would have, and this module keeps PATH plus an ALLOWLIST of
 * variables sessions need.
 *
 * Rules:
 * - NEVER FAILS LOUD. Timeout, garbage, a missing shell: the last good answer (kept on disk), then
 *   the process's own PATH. The caller always gets an environment.
 * - SECRETS ARE NOT COPIED. Credentials (API keys, tokens) are not in the allowlist: they would
 *   travel in the argv of `tmux new-session -e K=V`, which any local user can read from `ps`, and
 *   they would be written into the cache file. A harness reads its own credentials from its own
 *   config files; what this module carries is only where tools LIVE.
 * - THE UNIT'S PATH STAYS AS THE FLOOR: the login PATH goes first, the process's own PATH is
 *   appended, so a shell that exports a broken PATH cannot take `sh`/`git` away.
 */
import { join } from 'node:path'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { AGENTISTICS_DATA_DIR } from '../config'

/** Variables copied beside PATH. Locations of toolchains — never credentials. */
export const LOGIN_ENV_ALLOWLIST = [
  'NVM_DIR', 'VOLTA_HOME', 'BUN_INSTALL', 'PNPM_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME',
  'RUSTUP_HOME', 'FNM_DIR', 'ASDF_DIR', 'ASDF_DATA_DIR', 'PYENV_ROOT', 'SDKMAN_DIR',
  'DENO_INSTALL', 'NPM_CONFIG_PREFIX', 'JAVA_HOME',
] as const

export const LOGIN_ENV_TIMEOUT_MS = 4000
export const LOGIN_ENV_MAX_BYTES = 256 * 1024
export const LOGIN_ENV_TTL_MS = 60_000
const BEGIN = '__AGENTISTICS_ENV_BEGIN__'

export type LoginEnv = Record<string, string>

/**
 * PURE. `env -0` output (NUL-separated `K=V`) -> the kept variables. Anything before the BEGIN
 * marker is whatever the rc files printed and is ignored. Returns `null` when there is no usable
 * PATH — garbage must not displace a good answer.
 */
export function parseLoginEnv(raw: string): LoginEnv | null {
  const at = raw.indexOf(`${BEGIN}\0`)
  const body = at >= 0 ? raw.slice(at + BEGIN.length + 1) : raw
  const keep = new Set<string>(['PATH', ...LOGIN_ENV_ALLOWLIST])
  const out: LoginEnv = {}
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq)
    if (!keep.has(key)) continue
    const value = entry.slice(eq + 1)
    if (value === '' || value.includes('\n')) continue
    out[key] = value
  }
  return cleanPath(out.PATH) ? out : null
}

/** Absolute, non-empty, de-duplicated entries only (a service has no meaningful cwd). */
function cleanPath(p: string | undefined): string {
  const seen = new Set<string>()
  for (const d of (p ?? '').split(':')) {
    if (!d.startsWith('/')) continue
    seen.add(d.length > 1 && d.endsWith('/') ? d.slice(0, -1) : d)
  }
  return [...seen].join(':')
}

/** PURE. The login env over the process's own: login PATH first, own PATH appended. */
export function mergeLoginEnv(login: LoginEnv | null, ownPath: string | undefined): LoginEnv {
  const path = cleanPath(`${login?.PATH ?? ''}:${ownPath ?? ''}`)
  const out: LoginEnv = { ...(login ?? {}) }
  if (path) out.PATH = path
  else delete out.PATH
  return out
}

/** Runs the login shell; resolves to raw stdout or null on timeout/failure. Injectable for tests. */
export type ShellRunner = (shell: string) => Promise<string | null>

export const runLoginShell: ShellRunner = async shell => {
  try {
    const proc = Bun.spawn(
      [shell, '-lic', `printf '%s\\0' ${BEGIN}; env -0`],
      {
        stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
        env: { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', TERM: 'dumb', PATH: process.env.PATH ?? '' },
      },
    )
    const timer = setTimeout(() => proc.kill('SIGKILL'), LOGIN_ENV_TIMEOUT_MS)
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const c of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        size += c.length
        if (size > LOGIN_ENV_MAX_BYTES) { proc.kill('SIGKILL'); return null }
        chunks.push(c)
      }
      await proc.exited
      if (proc.signalCode) return null
      return Buffer.concat(chunks).toString('utf8')
    } finally { clearTimeout(timer) }
  } catch { return null }
}

export const loginEnvCacheFile = () => join(AGENTISTICS_DATA_DIR, 'login-env.json')

async function readDisk(file: string): Promise<LoginEnv | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parseLoginEnv(Object.entries(parsed).map(([k, v]) => `${k}=${String(v)}`).join('\0'))
  } catch { return null }
}

async function writeDisk(file: string, env: LoginEnv): Promise<void> {
  try {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(env), { mode: 0o600 })
    await chmod(file, 0o600)
  } catch (e) { console.error('[login-env] cache not written:', (e as Error).message) }
}

export interface ResolveOptions {
  run?: ShellRunner
  file?: string
  ownPath?: string
  shell?: string
}

/** One resolution, no memo. Falls back to the disk cache, then to nothing (caller merges own PATH). */
export async function resolveLoginEnv(o: ResolveOptions = {}): Promise<{ env: LoginEnv | null; source: 'login' | 'cache' | 'none' }> {
  const run = o.run ?? runLoginShell
  const file = o.file ?? loginEnvCacheFile()
  const shell = o.shell ?? process.env.SHELL ?? '/bin/bash'
  let raw = await run(shell)
  if (raw === null && shell !== '/bin/bash') raw = await run('/bin/bash')
  const fresh = raw === null ? null : parseLoginEnv(raw)
  if (fresh) { await writeDisk(file, fresh); return { env: fresh, source: 'login' } }
  const cached = await readDisk(file)
  if (cached) return { env: cached, source: 'cache' }
  return { env: null, source: 'none' }
}

let memo: { at: number; env: LoginEnv; source: string } | null = null
let inflight: Promise<LoginEnv> | null = null

/** The env to spawn a session with: re-resolved at most once per TTL, shared while in flight. */
export async function sessionEnv(
  o: ResolveOptions & { now?: () => number; ttlMs?: number } = {},
): Promise<LoginEnv> {
  const now = (o.now ?? Date.now)()
  const ttl = o.ttlMs ?? LOGIN_ENV_TTL_MS
  if (memo && now - memo.at < ttl) return memo.env
  if (inflight) return inflight
  inflight = (async () => {
    const r = await resolveLoginEnv(o)
    if (r.source !== 'login') console.error(`[login-env] login shell not usable, using ${r.source === 'cache' ? 'cached env' : "the service's own PATH"}`)
    const env = mergeLoginEnv(r.env, o.ownPath ?? process.env.PATH)
    memo = { at: now, env, source: r.source }
    return env
  })().finally(() => { inflight = null })
  return inflight
}

/** For `agentop doctor`: how the last resolution went, without values. */
export function loginEnvStatus(): { source: string; pathSegments: number; vars: string[]; ageMs: number } | null {
  if (!memo) return null
  return {
    source: memo.source, pathSegments: (memo.env.PATH ?? '').split(':').filter(Boolean).length,
    vars: Object.keys(memo.env).filter(k => k !== 'PATH'), ageMs: Date.now() - memo.at,
  }
}

export function resetLoginEnvMemo(): void { memo = null; inflight = null }
