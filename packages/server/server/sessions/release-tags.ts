/**
 * release-tags.ts — IO. Which commits a PUBLISHED release tag contains, for the Live's legacy review cards.
 *
 * A piece that predates the delivery flow has no delivery record, so nothing says it was published; the one
 * fact that can is "the commit it delivered is inside a `v<version>` tag". This answers that without ever
 * making a request wait for git:
 *  - `publishedAmong(shas)` returns what is KNOWN now and starts resolving the rest in the background, so the
 *    first reply after a restart may call such a card "review" and the next one (the reply is rebuilt every
 *    few seconds) calls it Publicado;
 *  - a positive answer is kept for the life of the process (a commit does not leave a tag), a negative one
 *    expires (the tag may simply not exist yet), and an unanswerable one (no git, no repository, unknown
 *    commit) counts as negative — never as published;
 *  - at most one `git` runs at a time and the work per refill is bounded.
 */

import { execFile } from 'node:child_process'

const NEGATIVE_TTL_MS = 10 * 60_000
const MAX_PER_REFILL = 40
const GIT_TIMEOUT_MS = 4_000

const positive = new Set<string>()
const negative = new Map<string, number>()
let running: Promise<void> | null = null

/** The repository whose tags are asked: the checkout this server runs from (a binary outside one simply gets "no" from git). */
const repoDir = (): string => process.cwd()

/** Does a version tag contain this commit? Any failure is "no". */
export function tagContains(sha: string, cwd = repoDir()): Promise<boolean> {
  return new Promise(resolve => {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) { resolve(false); return }
    execFile('git', ['-C', cwd, 'tag', '--contains', sha, '--list', 'v[0-9]*'], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, out) => {
      resolve(!err && String(out).trim().length > 0)
    })
  })
}

async function refill(todo: string[], ask: (sha: string) => Promise<boolean>, nowMs: number): Promise<void> {
  for (const sha of todo.slice(0, MAX_PER_REFILL)) {
    if (await ask(sha)) { positive.add(sha); negative.delete(sha) } else negative.set(sha, nowMs)
  }
}

/** The subset of `shas` a published tag is known to contain; unknown ones are resolved in the background. */
export function publishedAmong(shas: readonly string[], nowMs = Date.now(), ask: (sha: string) => Promise<boolean> = tagContains): ReadonlySet<string> {
  const out = new Set<string>()
  const todo: string[] = []
  for (const sha of shas) {
    if (positive.has(sha)) { out.add(sha); continue }
    const at = negative.get(sha)
    if (at === undefined || nowMs - at >= NEGATIVE_TTL_MS) todo.push(sha)
  }
  if (todo.length > 0 && running === null) {
    running = refill(todo, ask, nowMs).finally(() => { running = null })
  }
  return out
}

/** Test seam: forget everything, and wait for the refill in flight. */
export async function resetReleaseTagsForTest(): Promise<void> {
  await running
  positive.clear(); negative.clear()
}
export const releaseTagsIdle = (): Promise<void> => running ?? Promise.resolve()
