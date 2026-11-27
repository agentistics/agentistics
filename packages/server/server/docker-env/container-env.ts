/**
 * DOCKER.AMBIENTES S2 — the container's environment, built FROM NOTHING by a positive list (SPEC-r3 §5.1). PURE.
 *
 * Never `buildThrowawayEnv` (a denylist over the launcher's env) and never the launcher's env as a base: a name
 * nobody thought to deny is a name that leaks. Every value here is either fixed, or a host value that matched a
 * strict shape. It is delivered through an `--env-file` (0600, deleted after `create`), never `-e` in the argv.
 */

export interface ContainerEnvInput {
  host: Record<string, string | undefined>
  /** Throwaway/session id for `AGENTISTICS_THROWAWAY`. */
  sid: string
  /** Profile constants (`env:` in env.yml). Names that look like credentials are dropped. */
  profile?: Record<string, string>
  /** Only the network (install-download) containers get a proxy. */
  proxy?: string
  /** Extra fixed values a container kind needs (cache dirs for the install phases). Same name filter applies. */
  extra?: Record<string, string>
}

const CREDENTIAL_NAME = /TOKEN|SECRET|KEY|PASS|AUTH|CRED|COOKIE|SESSION|PRIVATE/i
const TERMS = new Set(['xterm', 'xterm-256color', 'screen', 'screen-256color', 'tmux', 'tmux-256color', 'dumb', 'vt100', 'linux'])
const SAFE_NAME = /^[A-Z_][A-Z0-9_]*$/
const OWN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function containerEnv(i: ContainerEnvInput): Record<string, string> {
  const h = i.host
  const env: Record<string, string> = {
    HOME: '/home/agent',
    TMPDIR: '/tmp',
    CI: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    AGENTISTICS_THROWAWAY: i.sid,
    AGENTISTICS_FLOWS: '0',
    AGENTISTICS_EXPERIMENTAL: '0',
    AGENTISTICS_SAIDA: '/saida',
  }
  const utf8 = /^[A-Za-z_]+\.UTF-8$/
  env.LANG = h.LANG && utf8.test(h.LANG) ? h.LANG : 'C.UTF-8'
  env.LC_ALL = h.LC_ALL && utf8.test(h.LC_ALL) ? h.LC_ALL : env.LANG
  if (h.TZ && /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/.test(h.TZ) && h.TZ.length <= 40) env.TZ = h.TZ
  if (h.TERM && TERMS.has(h.TERM)) {
    env.TERM = h.TERM
    if (h.COLUMNS && /^\d{1,4}$/.test(h.COLUMNS)) env.COLUMNS = h.COLUMNS
    if (h.LINES && /^\d{1,4}$/.test(h.LINES)) env.LINES = h.LINES
  }
  for (const k of ['NO_COLOR', 'FORCE_COLOR'] as const) if (h[k] && /^[0-3]$/.test(h[k]!)) env[k] = h[k]!
  // `profile` comes from the repo (untrusted): upper-case names only. `extra` is agentop's own fixed set (cache dirs of
  // the install phases) and may be lower-case — `npm_config_cache` was silently dropped by the upper-case rule.
  for (const [k, v, own] of [...Object.entries(i.profile ?? {}).map(([k, v]) => [k, v, false] as const), ...Object.entries(i.extra ?? {}).map(([k, v]) => [k, v, true] as const)]) {
    if (!(own ? OWN_NAME : SAFE_NAME).test(k) || CREDENTIAL_NAME.test(k) || k in env || k === 'PATH' || /^(AGENTISTICS|AGENTOP)_/.test(k)) continue
    if (/[\r\n\0]/.test(v)) continue
    env[k] = v
  }
  if (i.proxy) { env.HTTPS_PROXY = i.proxy; env.HTTP_PROXY = i.proxy; env.https_proxy = i.proxy; env.http_proxy = i.proxy }
  return env
}

/** The `--env-file` text. A value with a newline cannot be written in this format and was already dropped. */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}
