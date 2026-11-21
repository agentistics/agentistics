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

export function normalizeTaskRepo(input: string): TaskRepoResult {
  const raw = input.trim()
  if (!raw) return { ok: true, repo: '' }
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
    // normalizeGitRemote always leads with the host; a URL with no owner/name after it is not a repo.
    const repo = repoShortName(remote)
    return repo.includes('/') ? { ok: true, repo } : bad
  }
  // owner/name stays as typed; host/owner/name (3+ segments) drops the host, as inheritance does.
  return { ok: true, repo: parts.length === 2 ? remote : parts.slice(1).join('/') }
}
