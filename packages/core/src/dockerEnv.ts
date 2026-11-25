/**
 * DOCKER.AMBIENTES S1 — which backend runs a worker's environment, and why. PURE: no IO, no clock.
 *
 * Spec: leader/docker/SPEC-r3.md §2 (decision, scope, install text) and §3.4 (the catalogue). Everything here is
 * behind the `docker-env` experimental flag; with the flag off `decideEnvBackend` answers `namespace` and says
 * nothing (today's behaviour). S1 only DECIDES and SUGGESTS — no container, volume or image is created anywhere.
 *
 * Rules that must hold:
 *  - never `docker` without isolation in silence: every row that cannot honour a `docker` choice falls back to
 *    `namespace` and carries a reason a person can read;
 *  - a suggestion never blocks, and a refusal stays refused until the state it was made against changes
 *    (`envOfferKey`);
 *  - a catalogue entry without `source` and `verifiedAt` does not exist (`catalogProblems`, linted).
 */

export type EnvBackend = 'docker' | 'namespace'

/** What `docker-detectar` reports, plus the Engine API version S1 adds. */
export interface DockerFacts {
  present: boolean
  running: boolean
  version: string | null
  kind: 'wsl2-desktop' | 'desktop' | 'native' | 'none'
  /** `docker version --format '{{.Server.APIVersion}}'`; `null` when the daemon did not answer. */
  apiVersion: string | null
}

/** Engine 26 — the first with `volume-subpath`, which the per-command container relies on (§2.1, §3.3). */
export const ENV_MIN_API_VERSION = '1.45'

/** Whether the platform's Docker is one the project has measured (§8.1). Desktop is NOT, until P8. */
export type EnvPlatformState = 'available' | 'unavailable'

export const ENV_REASONS = [
  'flag-off',
  'suggest-docker',
  'chosen-docker',
  'chosen-namespace',
  'no-image',
  'platform-unavailable',
  'docker-stopped-offered',
  'docker-stopped-chosen',
  'docker-missing-suggest-install',
  'docker-gone',
  'api-too-old',
] as const
export type EnvReason = (typeof ENV_REASONS)[number]

export interface EnvDecisionInput {
  /** The `docker-env` experimental flag. */
  flag: boolean
  docker: DockerFacts
  platform: EnvPlatformState
  /** The preference that applies to the asking session (see `resolveEnvChoice`); absent = nobody chose. */
  choice: EnvBackend | undefined
  /** Does the repo's profile resolve to a catalogue image that carries the tools it needs? */
  image: { ok: true } | { ok: false; missing: string[] }
}

export interface EnvDecision {
  backend: EnvBackend
  reason: EnvReason
  /** A plain-language line for the person (status line / chip). Empty when nothing should be said. */
  line: string
  /** The suggestion to put in front of the person, if any (install, or switch to Docker). Never blocks. */
  suggest: 'use-docker' | 'install-docker' | null
  /** True for the `docker` rows only: the run is allowed to use Docker. */
  docker: boolean
}

const out = (backend: EnvBackend, reason: EnvReason, line: string, suggest: EnvDecision['suggest'] = null): EnvDecision =>
  ({ backend, reason, line, suggest, docker: backend === 'docker' })

