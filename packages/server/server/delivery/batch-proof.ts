/**
 * delivery/batch-proof.ts — CICLO.RECONCILE-2 (HIGH). Evidence for a piece from a MERGED release PR that lists it.
 *
 * Legacy pieces were shipped by BATCH release PRs ("v2.198.0: … (fix/metricas-soma, fix/opencode-metricas-v2)") and carry no
 * pr/branch/sha of their own, so the per-piece routes of `findMergedPr` prove nothing for them. The PR body does: it names the
 * subtask id, the branch, or the commit shas of the piece. `matchBatchPr` (PURE) picks the one merged PR that names the
 * piece — two different PRs are ambiguous and prove nothing. `loadBatchPrs` / `findEnginePinTag` read gh, once per run.
 * The merge commit always comes from gh, never from the caller.
 */
import type { GateFacts } from './gates'
import { DEFAULT_RELEASE_REPO } from './gates'

export const ENGINE_REPO = 'agentistics/agentistics-engine'
/** Public release tags only (`vscode-v*` and friends are other products). */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/
/** Pull requests read per repository per run (newest first). */
export const BATCH_PR_LIMIT = 300
/** Tags walked when looking for the first public release that pins an engine commit. */
const ENGINE_TAG_WALK = 60

export interface BatchPr { repo: string; number: number; title: string; body: string; mergeSha: string; mergedAt?: string; headRefName?: string; headRefOid?: string }

/** What is known about a piece that a PR text may name. */
export interface PieceHints { subtaskId: string; title?: string; branches: readonly string[]; shas: readonly string[] }

export type BatchMatch =
  | { ok: true; pr: BatchPr; via: string }
  | { ok: false; reason: string; ambiguous?: boolean }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HEX = /\b[0-9a-f]{7,40}\b/g

/** PURE. Does this text name the branch as a whole token (not as a prefix of a longer branch)? */
export function textNamesBranch(text: string, branch: string): boolean {
  if (branch.length < 5 || !branch.includes('/')) return false
  return new RegExp(`(?<![\\w/.-])${escapeRe(branch)}(?![\\w/-])`, 'i').test(text)
}

/** PURE. Does this text name a commit that is the piece's sha (a ≥7-char prefix either way)? */
export function textNamesSha(text: string, shas: readonly string[]): boolean {
  const want = shas.map(s => s.toLowerCase()).filter(s => /^[0-9a-f]{7,40}$/.test(s))
  if (want.length === 0) return false
  for (const m of text.toLowerCase().matchAll(HEX)) {
    const tok = m[0]!
    if (!/\d/.test(tok)) continue
    if (want.some(s => s.startsWith(tok) || tok.startsWith(s))) return true
  }
  return false
}

/** PURE. The `CODE.NAME` a card is titled by (`METRICAS.SOMA …`), when it has one distinctive enough to search for. */
export function titleCode(title: string | undefined): string | null {
  const m = /^\s*([A-Z0-9]{2,}(?:[.-][A-Z0-9]{2,})+)\b/.exec(title ?? '')
  return m ? m[1]! : null
}

const rank = (pr: BatchPr) => `${pr.repo}#${pr.number}`

/**
 * PURE. The ONE merged PR that names this piece. Tiers, strongest first: the subtask id; then the piece's branch or commit
 * shas; then the card's `CODE.NAME`. A tier that names exactly one PR wins; one that names several is AMBIGUOUS (nothing is
 * proven — a wrong PR would publish a piece that never shipped); a tier that names none falls to the next.
 */
