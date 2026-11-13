/**
 * release-squash.ts — IO. Is a commit's WORK inside a published release even though the commit itself is not?
 *
 * This repository lands pull requests by SQUASH: the release tag holds `fix: … (#1345)`, a new commit, and the
 * worker's own commit (the one its handback names) sits on a branch the tag never contains. `git tag --contains`
 * therefore answers "no" for every squash-merged piece — which is nearly all of them (measured: of 182 commits
 * named by in-review pieces, 40 were reachable from a tag; every piece of 2.200.7 was a squash).
 *
 * What survives a squash is the CHANGE: `git patch-id --stable` hashes the added/removed lines and ignores the
 * commit message, the parent and the line numbers. So a commit's work is published when the patch-id of
 *  - the commit itself (a one-commit PR, or a rebase merge), or
 *  - the whole diff of a remote branch that contains it, from its merge-base with the release line (a squashed
 *    PR of several commits)
 * equals the patch-id of some non-merge commit in a release tag's own range. Per-tag ids are computed once
 * (a tag never changes) for the newest tags only. A wrong "yes" needs an identical diff, which is the claim
 * being made; a "no" is never fatal — it is the same "review" the card showed before.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitEnv } from './release-repos'

const GIT_TIMEOUT_MS = 20_000
/** A diff larger than this is not worth proving (it is a rename/format sweep, not a piece of work). */
const MAX_DIFF = 2 << 20
/** The reverse-apply proof is tried on this many of the newest releases. */
const REVERSE_APPLY_TAGS = 3
const MAX_TAGS = 12
/** `squashTagOf` walks every release newer than the commit; this only bounds a pathological history. */
const MAX_WALK_TAGS = 600
const MAX_BRANCHES_PER_SHA = 3
const MAX_BUFFER = 48 << 20
const HEX = /^[0-9a-f]{7,40}$/

function run(dir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER, env: gitEnv() }, (err, out) => resolve({ ok: !err, out: String(out ?? '') }))
  })
}

/** `git patch-id --stable` over a patch stream: one `<patch-id> <commit>` line per patch. */
function patchIds(dir: string, patch: string): Promise<{ id: string; commit: string }[]> {
  return new Promise(resolve => {
    if (!patch.trim()) { resolve([]); return }
    const p = spawn('git', ['-C', dir, 'patch-id', '--stable'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: gitEnv() })
    let out = ''
    const t = setTimeout(() => p.kill(), GIT_TIMEOUT_MS)
    p.stdout.on('data', d => { out += String(d) })
    p.on('error', () => { clearTimeout(t); resolve([]) })
    p.on('close', () => { clearTimeout(t); resolve(out.split('\n').filter(Boolean).map(l => { const [id, commit] = l.split(' '); return { id: id!, commit: commit ?? '' } })) })
    p.stdin.on('error', () => {})
    p.stdin.end(patch)
  })
}

/** tag → the patch-ids of the non-merge commits it added over the previous tag. A tag is immutable: kept for the process. */
const tagIds = new Map<string, Set<string>>()
const MAX_TAG_CACHE = 2000

async function idsOfTag(dir: string, repoKey: string, tag: string, prev: string | null): Promise<Set<string>> {
  const key = `${repoKey}\0${tag}`
  const hit = tagIds.get(key)
  if (hit) return hit
  const range = prev ? `${prev}..${tag}` : tag
  const log = await run(dir, ['log', '-p', '--no-merges', '--max-count=400', range])
  const ids = new Set((await patchIds(dir, log.ok ? log.out : '')).map(x => x.id))
  if (tagIds.size >= MAX_TAG_CACHE) tagIds.clear()
  // a failed read is not remembered as "the tag adds nothing": only a successful one is cached
  if (log.ok) tagIds.set(key, ids)
  return ids
}

interface TagList { at: number; tags: string[] }
const tagLists = new Map<string, TagList>()
const TAG_LIST_TTL_MS = 10 * 60_000

