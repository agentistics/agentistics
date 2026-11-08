/**
 * delivery/batch-proof.ts — CICLO.RECONCILE-2. Evidence for a legacy piece from a MERGED release PR.
 *
 * Legacy pieces were shipped by BATCH release PRs and carry no pr/branch/sha of their own. r2 (QA + leader, 08/11): free text is
 * NOT evidence. A task id read as a sha, a base sha quoted in a comment, a file path read as a branch and a card's name all
 * published work that never shipped. So:
 *
 *   STRONG (moves a piece), all from what the piece's OWN delivery declared, checked against gh's facts of a PR that merged into
 *   the default branch of the CARD'S repository, after the card existed:
 *     1. a declared commit that is a real commit of that PR (`commits`, gh's list: a short declared sha resolves to a full one);
 *     2. the PR whose head is the declared branch, merged after that declaration;
 *     3. a PR number the delivery's handback states (unambiguous across the card's repositories).
 *   WEAK (never moves anything, shown as a SUGGESTION in "Antigas"): the piece's id or the card's whole CODE.NAME in the PR's text,
 *   or a declared branch named there. Text is somebody's sentence; only the three above are gh's facts (leader, 08/11).
 *
 * A PR into `dev` proves nothing: its merge commit never reaches a tag. The merge commit always comes from gh, never the caller.
 * Everything gh answered is kept in a `ProofCache`, which survives restarts (see `service.ts`): commits, ancestry and a green tag
 * never change, so a second run costs nothing.
 */
import type { GateFacts } from './gates'
import { DEFAULT_RELEASE_REPO } from './gates'

export const ENGINE_REPO = 'agentistics/agentistics-engine'
/** Public release tags only (`vscode-v*` and friends are other products). */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/
/** Pull requests read per repository per refresh (newest first). */
export const BATCH_PR_LIMIT = 300
/** Tags walked when looking for the first public release that pins an engine commit. */
const ENGINE_TAG_WALK = 200
/** What may change on GitHub (new PRs, new tags) is asked again after this long; what cannot change is never asked twice. */
export const PROOF_REFRESH_MS = 60 * 60_000
/** Pages of 100 PRs read for their commit lists; only the pages holding PRs not read before. */
const COMMIT_PAGES = 5
/** A delivery's declaration may precede the merge of its branch by clock skew only. */
const DECLARE_SKEW_MS = 60_000

export interface BatchPr { repo: string; number: number; title: string; body: string; mergeSha: string; mergedAt?: string; headRefName?: string; headRefOid?: string; baseRefName?: string; /** gh's own list of the PR's commits (full shas). */ commits?: readonly string[] }

/** A branch and the commit the delivery said it stood at, and when (the LAST statement per branch wins). */
export interface DeclaredHead { branch: string; sha: string; atMs?: number }

/** What is known about a piece that a PR may prove. */
export interface PieceHints {
  subtaskId: string
  title?: string
  /** Branches the delivery declared (named in a PR's text they only make a suggestion). */
  branches: readonly string[]
  /** FULL commit shas the delivery declared. */
  shas: readonly string[]
  heads?: readonly DeclaredHead[]
  /** PR numbers the delivery's handback states. */
  prs?: readonly number[]
  /** The commits of the LAST statement that named any: an earlier round that shipped does not ship the later one. Absent = every declared commit counts. */
  latest?: readonly string[]
  /** The repositories of the card (`owner/name`); absent = the host could not say, every PR passed in is considered. */
  repos?: readonly string[]
  /** When the card was created: a PR merged before it cannot have shipped it. */
  createdMs?: number | null
}

export interface BatchSuggestion { pr: BatchPr; via: string }

export type BatchMatch =
  | { ok: true; pr: BatchPr; via: string }
  | { ok: false; reason: string; ambiguous?: boolean; /** The PRs that tie (ambiguous only): they prove the piece together when they all shipped in ONE release. */ candidates?: BatchPr[]; /** Weak evidence: shown to the person, moves nothing. */ suggestion?: BatchSuggestion }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const FULL_SHA = /(?<![\w-])[0-9a-f]{40}(?![\w-])/g