/** `1.54` vs `1.45`: numeric, component by component. Unparseable reads as OLD (never promote on a guess). */
export function apiAtLeast(have: string | null, min: string = ENV_MIN_API_VERSION): boolean {
  const parse = (v: string) => v.split('.').map(n => Number(n))
  if (!have || !/^\d+(\.\d+)*$/.test(have.trim())) return false
  const a = parse(have.trim())
  const b = parse(min)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** The decision table of SPEC §2.1, one branch per row. */
export function decideEnvBackend(i: EnvDecisionInput): EnvDecision {
  if (!i.flag) return out('namespace', 'flag-off', '')
  const d = i.docker
  if (!d.present) {
    return i.choice === 'docker'
      ? out('namespace', 'docker-gone', 'Docker is no longer installed; this run uses the isolated namespace instead.')
      : i.choice === 'namespace'
        ? out('namespace', 'chosen-namespace', '')
        : out('namespace', 'docker-missing-suggest-install', 'Docker is not installed. Install it to give each worker a disposable environment, or keep the isolated namespace.', 'install-docker')
  }
  if (!d.running) {
    return i.choice === 'docker'
      ? out('namespace', 'docker-stopped-chosen', 'Docker is installed but not running, so this run uses the isolated namespace. Start Docker and it will be used next time.')
      : i.choice === 'namespace'
        ? out('namespace', 'chosen-namespace', '')
        : out('namespace', 'docker-stopped-offered', 'Docker is installed but not running. Start it to be offered a disposable environment per worker.')
  }
  // Running from here on.
  if (i.platform === 'unavailable') {
    return out('namespace', 'platform-unavailable', 'Docker is not validated on this system yet, so the isolated namespace is used.')
  }
  if (i.choice === 'namespace') return out('namespace', 'chosen-namespace', '')
  if (i.choice === 'docker') {
    if (!apiAtLeast(d.apiVersion)) {
      return out('namespace', 'api-too-old', `Docker's API ${d.apiVersion ?? '(unknown)'} is older than ${ENV_MIN_API_VERSION}; update Docker. This run uses the isolated namespace.`)
    }
    if (!i.image.ok) {
      return out('namespace', 'no-image', `No known image for this project (missing: ${i.image.missing.join(', ')}). This run uses the isolated namespace.`)
    }
    return out('docker', 'chosen-docker', 'Docker environment')
  }
  return out('namespace', 'suggest-docker', 'Docker is running: each worker can get a disposable environment. Choose it with `agentop env use docker`.', 'use-docker')
}

/** A refusal is made against a STATE; it stays until the state changes (SPEC §2.1: `envBackendOfferedFor`). */
export function envOfferKey(d: DockerFacts, platform: EnvPlatformState): string {
  return [d.present ? 'present' : 'none', d.running ? 'running' : 'stopped', d.kind, d.apiVersion ?? '-', platform].join('|')
}

// ── scope: only this session / this project / all sessions ─────────────────────────────────────────────────────

export type EnvScope = 'session' | 'project' | 'all'

/** Stored under `preferences.envBackend`. Each map holds only what a person or leader chose; absent = no opinion. */
export interface EnvBackendPrefs {
  all?: EnvBackend
  /** project key (the main checkout's path or the normalized git remote) -> choice */
  projects?: Record<string, EnvBackend>
  /** managed session id -> choice */
  sessions?: Record<string, EnvBackend>
}

export type EnvChoiceSource = EnvScope | 'none'

/** The MOST SPECIFIC scope wins: session, then project, then all. */
export function resolveEnvChoice(
  prefs: EnvBackendPrefs | undefined,
  who: { sessionId?: string; projectKey?: string },
): { choice: EnvBackend | undefined; source: EnvChoiceSource } {
  const s = who.sessionId ? prefs?.sessions?.[who.sessionId] : undefined
  if (s) return { choice: s, source: 'session' }
  const p = who.projectKey ? prefs?.projects?.[who.projectKey] : undefined
  if (p) return { choice: p, source: 'project' }
  if (prefs?.all) return { choice: prefs.all, source: 'all' }
  return { choice: undefined, source: 'none' }
}

export type EnvUseError = 'bad_backend' | 'bad_scope' | 'target_required'

/** The pure write: returns the next prefs (never mutates), or the reason it refused. */
export function applyEnvChoice(
  prefs: EnvBackendPrefs | undefined,
  req: { scope?: unknown; backend: unknown; target?: unknown },
): { ok: true; prefs: EnvBackendPrefs } | { ok: false; error: EnvUseError } {
  const backend = req.backend
  if (backend !== 'docker' && backend !== 'namespace') return { ok: false, error: 'bad_backend' }
  const scope = req.scope ?? 'all'
  if (scope !== 'session' && scope !== 'project' && scope !== 'all') return { ok: false, error: 'bad_scope' }
  const next: EnvBackendPrefs = { ...(prefs?.all ? { all: prefs.all } : {}), ...(prefs?.projects ? { projects: { ...prefs.projects } } : {}), ...(prefs?.sessions ? { sessions: { ...prefs.sessions } } : {}) }
  if (scope === 'all') { next.all = backend; return { ok: true, prefs: next } }
  const target = typeof req.target === 'string' ? req.target.trim() : ''
  if (!target) return { ok: false, error: 'target_required' }
  const key = scope === 'session' ? 'sessions' : 'projects'
  next[key] = { ...(next[key] ?? {}), [target]: backend }
  return { ok: true, prefs: next }
}

// ── install hint per operating system (SPEC §2.4) ──────────────────────────────────────────────────────────────

export type EnvOs = 'linux' | 'wsl2' | 'macos' | 'windows'

export interface EnvInstallHint {
  os: EnvOs
  /** What to install, in words. */
  what: string
  /** Cost, said honestly (estimate marked as such). */
  cost: string
  /** Numbered steps a person can follow; NEVER executed by agentop (no auto-install, no silent sudo). */
  steps: string[]
  /** The official page to open; the later UI button just opens it. */
  officialUrl: string
  /** Docker is not validated on this system yet: the backend stays off until it is (§8.1). */
  validated: boolean
  note?: string
}

export function envOsOf(platform: string, isWsl: boolean): EnvOs {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return isWsl ? 'wsl2' : 'linux'
}

export function installHint(os: EnvOs): EnvInstallHint {
  switch (os) {
    case 'linux':
      return {
        os, what: "Docker Engine from your distribution (no virtual machine)",
        cost: 'About 0.5 GB of disk; needs an administrator to install. Membership of the `docker` group is equivalent to administrator rights on this machine.',
        steps: [
          'Open the official instructions for your distribution and follow them (the page lists apt, dnf and others).',
          'Start the service and check it with `docker version`.',
          'Add yourself to the `docker` group only if you accept that it is administrator-equivalent, then log in again.',
          'Run `agentop env status` — Docker will show as running.',
        ],
        officialUrl: 'https://docs.docker.com/engine/install/', validated: true,
      }
    case 'wsl2':
      return {
        os, what: 'Docker Engine inside WSL (measured here), not Docker Desktop',
        cost: 'Like Linux: about 0.5 GB, no virtual machine of its own. Keep the repository inside the WSL file system — under /mnt/c it is slow.',
        steps: [
          'Open a WSL terminal (not PowerShell).',
          'Follow the Linux instructions for your WSL distribution on the official page.',
          'Enable systemd in WSL if the service does not start (`/etc/wsl.conf`), then restart WSL.',
          'Run `agentop env status` — Docker will show as running.',
        ],
        officialUrl: 'https://docs.docker.com/engine/install/', validated: true,
      }
    case 'macos':
      return {
        os, what: 'Docker Desktop for Mac',
        cost: 'Estimate: 2–4 GB of disk plus a virtual machine that reserves memory; a paid licence applies to larger companies.',
        steps: [
          'Download Docker Desktop from the official page and open the installer.',
          'Start Docker Desktop and wait until it says it is running.',
          'Run `agentop env status`.',
        ],
        officialUrl: 'https://docs.docker.com/desktop/setup/install/mac-install/', validated: false,
        note: 'Still in testing on your system: the Docker option stays off until it is validated.',
      }
    case 'windows':
      return {
        os, what: 'Docker Desktop for Windows (sessions here run inside WSL)',
        cost: 'Estimate: 2–4 GB of disk plus a virtual machine that reserves memory; a paid licence applies to larger companies.',
        steps: [
          'Download Docker Desktop from the official page and open the installer.',
          'Choose the WSL 2 backend and enable integration with your WSL distribution.',
          'Start Docker Desktop, then run `agentop env status` from WSL.',
        ],
        officialUrl: 'https://docs.docker.com/desktop/setup/install/windows-install/', validated: false,
        note: 'Still in testing on your system: the Docker option stays off until it is validated.',
      }
  }
}

// ── the image catalogue (SPEC §3.4) ────────────────────────────────────────────────────────────────────────────

export type EnvTool = 'sh' | 'timeout' | 'bun' | 'node' | 'git' | 'browser'

export interface EnvImage {
  /** The key `.agentistics/env.yml` may choose. */
  key: string
  /** `repo@sha256:…` — pulled ONLY by digest. */
  ref: string
  /** Date the digest was read from the registry (yyyy-mm-dd). Required. */
  verifiedAt: string
  /** Where the digest/tag came from: an official page or the agentistics CI workflow. Required. */
  source: string
  tools: readonly EnvTool[]
  managers: readonly string[]
}

/**
 * The fixed catalogue. No build ever happens on a user's machine. Digests read from the registries' manifest
 * endpoints on 2026-11-23 (Docker-Content-Digest of the tag). A `git` image and `playwright` join with S1b / P9.
 */
export const ENV_IMAGES: readonly EnvImage[] = [
  {
    key: 'bun-1.3',
    ref: 'oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4',
    verifiedAt: '2026-11-23',
    source: 'https://hub.docker.com/r/oven/bun (tag 1.3.14; measured: no git, no socat; own ENTRYPOINT, OnBuild null)',
    tools: ['sh', 'timeout', 'bun'],
    managers: ['bun'],
  },
  {
    key: 'node-22-slim',
    ref: 'node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee',
    verifiedAt: '2026-11-23',
    source: 'https://hub.docker.com/_/node (tag 22-slim)',
    tools: ['sh', 'timeout', 'node'],
    managers: ['npm', 'pnpm', 'yarn'],
  },
]

/** The lint of the catalogue: an entry with no source or no date, or a ref that is not a digest, is a problem. */
export function catalogProblems(images: readonly EnvImage[] = ENV_IMAGES): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const e of images) {
    if (!e.key || !/^[a-z0-9][a-z0-9.-]*$/.test(e.key)) problems.push(`key "${e.key}" is not a plain lowercase key`)
    if (seen.has(e.key)) problems.push(`${e.key}: duplicate key`)
    seen.add(e.key)
    if (!/@sha256:[0-9a-f]{64}$/.test(e.ref)) problems.push(`${e.key}: ref must end in @sha256:<64 hex> (pull by digest only)`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.verifiedAt ?? '')) problems.push(`${e.key}: verifiedAt must be yyyy-mm-dd`)
    if (!e.source || e.source.trim().length < 8) problems.push(`${e.key}: source is required`)
    if (!e.tools.includes('sh') || !e.tools.includes('timeout')) problems.push(`${e.key}: exec-wrap needs sh and timeout`)
  }
  return problems
}