async function newestTags(dir: string, repoKey: string, nowMs: number): Promise<string[]> {
  const hit = tagLists.get(repoKey)
  if (hit && nowMs - hit.at < TAG_LIST_TTL_MS) return hit.tags
  const r = await run(dir, ['tag', '--list', 'v[0-9]*', '--sort=-version:refname'])
  const tags = r.ok ? r.out.split('\n').filter(Boolean).slice(0, MAX_TAGS + 1) : []
  if (tagLists.size >= 50) tagLists.clear()
  tagLists.set(repoKey, { at: nowMs, tags })
  return tags
}

/**
 * What stands for `sha`'s work: the patch-id of its own diff and of the whole-branch diff of up to a few branches
 * holding it, plus those branch diffs themselves (for the reverse-apply proof below).
 */
async function candidates(dir: string, sha: string, release: string): Promise<{ ids: string[]; diffs: string[] }> {
  const ids: string[] = []
  const diffs: string[] = []
  const own = await run(dir, ['show', '--format=commit %H', '--no-color', sha])
  if (own.ok) { for (const x of await patchIds(dir, own.out)) ids.push(x.id); if (own.out.length <= MAX_DIFF) diffs.push(own.out) }
  // The pull request as it stood at this commit (its fork point from the release line up to it): a squash of a PR whose
  // head IS the delivered commit has exactly this diff, even once the branch itself is deleted.
  const fork = await run(dir, ['merge-base', release, sha])
  if (fork.ok && fork.out.trim() && fork.out.trim() !== sha) {
    const upTo = await run(dir, ['diff', '--no-color', `${fork.out.trim()}..${sha}`])
    if (upTo.ok && upTo.out.trim() && upTo.out.length <= MAX_DIFF) {
      const id = (await patchIds(dir, `commit ${sha}\n\n${upTo.out}`))[0]?.id
      if (id) ids.push(id)
    }
  }
  const br = await run(dir, ['branch', '-a', '--contains', sha, '--format=%(refname:short)'])
  const branches = br.ok
    ? br.out.split('\n').map(s => s.trim()).filter(b => b && !/(^|\/)(HEAD|main|dev|master)$/.test(b) && !b.includes(' ')).slice(0, MAX_BRANCHES_PER_SHA)
    : []
  for (const b of branches) {
    const base = await run(dir, ['merge-base', release, b])
    if (!base.ok || !base.out.trim()) continue
    const diff = await run(dir, ['diff', '--no-color', `${base.out.trim()}..${b}`])
    if (!diff.ok) continue
    for (const x of await patchIds(dir, diff.out)) ids.push(x.id)
    if (diff.out.trim() && diff.out.length <= MAX_DIFF) diffs.push(diff.out)
  }
  return { ids, diffs }
}

/**
 * Is every change of `diff` already present in the tree of `tag`? A squash that folded SEVERAL branches into one
 * commit matches no single patch-id, but its tree still holds each branch's change: the diff applies in REVERSE
 * onto that tree, against a throwaway index (nothing in the repository is touched).
 */