/** PURE. Does the PR merge into a default branch? A PR into `dev` never reaches a tag. Absent = gh did not say (an old fake, an old gh). */
export function isReleaseBase(base: string | undefined): boolean {
  return base === undefined || base === '' || base === 'main' || base === 'master'
}

/** PURE. Does this text name the branch as a whole token (not as a prefix of a longer branch)? */
export function textNamesBranch(text: string, branch: string): boolean {
  if (branch.length < 5 || !branch.includes('/')) return false
  return new RegExp(`(?<![\\w/.-])${escapeRe(branch)}(?![\\w/-])`, 'i').test(text)
}

/** PURE. Does this text state one of these FULL commits? A short prefix in a PR's text is not evidence (it was a base, a pin, an id). */
export function textNamesSha(text: string, shas: readonly string[]): boolean {
  const want = new Set(shas.map(s => s.toLowerCase()).filter(s => s.length === 40))
  if (want.size === 0) return false
  for (const m of text.toLowerCase().matchAll(FULL_SHA)) if (want.has(m[0])) return true
  return false
}

/** PURE. The whole `CODE.NAME` a card is titled by (`JARVIS.VOZ-BUGS-2 — …`), when it has one distinctive enough to search for. */
export function titleCode(title: string | undefined): string | null {
  const m = /^\s*([A-Z0-9]{2,}(?:[.-][A-Z0-9]+)+)(?![\w.-])/.exec(title ?? '')
  return m ? m[1]! : null
}

/** A line of a PR saying the piece was left OUT is the opposite of evidence. */
const LEFT_OUT = /\b(not included|not part|left out|excluded|deferred|next batch|next release|n[ãa]o (?:entra|inclu|vai)|fica(?:m)? (?:para|pra|de fora)|ficou de fora|fora d[oe]s?\b|pr[óo]ximo lote|adiad[oa])/i
const linesNaming = (text: string, has: (line: string) => boolean): boolean => text.split('\n').some(l => has(l) && !LEFT_OUT.test(l))

/** PURE. Does this text name the code as a whole word (`UI.MOBILE` is not `UI.MOBILE-TABLET`), on a line that does not leave it out? */
export function textNamesCode(text: string, code: string): boolean {
  const re = new RegExp(`(?<![\\w.-])${escapeRe(code)}(?![\\w-]|\\.\\w)`)
  return linesNaming(text, l => re.test(l))
}

const mergedMs = (p: BatchPr) => (p.mergedAt ? Date.parse(p.mergedAt) || null : null)

/**
 * PURE. The ONE merged PR that proves this piece (see the header for the tiers, strongest first). A tier that names exactly one
 * PR wins; one that names several is AMBIGUOUS unless another tier singles one out; a tier that names none falls to the next.
 * With no strong evidence at all the answer is not ok, and may carry a SUGGESTION.
 */
