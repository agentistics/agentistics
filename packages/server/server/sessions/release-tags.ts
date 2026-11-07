/**
 * release-tags.ts — IO. Which commits a PUBLISHED release tag contains, for the Live's legacy review cards.
 *
 * A piece that predates the delivery flow has no delivery record, so nothing says it was published; the one
 * fact that can is "the commit it delivered is inside a `v<version>` tag". This answers that without ever
 * making a request wait for git:
 *  - `publishedAmong(shas)` returns what is KNOWN now and starts resolving the rest in the background, so the
 *    first reply after a restart may call such a card "review" and the next one (the reply is rebuilt every
 *    few seconds) calls it Publicado;
 *  - a positive answer is kept for the life of the process (a commit does not leave a tag; bounded), a negative
 *    one expires (the tag may simply not exist yet), and an unanswerable one (no git, no repository, unknown
 *    commit) counts as negative — never as published;
 *  - at most one refill runs at a time, the work per refill is bounded and every git call has a timeout.
 *
 * WHICH REPOSITORIES: the installed agentop does not run inside a checkout, so `process.cwd()` answers "no" for
 * everything. Each commit is asked in the clones `release-repos.ts` names for its piece (the sessions' own
 * repositories, the task's repository, every repository agentistics knows). A repository is asked once however
 * many of those directories are worktrees of it (`--git-common-dir`).
 *
 * ENGINE COMMITS: the engine repo is private and never tagged `v*` in a way the public releases carry; a public
 * release `v<version>` pins the engine in `engine.pin` (`{ ref }`). An engine commit is therefore published when
 * some public release tag pins an engine commit that DESCENDS from it (`merge-base --is-ancestor`).
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { gitEnv } from './release-repos'
import { resetReleaseSquashForTest, squashPublishedIn } from './release-squash'

const NEGATIVE_TTL_MS = 10 * 60_000
const MAX_PER_REFILL = 40
const GIT_TIMEOUT_MS = 4_000
/** Positive answers are kept for the life of the process, but not without bound. */
const MAX_POSITIVE = 5_000
const MAX_NEGATIVE = 5_000
/** How many of the newest release tags are read for their `engine.pin`. */
const MAX_PIN_TAGS = 40
const PIN_TTL_MS = 10 * 60_000

const positive = new Set<string>()
const negative = new Map<string, number>()
let running: Promise<void> | null = null

/** A bounded insert: when full, drop the oldest entry (Set/Map iterate in insertion order). */
function boundedAdd<T>(s: Set<T>, v: T, max: number): void {
  if (s.size >= max && !s.has(v)) { const first = s.values().next(); if (!first.done) s.delete(first.value) }
  s.add(v)
}

function git(dir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20, env: gitEnv() }, (err, out) => {
      resolve({ ok: !err, out: String(out ?? '').trim() })
    })
  })
}

const HEX = /^[0-9a-f]{7,40}$/

/** One repository per directory, however many worktrees: the common git dir is the identity. */
const repoKeyMemo = new Map<string, string | null>()
async function repoKey(dir: string): Promise<string | null> {
  if (repoKeyMemo.has(dir)) return repoKeyMemo.get(dir)!
  let key: string | null = null
  if (existsSync(dir)) {
    const r = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    key = r.ok && r.out ? r.out : null
  }
  if (repoKeyMemo.size >= 500) repoKeyMemo.clear()
  // a MISSING directory is remembered only until the memo turns over, so a clone that appears later is found
  repoKeyMemo.set(dir, key)
  return key
}

/** The distinct repositories behind `dirs`, as one directory each, in the order asked. */
async function distinctRepos(dirs: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    const k = await repoKey(d)
    if (k === null || seen.has(k)) continue
    seen.add(k); out.push(d)
  }
  return out
}

/** Does a version tag of THIS repository contain the commit? Any failure is "no". */
export async function tagContainsIn(sha: string, dir: string): Promise<boolean> {
  if (!HEX.test(sha)) return false
  const r = await git(dir, ['tag', '--contains', sha, '--list', 'v[0-9]*'])
  return r.ok && r.out.length > 0
}

// ------------------------------------------------------------------ engine pins

interface PinCache { at: number; pins: string[] }
const pinMemo = new Map<string, PinCache>()
/** tag → pinned engine ref (or null: no engine.pin in that tag). A tag is immutable, so this never expires. */
const tagPin = new Map<string, string | null>()