async function treeHoldsDiff(dir: string, tag: string, diff: string): Promise<boolean> {
  const tmp = mkdtempSync(join(tmpdir(), 'rel-squash-'))
  const env = gitEnv({ GIT_INDEX_FILE: join(tmp, 'index') })
  try {
    const read = await new Promise<boolean>(resolve => {
      execFile('git', ['-C', dir, 'read-tree', tag], { env, timeout: GIT_TIMEOUT_MS, windowsHide: true }, err => resolve(!err))
    })
    if (!read) return false
    return await new Promise<boolean>(resolve => {
      const p = spawn('git', ['-C', dir, 'apply', '-R', '--check', '--cached'], { env, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
      const t = setTimeout(() => p.kill(), GIT_TIMEOUT_MS)
      p.on('error', () => { clearTimeout(t); resolve(false) })
      p.on('close', code => { clearTimeout(t); resolve(code === 0) })
      p.stdin.on('error', () => {})
      p.stdin.end(diff)
    })
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

/** Every `v<x.y.z>` tag, newest version first, with the tag's own date (seconds). Kept for a few minutes. */
interface DatedTags { at: number; tags: { tag: string; atSec: number }[] }
const datedTagLists = new Map<string, DatedTags>()

async function allTagsDated(dir: string, repoKey: string, nowMs: number): Promise<{ tag: string; atSec: number }[]> {
  const hit = datedTagLists.get(repoKey)
  if (hit && nowMs - hit.at < TAG_LIST_TTL_MS) return hit.tags
  const r = await run(dir, ['for-each-ref', '--sort=-version:refname', '--format=%(refname:short) %(creatordate:unix)', 'refs/tags/v*'])
  const tags = r.ok
    ? r.out.split('\n').flatMap(l => { const [tag, at] = l.trim().split(' '); return tag && /^v\d+\.\d+\.\d+$/.test(tag) ? [{ tag, atSec: Number(at) || 0 }] : [] })
    : []
  if (datedTagLists.size >= 50) datedTagLists.clear()
  datedTagLists.set(repoKey, { at: nowMs, tags })
  return tags
}

/**
 * The version (`x.y.z`) of the release whose OWN range (previous version tag..this tag) carries the WORK of `sha`,
 * though the commit itself is in no tag — the squash-merge case ("fix: … (#N)" on main). PROVEN ONLY: one of the
 * commit's patch-ids (its own diff, its branch up to it, or the whole branch holding it — see `candidates`) must be
 * EQUAL to the patch-id of a commit inside that range. Ranges are disjoint, so the match names exactly the release
 * that added the change. Tags are walked newest to oldest, every one of them, until a tag older than the commit
 * itself (the release cannot predate the work). Everything else — a squash that folded several branches, cherry-picks,
 * a branch since deleted — is null: the version is unknown, never guessed. The reverse-apply "the tree holds it"
 * proof is deliberately NOT used here: it says "it is in the code", never which release put it there (it answered
 * "the 3rd-newest tag" for any old change and labelled 2.165.3 work as "published in 2.210.0").
 */
export async function squashTagOf(sha: string, dir: string, repoKey: string, nowMs = Date.now()): Promise<string | null> {
  if (!HEX.test(sha)) return null
  const at = await run(dir, ['log', '-1', '--format=%ct', `${sha}^{commit}`])
  if (!at.ok) return null
  const commitSec = Number(at.out.trim()) || 0
  const tags = await allTagsDated(dir, repoKey, nowMs)
  if (tags.length === 0) return null
  const cand = await candidates(dir, sha, tags[0]!.tag)
  if (cand.ids.length === 0) return null
  const want = new Set(cand.ids)
  for (let i = 0; i < Math.min(tags.length, MAX_WALK_TAGS); i++) {
    const t = tags[i]!
    // a release published before the commit existed cannot carry it (walk newest → oldest, so nothing older can either)
    if (t.atSec > 0 && commitSec > 0 && t.atSec < commitSec) break
    const ids = await idsOfTag(dir, repoKey, t.tag, tags[i + 1]?.tag ?? null)
    for (const id of ids) if (want.has(id)) return t.tag.slice(1)
  }
  return null
}

/**
 * Is the work of `sha` inside a release tag of this repository, though the commit itself is not? Any failure is "no".
 * This is the Live's yes/no (unchanged since 2.200): a patch-id match on the newest releases, or — for several branches
 * squashed together — the newest releases' trees still holding the change. It never names a version.
 */
export async function squashPublishedIn(sha: string, dir: string, repoKey: string, nowMs = Date.now()): Promise<boolean> {
  if (!HEX.test(sha)) return false
  if (!(await run(dir, ['cat-file', '-e', `${sha}^{commit}`])).ok) return false
  const tags = await newestTags(dir, repoKey, nowMs)
  if (tags.length === 0) return false
  const cand = await candidates(dir, sha, tags[0]!)
  if (cand.ids.length > 0) {
    for (let i = 0; i < Math.min(tags.length, MAX_TAGS); i++) {
      const ids = await idsOfTag(dir, repoKey, tags[i]!, tags[i + 1] ?? null)
      if (cand.ids.some(c => ids.has(c))) return true
    }
  }
  for (const diff of cand.diffs) for (const tag of tags.slice(0, REVERSE_APPLY_TAGS)) if (await treeHoldsDiff(dir, tag, diff)) return true
  return false
}

export function resetReleaseSquashForTest(): void { tagIds.clear(); tagLists.clear(); datedTagLists.clear() }
