/**
 * DOCKER.AMBIENTES S2 — the repo's `.agentistics/env.yml`, read as UNTRUSTED input (SPEC-r3 §3.4). PURE.
 *
 * The profile may only CHOOSE a catalogue key, name a package manager and declare what it needs. Anything that
 * would bring an image of its own — a digest, an `image:`, a `FROM`, a Dockerfile, a `build:` — is refused with a
 * sentence and the run falls back to the namespace backend. `.devcontainer` is never read in phase 1.
 *
 * The format is a deliberately tiny YAML subset (top-level `key: value`, `key: [a, b]`, and a block of `- item`
 * lines); a line the reader does not understand is a refusal, never skipped, because skipping is how a field the
 * reader does not know about slips past it.
 */
import { ENV_IMAGES, resolveEnvImage, type EnvImage } from '@agentistics/core'

/** Where a repo keeps its profile, relative to the worktree root (repo content, NOT agentop's data dir). */
export const PROFILE_REL = '.agentistics/env.yml'

export interface EnvProfile {
  image?: string
  manager?: string
  needs: string[]
  /** Literal constants for the container's environment (§5.1); filtered again by `containerEnv`. */
  env: Record<string, string>
  network: { allow: string[] }
}

export type ProfileRefusal = { ok: false; reason: string }

const KNOWN = new Set(['image', 'manager', 'needs', 'env', 'network', 'install', 'secrets', 'expose'])
/** Keys that would carry an image or a build of the repo's own. Refused by name, whatever their value. */
const FORBIDDEN = new Set(['from', 'dockerfile', 'build', 'context', 'digest', 'devcontainer', 'compose', 'entrypoint', 'privileged', 'volumes', 'ports'])

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2')

function inlineList(v: string): string[] | null {
  const m = /^\[(.*)\]$/.exec(v.trim())
  if (!m) return null
  return m[1]!.split(',').map(unquote).filter(Boolean)
}

/** Parse the profile text. `null` text = no profile (defaults). */
export function parseEnvProfile(text: string | null): { ok: true; profile: EnvProfile } | ProfileRefusal {
  const profile: EnvProfile = { needs: [], env: {}, network: { allow: [] } }
  if (text === null) return { ok: true, profile }
  let block: 'env' | 'needs' | 'network' | 'network.allow' | 'other' | null = null
  const lines = text.split(/\r?\n/)
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!.replace(/\s+#.*$/, '')
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (/^\s*FROM\s/i.test(raw)) return { ok: false, reason: `env.yml line ${n + 1}: a FROM line is not allowed; choose a catalogue key with \`image:\`` }
    const top = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(raw)
    if (top) {
      const key = top[1]!.toLowerCase()
      const value = top[2]!.trim()
      if (FORBIDDEN.has(key)) return { ok: false, reason: `env.yml: \`${top[1]}\` is not allowed — the environment only uses images from the agentistics catalogue (${ENV_IMAGES.map(i => i.key).join(', ')})` }
      if (!KNOWN.has(key)) return { ok: false, reason: `env.yml line ${n + 1}: unknown key \`${top[1]}\`` }
      block = null
      if (key === 'image') {
        const v = unquote(value)
        if (/[@:/]/.test(v) || /sha256/i.test(v)) return { ok: false, reason: `env.yml: image "${v}" is a reference, not a catalogue key; choose one of: ${ENV_IMAGES.map(i => i.key).join(', ')}` }
        profile.image = v
      } else if (key === 'manager') profile.manager = unquote(value)
      else if (key === 'needs') { const l = inlineList(value); if (l) profile.needs = l; else if (value === '') block = 'needs'; else return { ok: false, reason: 'env.yml: needs must be a list' } }
      else if (key === 'env') { if (value !== '') return { ok: false, reason: 'env.yml: env must be a block of NAME: value lines' }; block = 'env' }
      else if (key === 'network') { if (value !== '') return { ok: false, reason: 'env.yml: network must be a block' }; block = 'network' }
      else block = 'other' // install / secrets / expose: read by their own verbs (S2 install picks the manager only)
      continue
    }
    const nested = /^\s+([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(raw)
    const item = /^\s*-\s+(.*)$/.exec(raw)
    if (block === 'env' && nested) { profile.env[nested[1]!] = unquote(nested[2]!); continue }
    if (block === 'needs' && item) { profile.needs.push(unquote(item[1]!)); continue }
    if ((block === 'network' || block === 'network.allow') && nested && nested[1] === 'allow') {
      const l = inlineList(nested[2]!)
      if (l) { profile.network.allow = l; block = 'network' } else block = 'network.allow'
      continue
    }
    if (block === 'network.allow' && item) { profile.network.allow.push(unquote(item[1]!)); continue }
    if (block === 'other') continue
    return { ok: false, reason: `env.yml line ${n + 1}: not understood (\`${raw.trim().slice(0, 60)}\`)` }
  }
  return { ok: true, profile }
}

/** The repo's profile -> one catalogue image, or the refusal sentence the run prints before falling back. */
export function imageForProfile(text: string | null, images: readonly EnvImage[] = ENV_IMAGES): { ok: true; image: EnvImage; profile: EnvProfile } | ProfileRefusal {
  const parsed = parseEnvProfile(text)
  if (!parsed.ok) return parsed
  const p = parsed.profile
  const r = resolveEnvImage({ choose: p.image, manager: p.manager, needs: p.needs }, images)
  if (!r.ok) return { ok: false, reason: `no known image for this project (missing: ${r.missing.join(', ')})` }
  return { ok: true, image: r.image, profile: p }
}