export function matchBatchPr(prs: readonly BatchPr[], piece: PieceHints): BatchMatch {
  const merged = [...new Map(prs.filter(p => p.mergeSha).map(p => [rank(p), p] as const)).values()]
  const tiers: Array<{ via: string; hit: (p: BatchPr) => boolean }> = [
    { via: 'subtask id in the release PR', hit: p => `${p.title}\n${p.body}`.includes(piece.subtaskId) },
    { via: 'branch/sha in the release PR', hit: p => {
      const text = `${p.title}\n${p.body}`
      return piece.branches.some(b => textNamesBranch(text, b) || p.headRefName === b) || textNamesSha(text, piece.shas) || (!!p.headRefOid && piece.shas.includes(p.headRefOid))
    } },
  ]
  const code = titleCode(piece.title)
  if (code) tiers.push({ via: `card name ${code} in the release PR`, hit: p => `${p.title}\n${p.body}`.toUpperCase().includes(code) })
  for (const t of tiers) {
    const hits = merged.filter(t.hit)
    if (hits.length === 1) return { ok: true, pr: hits[0]!, via: t.via }
    if (hits.length > 1) return { ok: false, ambiguous: true, reason: `ambiguous: ${hits.length} merged PRs name this piece (${hits.map(h => `#${h.number}`).join(', ')}) — not proven` }
  }
  return { ok: false, reason: 'no merged release PR names this piece (subtask id, branch or commit)' }
}

/** PURE. Branch-like and sha-like tokens found in free text (board comments / notes of a legacy piece). */
export function hintsFromText(text: string): { branches: string[]; shas: string[] } {
  const branches = new Set<string>()
  for (const m of text.matchAll(/(?<![\w/.-])((?:fix|feat|perf|chore|refactor|docs|test|hotfix)\/[\w.-]+(?:\/[\w.-]+)*)/gi)) branches.add(m[1]!.replace(/[.,;:)]+$/, ''))
  const shas = new Set<string>()
  for (const m of text.toLowerCase().matchAll(HEX)) if (/\d/.test(m[0]!) && /[a-f]/.test(m[0]!)) shas.add(m[0]!)
  return { branches: [...branches], shas: [...shas] }
}

const json = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T } catch { return fallback } }

/** One run's gh cache: a PR list per repository, a pin per tag, an ancestry fact per pair. */
export interface ProofCache {
  prs: Map<string, BatchPr[]>
  pins: Map<string, string | null>
  tags: { list: string[] | null; shas: Map<string, string>; complete: boolean }
  contains: Map<string, boolean | null>
}
export const newProofCache = (): ProofCache => ({ prs: new Map(), pins: new Map(), tags: { list: null, shas: new Map(), complete: false }, contains: new Map() })

const TAG_PAGES = 5

/** The public release tags (`vN.N.N`), newest first BY VERSION, with their commits; read once per run (up to 500 tags). */
async function publicTags(f: GateFacts, cwd: string, cache: ProofCache): Promise<string[]> {
  if (cache.tags.list) return cache.tags.list
  const semver = (t: string) => t.slice(1).split('.').map(Number)
  const names: string[] = []
  for (let page = 1; page <= TAG_PAGES; page++) {
    const rows = json<Array<{ name?: string; commit?: { sha?: string } }>>(await f.gh(cwd, ['api', `repos/${DEFAULT_RELEASE_REPO}/tags?per_page=100&page=${page}`]).catch(() => '[]'), [])
    const list = Array.isArray(rows) ? rows : []
    for (const t of list) if (t.name && RELEASE_TAG.test(t.name)) { names.push(t.name); if (t.commit?.sha) cache.tags.shas.set(t.name, t.commit.sha) }
    if (list.length < 100) { cache.tags.complete = true; break }
  }
  // The API's own order is not a version order.
  cache.tags.list = names.sort((a, b) => { const x = semver(a); const y = semver(b); return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!) })
  return cache.tags.list
}

/**
 * The FIRST public release tag that contains a public commit: walk the tags newest to oldest while each still contains it; the
 * last one that did is the first release. The walk must END at a tag that does not contain it (or at the end of a complete
 * listing) — a walk that ran off a partial page proves nothing, so it answers null. null also when nothing contains it yet.
 */