/** The distinct engine commits pinned by the newest release tags of one public repository. */
export async function enginePins(dir: string, nowMs = Date.now()): Promise<string[]> {
  const key = (await repoKey(dir)) ?? dir
  const hit = pinMemo.get(key)
  if (hit && nowMs - hit.at < PIN_TTL_MS) return hit.pins
  const tags = await git(dir, ['tag', '--list', 'v[0-9]*', '--sort=-version:refname'])
  const pins = new Set<string>()
  if (tags.ok) {
    for (const tag of tags.out.split('\n').filter(Boolean).slice(0, MAX_PIN_TAGS)) {
      const id = `${key}\0${tag}`
      let ref = tagPin.get(id)
      if (ref === undefined) {
        const r = await git(dir, ['show', `${tag}:engine.pin`])
        ref = null
        if (r.ok) { try { const j = JSON.parse(r.out) as { ref?: unknown }; if (typeof j.ref === 'string' && HEX.test(j.ref)) ref = j.ref } catch { /* not a pin file */ } }
        if (tagPin.size >= 2000) tagPin.clear()
        tagPin.set(id, ref)
      }
      if (ref) pins.add(ref)
    }
  }
  const list = [...pins]
  if (pinMemo.size >= 50) pinMemo.clear()
  pinMemo.set(key, { at: nowMs, pins: list })
  return list
}

/** Is `sha` (an engine commit) an ancestor of an engine commit some public release pins? */
export async function enginePublishedIn(sha: string, repos: readonly string[], nowMs = Date.now()): Promise<boolean> {
  if (!HEX.test(sha)) return false
  const pins = new Set<string>()
  for (const d of repos) for (const p of await enginePins(d, nowMs)) pins.add(p)
  if (pins.size === 0) return false
  for (const d of repos) {
    // this clone must hold the commit, or it cannot say anything about it
    if (!(await git(d, ['cat-file', '-e', `${sha}^{commit}`])).ok) continue
    for (const pin of pins) {
      if ((await git(d, ['merge-base', '--is-ancestor', sha, pin])).ok) return true
    }
  }
  return false
}

/** The real question: is this commit in a published release, asked in the given clones? */
export async function publishedIn(sha: string, dirs: readonly string[], nowMs = Date.now()): Promise<boolean> {
  if (!HEX.test(sha)) return false
  // never the process's own directory: no clone named means no answer (a server outside a checkout, or a test, must not read whatever it is run from)
  const repos = await distinctRepos(dirs)
  for (const d of repos) if (await tagContainsIn(sha, d)) return true
  if (await enginePublishedIn(sha, repos, nowMs)) return true
  // a SQUASH-merged pull request leaves the worker's commit outside every tag: compare the change itself
  for (const d of repos) if (await squashPublishedIn(sha, d, (await repoKey(d)) ?? d, nowMs)) return true
  return false
}

async function refill(
  todo: string[],
  ask: (sha: string, dirs: readonly string[]) => Promise<boolean>,
  dirsFor: (sha: string) => readonly string[],
  nowMs: number,
): Promise<void> {
  for (const sha of todo.slice(0, MAX_PER_REFILL)) {
    let yes = false
    try { yes = await ask(sha, dirsFor(sha)) } catch { yes = false }
    if (yes) { boundedAdd(positive, sha, MAX_POSITIVE); negative.delete(sha) } else {
      if (negative.size >= MAX_NEGATIVE && !negative.has(sha)) { const k = negative.keys().next(); if (!k.done) negative.delete(k.value) }
      negative.set(sha, nowMs)
    }
  }
}

/**
 * The subset of `shas` a published tag is known to contain; unknown ones are resolved in the background, each
 * in the clones `dirsFor(sha)` names (none: the process's own directory, which is only right inside a checkout).
 */
export function publishedAmong(
  shas: readonly string[],
  nowMs = Date.now(),
  ask: (sha: string, dirs: readonly string[]) => Promise<boolean> = (s, d) => publishedIn(s, d, nowMs),
  dirsFor: (sha: string) => readonly string[] = () => [],
): ReadonlySet<string> {
  const out = new Set<string>()
  const todo: string[] = []
  for (const sha of shas) {
    if (positive.has(sha)) { out.add(sha); continue }
    const at = negative.get(sha)
    if (at === undefined || nowMs - at >= NEGATIVE_TTL_MS) todo.push(sha)
  }
  if (todo.length > 0 && running === null) {
    running = refill(todo, ask, dirsFor, nowMs).finally(() => { running = null })
  }
  return out
}

/** Test seam: forget everything, and wait for the refill in flight. */
export async function resetReleaseTagsForTest(): Promise<void> {
  await running
  positive.clear(); negative.clear(); repoKeyMemo.clear(); pinMemo.clear(); tagPin.clear(); resetReleaseSquashForTest()
}
export const releaseTagsIdle = (): Promise<void> => running ?? Promise.resolve()