export function matchBatchPr(prs: readonly BatchPr[], piece: PieceHints): BatchMatch {
  const merged = [...new Map(prs.filter(p => p.mergeSha && isReleaseBase(p.baseRefName) && (!piece.repos || piece.repos.includes(p.repo))
    // Keyed by the merge commit: a renamed repository answers under both names, and one merge is one PR however many names reach it.
    && !(piece.createdMs != null && mergedMs(p) !== null && mergedMs(p)! < piece.createdMs)).map(p => [p.mergeSha, p] as const)).values()]
  const heads = piece.heads ?? []
  const stated = new Map<number, number>()
  for (const p of merged) stated.set(p.number, (stated.get(p.number) ?? 0) + 1)
  const oidsOf = (p: BatchPr) => [...(p.commits ?? []), ...(p.headRefOid ? [p.headRefOid] : [])]
  const fullShas = piece.shas.filter(s => s.length === 40)
  const counts = (sha: string) => !piece.latest || piece.latest.includes(sha)
  const carries = (p: BatchPr, full: readonly string[], short: readonly DeclaredHead[]): boolean => {
    const oids = oidsOf(p)
    return full.some(s => oids.includes(s)) || short.some(h => h.sha.length >= 7 && oids.some(o => o.startsWith(h.sha))) || textNamesSha(`${p.title}\n${p.body}`, full)
  }
  const tiers: Array<{ via: string; hit: (p: BatchPr) => boolean }> = [
    { via: 'declared commit in the release PR', hit: p => carries(p, fullShas.filter(counts), heads.filter(h => counts(h.sha))) },
    { via: 'PR of the declared branch', hit: p => heads.some(h => p.headRefName === h.branch && (h.atMs === undefined || mergedMs(p) === null || mergedMs(p)! >= h.atMs - DECLARE_SKEW_MS)) },
    { via: 'PR number stated by the delivery', hit: p => (piece.prs ?? []).includes(p.number) && stated.get(p.number) === 1 },
  ]
  // The proof says WHICH commit: a person reading "published" must be able to check it without re-running anything.
  const named = (via: string, p: BatchPr): string => {
    if (!via.includes('declared commit')) return via
    const oids = oidsOf(p)
    const full = fullShas.find(s => counts(s) && oids.includes(s))
    const head = heads.find(h => counts(h.sha) && h.sha.length >= 7 && oids.some(o => o.startsWith(h.sha)))
    return full ? `${via}: ${full.slice(0, 12)}` : head ? `${via}: ${head.branch} @ ${head.sha.slice(0, 12)}` : via
  }
  const hitsByTier = tiers.map(t => ({ via: t.via, hits: merged.filter(t.hit) }))
  for (const t of hitsByTier) {
    if (t.hits.length === 1) return { ok: true, pr: t.hits[0]!, via: named(t.via, t.hits[0]!) }
    if (t.hits.length > 1) {
      // Several PRs at this tier: another tier's evidence may single one out (its id AND its commit point at one PR).
      let narrowed = t.hits
      for (const o of hitsByTier) if (o !== t && o.hits.length > 0) { const both = narrowed.filter(p => o.hits.includes(p)); if (both.length > 0) narrowed = both }
      if (narrowed.length === 1) return { ok: true, pr: narrowed[0]!, via: named(`${t.via} + ${hitsByTier.find(o => o !== t && o.hits.includes(narrowed[0]!))?.via ?? 'another tier'}`, narrowed[0]!) }
      return { ok: false, ambiguous: true, candidates: narrowed, reason: `ambiguous: ${narrowed.length} merged PRs prove this piece (${narrowed.map(h => `#${h.number}`).join(', ')}) — not proven` }
    }
  }
  // A PR carrying an EARLIER commit of this delivery: it probably shipped a previous round, so the person decides.
  const earlier = merged.filter(p => carries(p, fullShas, heads)).sort((a, b) => (mergedMs(b) ?? 0) - (mergedMs(a) ?? 0))[0]
  const suggestion = earlier ? { pr: earlier, via: 'an earlier commit of this delivery is in this PR; the last one it declared is not' } : suggestBatchPr(merged, piece)
  return { ok: false, reason: 'no merged release PR proves this piece (declared commit, its branch or its PR number)', ...(suggestion ? { suggestion } : {}) }
}

/** PURE. The newest PR with WEAK evidence (the piece's id or the card's name in its text, or a declared branch named there). It moves nothing. */
function suggestBatchPr(merged: readonly BatchPr[], piece: PieceHints): BatchSuggestion | null {
  const code = titleCode(piece.title)
  const atOf = new Map((piece.heads ?? []).map(h => [h.branch, h.atMs]))
  const newest = [...merged].sort((a, b) => (mergedMs(b) ?? 0) - (mergedMs(a) ?? 0))
  for (const p of newest) {
    const text = `${p.title}\n${p.body}`
    if (linesNaming(text, l => l.includes(piece.subtaskId))) return { pr: p, via: `the PR's text names ${piece.subtaskId}` }
    const branch = piece.branches.find(b => {
      const at = atOf.get(b)
      if (at !== undefined && mergedMs(p) !== null && mergedMs(p)! < at - DECLARE_SKEW_MS) return false
      return linesNaming(text, l => textNamesBranch(l, b))
    })
    if (branch) return { pr: p, via: `the PR's text names the branch ${branch}` }
    if (code && textNamesCode(text, code)) return { pr: p, via: `the PR's text names ${code}` }
  }
  return null
}

/** What a sha or a PR number on this line was: the base, a comparison, a pin, a cause — not what the card delivered. */
const NOT_THE_DELIVERY = /\b(based on|baseado|base\b|sobre|on top of|em cima|de origin|origin\/|revert|compar|contra|repin|pinad|pin\b|fixa|rebase|merge-base|causad|caused|depois d[aeo]|depends? on|depende|anterior)/i
const BRANCH_TOKEN = '(?:fix|feat|perf|chore|refactor|docs|test|hotfix|release)/[\\w./-]*\\w'
const FILE_LIKE = /\.(md|ts|tsx|js|jsx|json|ya?ml|sh|css|html|py|txt|png)$/i
const SHA_TOKEN = '[0-9a-f]{7,40}'
const shaLike = (s: string) => /\d/.test(s)
const BRANCH_THEN_SHA = new RegExp(`(?<![\\w/.-])(${BRANCH_TOKEN})\`?\\s*(?:@|\\bat\\b|,?\\s*commit\\b|,?\\s*sha\\b)?\\s*\`?(${SHA_TOKEN})(?![\\w-])`, 'gi')
const SHA_THEN_BRANCH = new RegExp(`(?<![\\w-])(${SHA_TOKEN})\`?\\s+(?:pushed to|pushed on|no ramo|na branch|on branch|em)\\s+\`?(${BRANCH_TOKEN})`, 'gi')

export interface DeliveryHints { branches: string[]; shas: string[]; heads: DeclaredHead[]; prs: number[]; /** See `PieceHints.latest`. */ latest?: string[] }

/**
 * PURE. What ONE delivery statement declares. Only a branch WITH its commit is a declared branch (a file path, a branch somebody
 * was based on, or a branch merely mentioned has no commit beside it); a sha is taken only in full or beside its branch; ids
 * (`t-…`, `s-…`, session ids, flow keys) are never read as anything.
 */
export function hintsFromText(text: string, atMs?: number): DeliveryHints {
  const heads = new Map<string, DeclaredHead>()
  const shas = new Set<string>()
  const prs = new Set<number>()
  const add = (branch: string, sha: string, line: string, index: number) => {
    if (FILE_LIKE.test(branch) || !shaLike(sha)) return
    // Everything BEFORE the sha on its line: a base keyword counts however far it sits from it (a 30-character window let a far base through).
    if (NOT_THE_DELIVERY.test(line.slice(0, index))) return
    heads.set(branch, { branch, sha: sha.toLowerCase(), ...(atMs !== undefined ? { atMs } : {}) })
  }
  for (const line of text.split('\n')) {
    // A line that says the work was left out declares nothing, whatever else it names.
    if (LEFT_OUT.test(line)) continue
    for (const m of line.matchAll(BRANCH_THEN_SHA)) add(m[1]!, m[2]!, line, m.index)
    for (const m of line.matchAll(SHA_THEN_BRANCH)) add(m[2]!, m[1]!, line, m.index)
    for (const m of line.toLowerCase().matchAll(FULL_SHA)) if (!NOT_THE_DELIVERY.test(line.slice(0, m.index))) shas.add(m[0])
    if (!NOT_THE_DELIVERY.test(line)) {
      // Two different PR numbers on one line: which is the delivery's is a guess, so none is read.
      const numbers = new Set([...line.matchAll(/\bPR\s*(?:draft\s*)?#(\d+)/gi)].map(m => Number(m[1])))
      if (numbers.size === 1) for (const n of numbers) prs.add(n)
    }
  }
  return { branches: [...heads.keys()], shas: [...shas], heads: [...heads.values()], prs: [...prs] }
}

/** PURE. The delivery statements of a piece, oldest first, folded: the LAST statement of a branch is the commit it stood at. */
export function hintsFromHandbacks(handbacks: ReadonlyArray<{ body: string; atMs?: number }>): DeliveryHints {
  const heads = new Map<string, DeclaredHead>()
  const shas = new Set<string>()
  const prs = new Set<number>()
  let latest: string[] = []
  for (const h of handbacks) {
    const one = hintsFromText(h.body, h.atMs)
    for (const x of one.heads) heads.set(x.branch, x)
    for (const s of one.shas) shas.add(s)
    for (const n of one.prs) prs.add(n)
    const named = [...one.heads.map(x => x.sha), ...one.shas]
    if (named.length) latest = named
  }
  return { branches: [...heads.keys()], shas: [...shas], heads: [...heads.values()], prs: [...prs], ...(latest.length ? { latest } : {}) }
}

const json = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T } catch { return fallback } }

// ------------------------------------------------------------------------------------------------ the cache that survives

export interface RepoTags { list: string[] | null; shas: Map<string, string>; complete: boolean; at: number }
/** Everything gh answered, kept across runs and restarts. Immutable facts have no expiry; lists are refreshed after PROOF_REFRESH_MS. */
export interface ProofCache {
  nowMs: number
  prs: Map<string, { at: number; list: BatchPr[] }>
  commits: Map<string, { at: number; byPr: Map<number, string[]> }>
  pins: Map<string, string | null>
  tags: Map<string, RepoTags>
  contains: Map<string, boolean | null>
  localTags: Map<string, string | null>
  /** The release gate's verdict per tag: a green one for ever, any other for PROOF_REFRESH_MS. */
  verdicts: Map<string, { ok: boolean; at: number; verdict: unknown }>
  /** The last run's conclusion per piece: what the Live shows beside an old card, and what "All" must not archive. */
  outcomes: Map<string, PieceOutcome>
  /** Repositories whose merged PRs gh could not list in THIS process, with nothing known from before: a read that did not happen. Never persisted. */
  unreadable: Set<string>
  /** WHY each unreadable repository could not be read (one line, no token): the entry says it instead of a bare "could not be read". Never persisted. */
  unreadableWhy: Map<string, string>
  /** The automatic run: when it may run again, and how the last one went. */
  auto: { nextAt: number; failures: number; last?: AutoRunReport }
}
/** Why a piece was NOT judged: "no proof" is only ever said of a piece that was actually looked up. */
export type UncheckedWhy = 'no-repos' | 'gh' | 'budget'
export interface PieceOutcome { proven?: boolean; suggestion?: { repo: string; pr: number; tag?: string; via: string }; /** The last run could not look this piece up: it is neither proven nor "antiga". */ unchecked?: UncheckedWhy }
export interface AutoRunReport { at: string; ms: number; gh: number; summary?: unknown; stopped?: string }

export const newProofCache = (nowMs = 0): ProofCache => ({ nowMs, prs: new Map(), commits: new Map(), pins: new Map(), tags: new Map(), contains: new Map(), localTags: new Map(), verdicts: new Map(), outcomes: new Map(), unreadable: new Set(), unreadableWhy: new Map(), auto: { nextAt: 0, failures: 0 } })

const PROOF_CACHE_VERSION = 1
/** PURE. The cache as a JSON document (only what is safe to believe later: an unknown answer is not kept). */
export function serializeProofCache(c: ProofCache): unknown {
  return {
    version: PROOF_CACHE_VERSION,
    prs: [...c.prs], commits: [...c.commits].map(([r, v]) => [r, { at: v.at, byPr: [...v.byPr] }]),
    pins: [...c.pins].filter(([, v]) => v !== null),
    tags: [...c.tags].map(([r, t]) => [r, { ...t, shas: [...t.shas] }]),
    contains: [...c.contains].filter(([k, v]) => v !== null && !k.startsWith('local:')),
    localTags: [...c.localTags].filter(([, v]) => v !== null),
    verdicts: [...c.verdicts], outcomes: [...c.outcomes], auto: c.auto,
  }
}
/** PURE. Back from JSON; anything unreadable is simply not known (a cold cache costs one run, never a wrong answer). */
export function hydrateProofCache(raw: unknown, nowMs: number): ProofCache {
  const c = newProofCache(nowMs)
  try {
    const d = raw as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!d || d.version !== PROOF_CACHE_VERSION) return c
    c.prs = new Map(d.prs)
    c.commits = new Map((d.commits as Array<[string, { at: number; byPr: Array<[number, string[]]> }]>).map(([r, v]) => [r, { at: v.at, byPr: new Map(v.byPr) }]))
    c.pins = new Map(d.pins)
    c.tags = new Map((d.tags as Array<[string, RepoTags & { shas: Array<[string, string]> }]>).map(([r, t]) => [r, { ...t, shas: new Map(t.shas) }]))
    c.contains = new Map(d.contains)
    c.localTags = new Map(d.localTags)
    c.verdicts = new Map(d.verdicts)
    c.outcomes = new Map(d.outcomes)
    if (d.auto && typeof d.auto.nextAt === 'number') c.auto = d.auto
  } catch { return newProofCache(nowMs) }
  return c
}

const fresh = (c: ProofCache, at: number) => c.nowMs - at < PROOF_REFRESH_MS

// ------------------------------------------------------------------------------------------------ the meter

/** The share of the 5000/h quota a run may spend: an automatic run must leave the person's own work room. */
export const AUTO_RUN_GH_BUDGET = 250
export const MANUAL_RUN_GH_BUDGET = 1500
const RATE_LIMITED = /rate limit|HTTP 429|abuse detection/i

export interface GhMeter { facts: GateFacts; calls(): number; stopped(): 'budget' | 'rate-limit' | null }
/** The facts with `gh` counted: over budget, or once GitHub says "rate limit", every further call fails at once. */
export function meterFacts(f: GateFacts, budget: number): GhMeter {
  let calls = 0
  let stop: 'budget' | 'rate-limit' | null = null
  return {
    calls: () => calls,
    stopped: () => stop,
    facts: {
      ...f,
      gh: async (cwd, args) => {
        if (stop) throw new Error(`gh skipped: ${stop}`)
        if (calls >= budget) { stop = 'budget'; throw new Error('gh skipped: budget') }
        calls++
        try { return await f.gh(cwd, args) } catch (e) {
          if (RATE_LIMITED.test(e instanceof Error ? e.message : String(e))) stop = 'rate-limit'
          throw e
        }
      },
    },
  }
}

// ------------------------------------------------------------------------------------------------ gh

const TAG_PAGES = 5

/** The release tags (`vN.N.N`) of a repository, newest first BY VERSION, with their commits (up to 500 tags). */
async function repoTags(f: GateFacts, cwd: string, repo: string, cache: ProofCache): Promise<RepoTags> {
  const hit = cache.tags.get(repo)
  if (hit?.list && fresh(cache, hit.at)) return hit
  const semver = (t: string) => t.slice(1).split('.').map(Number)
  const names: string[] = []
  const shas = new Map<string, string>()
  let complete = false
  let failed = false
  for (let page = 1; page <= TAG_PAGES; page++) {
    const raw = await f.gh(cwd, ['api', `repos/${repo}/tags?per_page=100&page=${page}`]).catch(() => { failed = true; return '[]' })
    const rows = json<Array<{ name?: string; commit?: { sha?: string } }>>(raw, [])
    const list = Array.isArray(rows) ? rows : []
    for (const t of list) if (t.name && RELEASE_TAG.test(t.name)) { names.push(t.name); if (t.commit?.sha) shas.set(t.name, t.commit.sha) }
    if (list.length < 100) { complete = !failed; break }
  }
  // A failed read keeps what was known; a stale list is better than none and its answers stay true (containment never changes).
  if (failed && hit?.list) return hit
  // The API's own order is not a version order.
  const out: RepoTags = { list: names.sort((a, b) => { const x = semver(a); const y = semver(b); return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!) }), shas, complete, at: failed ? 0 : cache.nowMs }
  cache.tags.set(repo, out)
  return out
}