/**
 * Which catalogue image serves a profile? `choose` is the key the repo's `env.yml` names (or undefined to let the
 * manager decide), `needs` the tools it requires. A key outside the catalogue — or a digest/FROM where a key
 * belongs — is refused, never adopted.
 */
export function resolveEnvImage(
  profile: { choose?: string; manager?: string; needs?: readonly string[] },
  images: readonly EnvImage[] = ENV_IMAGES,
): { ok: true; image: EnvImage } | { ok: false; missing: string[] } {
  const needs = profile.needs ?? []
  if (profile.choose !== undefined) {
    const hit = images.find(i => i.key === profile.choose)
    if (!hit) return { ok: false, missing: [`image "${profile.choose}" is not in the catalogue`] }
    const missing = needs.filter(n => !(hit.tools as readonly string[]).includes(n))
    return missing.length ? { ok: false, missing } : { ok: true, image: hit }
  }
  const candidates = images.filter(i => !profile.manager || i.managers.includes(profile.manager))
  if (!candidates.length) return { ok: false, missing: [`no image for the "${profile.manager}" manager`] }
  const fit = candidates.find(i => needs.every(n => (i.tools as readonly string[]).includes(n)))
  if (fit) return { ok: true, image: fit }
  const best = candidates[0]!
  return { ok: false, missing: needs.filter(n => !(best.tools as readonly string[]).includes(n)) }
}
