/**
 * clean-plan.ts — what `agentop clean` would free, decided from facts only (PERF.1 step 5). Pure.
 *
 * A worktree is REMOVED only when everything says it is done: not the repository's main checkout,
 * its HEAD already contained in the default branch (merged), no uncommitted change, not locked.
 * A worktree whose directory is gone is PRUNED (git's own bookkeeping). A worktree that is not merged
 * but has had no commit for `staleDays` keeps its work and loses only its `node_modules`, which an
 * install regenerates. Everything else is KEPT, with the reason said. Branches are never deleted.
 */
export interface WorktreeFacts {
  repo: string
  path: string
  branch: string | null
  isMain: boolean
  /** The directory no longer exists (git reports it prunable). */
  missing: boolean
  locked: boolean
  merged: boolean
  dirty: boolean
  /** Epoch ms of the last commit, null when unknown. */
  lastCommitMs: number | null
  sizeBytes: number
  nodeModulesBytes: number
}

export type CleanAction =
  | { kind: 'remove'; frees: number }
  | { kind: 'prune'; frees: 0 }
  | { kind: 'node-modules'; frees: number }
  | { kind: 'keep'; reason: 'main' | 'locked' | 'dirty' | 'active' | 'unmerged' }

export interface CleanItem { facts: WorktreeFacts; action: CleanAction }

export const STALE_DAYS = 30
const DAY = 86_400_000

export function planClean(all: readonly WorktreeFacts[], nowMs: number, staleDays = STALE_DAYS): CleanItem[] {
  return all.map(f => ({ facts: f, action: decide(f, nowMs, staleDays) }))
}

function decide(f: WorktreeFacts, now: number, staleDays: number): CleanAction {
  if (f.isMain) return { kind: 'keep', reason: 'main' }
  if (f.missing) return { kind: 'prune', frees: 0 }
  if (f.locked) return { kind: 'keep', reason: 'locked' }
  if (f.merged && !f.dirty) return { kind: 'remove', frees: f.sizeBytes }
  const stale = f.lastCommitMs !== null && now - f.lastCommitMs >= staleDays * DAY
  if (stale && f.nodeModulesBytes > 0) return { kind: 'node-modules', frees: f.nodeModulesBytes }
  if (f.dirty) return { kind: 'keep', reason: 'dirty' }
  return { kind: 'keep', reason: stale ? 'unmerged' : 'active' }
}

export function reclaimable(items: readonly CleanItem[]): { bytes: number; count: number } {
  let bytes = 0, count = 0
  for (const i of items) if (i.action.kind !== 'keep') { bytes += i.action.frees; count++ }
  return { bytes, count }
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.round(n / 1024)} KB`
}

const WORDS = {
  en: {
    remove: 'remove (merged, clean)', prune: 'prune (directory is gone)', 'node-modules': 'remove node_modules only (no commit in 30+ days, not merged)',
    main: 'keep: main checkout', locked: 'keep: locked', dirty: 'keep: uncommitted changes', active: 'keep: in use', unmerged: 'keep: not merged',
    total: (b: string, n: number) => `${n} item${n === 1 ? '' : 's'} would free ${b}.`,
    nothing: 'Nothing to clean: every worktree is in use or holds unmerged or uncommitted work.',
  },
  pt: {
    remove: 'remover (merged, limpo)', prune: 'podar (a pasta não existe mais)', 'node-modules': 'remover só node_modules (sem commit há 30+ dias, não merged)',
    main: 'manter: checkout principal', locked: 'manter: travado', dirty: 'manter: mudanças não commitadas', active: 'manter: em uso', unmerged: 'manter: não merged',
    total: (b: string, n: number) => `${n} ${n === 1 ? 'item liberaria' : 'itens liberariam'} ${b}.`,
    nothing: 'Nada a limpar: todo worktree está em uso ou guarda trabalho não merged ou não commitado.',
  },
} as const

/** The listing `agentop clean` prints: one line per worktree, grouped by repository, then the total. */
export function formatPlan(items: readonly CleanItem[], lang: 'en' | 'pt' = 'en', home = ''): string[] {
  const w = WORDS[lang]
  const short = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  const out: string[] = []
  let repo = ''
  for (const i of items) {
    if (i.facts.repo !== repo) { repo = i.facts.repo; out.push(short(repo)) }
    const a = i.action
    const label = a.kind === 'keep' ? w[a.reason] : w[a.kind]
    const size = a.kind === 'keep' ? fmtBytes(i.facts.sizeBytes) : fmtBytes(a.frees)
    out.push(`  ${a.kind === 'keep' ? ' ' : '•'} ${short(i.facts.path)}${i.facts.branch ? ` [${i.facts.branch}]` : ''}  ${size}  ${label}`)
  }
  const r = reclaimable(items)
  out.push(r.count > 0 ? w.total(fmtBytes(r.bytes), r.count) : w.nothing)
  return out
}
