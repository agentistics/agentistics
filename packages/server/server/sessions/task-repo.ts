/**
 * task-repo.ts — PURE. What a person types as a task's repository -> the value `Task.repo` stores.
 *
 * `Task.repo` is inherited ONCE from the first session filed (`attachSession`) and was never editable
 * afterwards, so a repository that moved (blpsoares/agentistics -> agentistics/agentistics) left every
 * check that compares against it holding a stale name. This is the one function the edit surfaces
 * (REST, MCP, CLI) share, kept small on purpose so a later shared normalizer can replace it.
 *
 * The stored format is the one inheritance already writes: `repoShortName(normalizeGitRemote(url))`,
 * i.e. `owner/name` (host dropped, no `.git`, no trailing slash). Accepted: `owner/name`,
 * `host/owner/name`, https/ssh/scp git URLs. Refused with a SENTENCE: garbage, local paths, spaces.
 * An empty string is the deliberate clearing.
 */
import { normalizeGitRemote, repoShortName } from '@agentistics/core'

export type TaskRepoResult = { ok: true; repo: string } | { ok: false; reason: string }

const SEGMENT = /^[A-Za-z0-9_.-]+$/
const SCP = /^[^/@\s]+@[^/:\s]+:.+$/
/** A host segment: at least one dot between labels (github.com, git.example.org). */
const HOST = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

export function normalizeTaskRepo(input: string): TaskRepoResult {
  const raw = input.trim()
  if (!raw) return { ok: true, repo: '' }
  if (raw.length > 300) return { ok: false, reason: `That repository is ${raw.length} characters long — give owner/name or a git URL.` }
  if (/\s/.test(raw)) return { ok: false, reason: `"${raw}" has spaces — a repository is written owner/name or as a git URL.` }
  if (/^(file:|\/|\.|~|[A-Za-z]:[\\/])/.test(raw) || raw.includes('\\')) {
    return { ok: false, reason: `"${raw}" looks like a local path — give the repository as owner/name or a git URL.` }
  }

  const isUrl = raw.includes('://') || SCP.test(raw)
  const remote = isUrl ? normalizeGitRemote(raw) : raw.replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = remote.split('/')
  const bad = { ok: false, reason: `"${raw}" is not a repository — use owner/name, host/owner/name or a git URL.` } as const
  if (parts.length < 2 || parts.some(p => !SEGMENT.test(p) || p === '.' || p === '..')) return bad

  if (isUrl) {
    // normalizeGitRemote always leads with the host: exactly host/owner/name. Anything after the name
    // (`/tree/main/x`, a nested group) is not something we can store without guessing — refuse it.
    if (parts.length !== 3) return bad
    const repo = repoShortName(remote)
    return repo.includes('/') ? { ok: true, repo } : bad
  }
  // owner/name stays as typed; host/owner/name drops the host, as inheritance does — but only when the
  // first segment IS a host (it has a dot: github.com, gitlab.example.org). `O/R/extra` is refused, never
  // silently read as host O.
  // `github.com/o` is a host with an owner and no name — never an owner/name pair (owners carry no dots).
  if (parts.length === 2) return HOST.test(parts[0]!) ? bad : { ok: true, repo: remote }
  if (parts.length === 3 && HOST.test(parts[0]!)) return { ok: true, repo: parts.slice(1).join('/') }
  return bad
}