/**
 * The FIRST release tag of a repository that contains a commit: containment is monotonic, so bisect the tags. The walk must END at
 * a tag that does not contain it (or at the end of a complete listing) — a walk that ran off a partial page proves nothing, so it
 * answers null. null also when nothing contains it yet.
 */
export async function findPublicTag(f: GateFacts, cwd: string, mergeSha: string, cache: ProofCache, repo: string = DEFAULT_RELEASE_REPO): Promise<string | null> {
  // LOCAL FIRST: `git tag --contains` answers from the checkout in milliseconds. Tags are created in order, so if the first
  // containing tag were missing locally every containing tag would be, and the list would be empty (→ the gh bisect below).
  const known = cache.localTags.get(mergeSha)
  if (known) return known
  const key = `local:${mergeSha}`
  if (!cache.contains.has(key)) {
    const out = await f.git(cwd, ['tag', '--contains', mergeSha, '--sort=version:refname']).catch(() => '')
    const first = out.split('\n').map(s => s.trim()).find(t => RELEASE_TAG.test(t)) ?? null
    cache.contains.set(key, first !== null)
    if (first) { cache.localTags.set(mergeSha, first); return first }
  }
  const tags = await repoTags(f, cwd, repo, cache)
  const list = tags.list ?? []
  const has = async (tag: string): Promise<boolean | null> => {
    const sha = tags.shas.get(tag)
    if (!sha) return null
    const k = `pub:${mergeSha}...${sha}`
    let v = cache.contains.get(k)
    if (v === undefined) {
      if (sha === mergeSha) v = true
      else {
        const st = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${repo}/compare/${mergeSha}...${sha}`, '--jq', '{status: .status}']).catch(() => '{}'), {}).status
        v = st ? st === 'ahead' || st === 'identical' : null
      }
      if (v !== null) cache.contains.set(k, v)
    }
    return v ?? null
  }
  const idx = await bisectFirst(list, has)
  // A listing that ran off a partial page proves nothing when even the oldest tag read still contains the commit.
  if (idx !== null && idx === list.length - 1 && !tags.complete) return null
  if (idx !== null) cache.localTags.set(mergeSha, list[idx]!)
  return idx === null ? null : list[idx]!
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

const COMMITS_QUERY = 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(states:MERGED,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number commits(first:250){nodes{commit{oid}}}}}}}'

interface CommitsPage { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: Array<{ number?: number; commits?: { nodes?: Array<{ commit?: { oid?: string } }> } }> }

/** gh's commit list per merged PR of a repository. A merged PR's commits never change, so only pages with PRs not read before are asked. */
async function loadPrCommits(f: GateFacts, cwd: string, repo: string, wanted: readonly number[], cache: ProofCache): Promise<Map<number, string[]>> {
  const slot = cache.commits.get(repo) ?? { at: 0, byPr: new Map<number, string[]>() }
  cache.commits.set(repo, slot)
  const [owner, name] = repo.split('/')
  if (!owner || !name || wanted.every(n => slot.byPr.has(n)) || fresh(cache, slot.at)) return slot.byPr
  let cursor: string | null = null
  let failed = false
  for (let page = 0; page < COMMIT_PAGES; page++) {
    const raw: string = await f.gh(cwd, ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, ...(cursor ? ['-F', `cursor=${cursor}`] : []), '-f', `query=${COMMITS_QUERY}`]).catch(() => { failed = true; return '{}' })
    const prs: CommitsPage | undefined = json<{ data?: { repository?: { pullRequests?: CommitsPage } } }>(raw, {}).data?.repository?.pullRequests
    if (!prs?.nodes) break
    let added = 0
    for (const n of prs.nodes) {
      if (typeof n.number !== 'number' || slot.byPr.has(n.number)) continue
      slot.byPr.set(n.number, (n.commits?.nodes ?? []).flatMap(c => (c.commit?.oid ? [c.commit.oid] : [])))
      added++
    }
    if (added === 0 || !prs.pageInfo?.hasNextPage || !prs.pageInfo.endCursor) break
    cursor = prs.pageInfo.endCursor
  }
  if (!failed) slot.at = cache.nowMs
  return slot.byPr
}

/** One line of a failure for a person to read: the first line, any GitHub token shape masked, bounded. */
export function oneLineReason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return (text.split('\n')[0] ?? '').replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '***').slice(0, 160)
}

/** Merged PRs of a repository (title, body, base, merge commit, commit list), newest first. Never throws: an unreadable source keeps what was known. */
export async function loadBatchPrs(f: GateFacts, cwd: string, repo: string, cache: ProofCache): Promise<BatchPr[]> {
  const hit = cache.prs.get(repo)
  if (hit && fresh(cache, hit.at)) return hit.list
  type Row = { number?: number; title?: string; body?: string; mergedAt?: string; headRefName?: string; headRefOid?: string; baseRefName?: string; mergeCommit?: { oid?: string } | null }
  let failed = false
  let why = ''
  const raw = json<Row[] | null>(await f.gh(cwd, ['pr', 'list', '-R', repo, '--state', 'merged', '--limit', String(BATCH_PR_LIMIT), '--json', 'number,title,body,mergedAt,headRefName,headRefOid,baseRefName,mergeCommit']).catch((e: unknown) => { failed = true; why = oneLineReason(e); return 'null' }), null)
  if (failed || !Array.isArray(raw)) { if (!hit) { cache.unreadable.add(repo); cache.unreadableWhy.set(repo, why || 'gh answered with something that is not a PR list') } return hit?.list ?? [] }
  cache.unreadable.delete(repo)
  cache.unreadableWhy.delete(repo)
  const rows = raw.flatMap((p): BatchPr[] => (typeof p.number === 'number' && p.mergeCommit?.oid
    ? [{ repo, number: p.number, title: p.title ?? '', body: p.body ?? '', mergeSha: p.mergeCommit.oid, ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}), ...(p.headRefName ? { headRefName: p.headRefName } : {}), ...(p.headRefOid ? { headRefOid: p.headRefOid } : {}), ...(p.baseRefName ? { baseRefName: p.baseRefName } : {}) }]
    : []))
  const byPr = await loadPrCommits(f, cwd, repo, rows.filter(p => isReleaseBase(p.baseRefName)).map(p => p.number), cache)
  const list = rows.map(p => { const commits = byPr.get(p.number); return commits ? { ...p, commits } : p })
  cache.prs.set(repo, { at: cache.nowMs, list })
  return list
}

/**
 * The FIRST public release tag whose `engine.pin` contains the engine commit (engine PRs have no tag of their own): bisect the
 * public tags. null = not released yet (or not readable). Pins and ancestry are immutable, so both are kept for good.
 */
export async function findEnginePinTag(f: GateFacts, cwd: string, engineSha: string, cache: ProofCache): Promise<string | null> {
  const memo = cache.localTags.get(engineSha)
  if (memo) return memo
  const tagList = (await repoTags(f, cwd, DEFAULT_RELEASE_REPO, cache)).list ?? []
  const pinOf = async (tag: string): Promise<string | null> => {
    const known = cache.pins.get(tag)
    if (known) return known
    const b64 = (await f.gh(cwd, ['api', `repos/${DEFAULT_RELEASE_REPO}/contents/engine.pin?ref=${tag}`, '--jq', '.content']).catch(() => '')).trim()
    let ref: string | null = null
    if (b64) { try { const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { ref?: unknown }; ref = typeof j.ref === 'string' && /^[0-9a-f]{7,40}$/i.test(j.ref) ? j.ref.toLowerCase() : null } catch { ref = null } }
    if (ref) cache.pins.set(tag, ref)
    return ref
  }
  const containsOf = async (pin: string): Promise<boolean | null> => {
    const key = `${engineSha}...${pin}`
    const v0 = cache.contains.get(key)
    if (v0 !== undefined && v0 !== null) return v0
    if (pin === engineSha.toLowerCase()) { cache.contains.set(key, true); return true }
    const st = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${ENGINE_REPO}/compare/${engineSha}...${pin}`, '--jq', '{status: .status}']).catch(() => '{}'), {}).status
    const v = st ? st === 'ahead' || st === 'identical' : null
    if (v !== null) cache.contains.set(key, v)
    return v
  }
  // A tag with no readable pin (before the engine existed) does not contain the commit.
  const idx = await bisectFirst(tagList.slice(0, ENGINE_TAG_WALK), async tag => { const pin = await pinOf(tag); return pin ? containsOf(pin) : false })
  if (idx !== null) cache.localTags.set(engineSha, tagList[idx]!)
  return idx === null ? null : tagList[idx]!
}