export async function findPublicTag(f: GateFacts, cwd: string, mergeSha: string, cache: ProofCache): Promise<string | null> {
  const tags = await publicTags(f, cwd, cache)
  const has = async (tag: string): Promise<boolean | null> => {
    const sha = cache.tags.shas.get(tag)
    if (!sha) return null
    const key = `pub:${mergeSha}...${sha}`
    let v = cache.contains.get(key)
    if (v === undefined) {
      if (sha === mergeSha) v = true
      else {
        const st = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${DEFAULT_RELEASE_REPO}/compare/${mergeSha}...${sha}`, '--jq', '{status: .status}']).catch(() => '{}'), {}).status
        v = st ? st === 'ahead' || st === 'identical' : null
      }
      cache.contains.set(key, v)
    }
    return v
  }
  const idx = await bisectFirst(tags, has)
  // A listing that ran off a partial page proves nothing when even the oldest tag read still contains the commit.
  if (idx !== null && idx === tags.length - 1 && !cache.tags.complete) return null
  return idx === null ? null : tags[idx]!
}

/**
 * PURE-ish. `tags` newest first; containment is monotonic (once a release contains a commit every later one does), so the
 * containing tags are a prefix. Returns the index of the OLDEST containing tag (the first release), or null when the newest
 * does not contain it or any answer is unreadable. O(log n) look-ups instead of one per tag.
 */
export async function bisectFirst(tags: readonly string[], has: (tag: string) => Promise<boolean | null>): Promise<number | null> {
  if (tags.length === 0) return null
  const top = await has(tags[0]!)
  if (top !== true) return null
  let lo = 0 // known containing
  let hi = tags.length // exclusive upper bound; tags[hi..] unknown/not containing
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    const v = await has(tags[mid]!)
    if (v === null) return null
    if (v) lo = mid; else hi = mid
  }
  return lo
}

/** Merged PRs of a repository (title, body, merge commit), newest first. Never throws: an unreadable source is an empty list. */
export async function loadBatchPrs(f: GateFacts, cwd: string, repo: string, cache: ProofCache): Promise<BatchPr[]> {
  const hit = cache.prs.get(repo)
  if (hit) return hit
  type Row = { number?: number; title?: string; body?: string; mergedAt?: string; headRefName?: string; headRefOid?: string; mergeCommit?: { oid?: string } | null }
  const raw = json<Row[]>(await f.gh(cwd, ['pr', 'list', '-R', repo, '--state', 'merged', '--limit', String(BATCH_PR_LIMIT), '--json', 'number,title,body,mergedAt,headRefName,headRefOid,mergeCommit']).catch(() => '[]'), [])
  const out = (Array.isArray(raw) ? raw : []).flatMap((p): BatchPr[] => (typeof p.number === 'number' && p.mergeCommit?.oid
    ? [{ repo, number: p.number, title: p.title ?? '', body: p.body ?? '', mergeSha: p.mergeCommit.oid, ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}), ...(p.headRefName ? { headRefName: p.headRefName } : {}), ...(p.headRefOid ? { headRefOid: p.headRefOid } : {}) }]
    : []))
  cache.prs.set(repo, out)
  return out
}

/**
 * The FIRST public release tag whose `engine.pin` contains the engine commit (engine PRs have no tag of their own): walk the
 * public tags newest to oldest while the pin still contains the commit; the last one that did is the first release.
 * null = not released yet (or not readable). Pins and ancestry are immutable, so both are cached for the run.
 */
export async function findEnginePinTag(f: GateFacts, cwd: string, engineSha: string, cache: ProofCache): Promise<string | null> {
  const tagList = await publicTags(f, cwd, cache)
  const pinOf = async (tag: string): Promise<string | null> => {
    if (cache.pins.has(tag)) return cache.pins.get(tag)!
    const b64 = (await f.gh(cwd, ['api', `repos/${DEFAULT_RELEASE_REPO}/contents/engine.pin?ref=${tag}`, '--jq', '.content']).catch(() => '')).trim()
    let ref: string | null = null
    if (b64) { try { const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { ref?: unknown }; ref = typeof j.ref === 'string' && /^[0-9a-f]{7,40}$/i.test(j.ref) ? j.ref.toLowerCase() : null } catch { ref = null } }
    cache.pins.set(tag, ref)
    return ref
  }
  const containsOf = async (pin: string): Promise<boolean | null> => {
    const key = `${engineSha}...${pin}`
    if (cache.contains.has(key)) return cache.contains.get(key)!
    if (pin === engineSha.toLowerCase()) { cache.contains.set(key, true); return true }
    const st = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${ENGINE_REPO}/compare/${engineSha}...${pin}`, '--jq', '{status: .status}']).catch(() => '{}'), {}).status
    const v = st ? st === 'ahead' || st === 'identical' : null
    cache.contains.set(key, v)
    return v
  }
  // A tag with no readable pin (before the engine existed) does not contain the commit.
  const idx = await bisectFirst(tagList.slice(0, ENGINE_TAG_WALK), async tag => { const pin = await pinOf(tag); return pin ? containsOf(pin) : false })
  return idx === null ? null : tagList[idx]!
}
