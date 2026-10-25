import { basename } from 'node:path'
import type { CleanScanState, CleanWebPlan } from '@agentistics/core'
import { type CleanItem } from './clean-plan'

export const CLEAN_LOG_LIMIT = 20
// Early per-repo timings are dominated by the first (often largest) repos and overestimate ~2x; wait for real progress.
export const CLEAN_ETA_MIN_FRACTION = 0.15
export function newCleanScan(id: string, now: number): CleanScanState {
  return { id, state: 'scanning', step: 1, label: 'discovering', progress: 0, etaMs: null,
    startedAt: now, elapsedMs: 0, foundBytes: 0, measuredBytes: 0, itemCount: 0, projectCount: 0, projectTotal: 0, log: [], background: false }
}
export function scanLog(state: CleanScanState, entry: CleanScanState['log'][number]): void {
  state.log = [...state.log, entry].slice(-CLEAN_LOG_LIMIT)
}
export function scanEstimate(state: CleanScanState, completed: number, total: number, now: number): void {
  state.elapsedMs = Math.max(0, now - state.startedAt)
  // Worktree totals arrive as each repo is discovered; never make the bar move backwards.
  const fraction = total > 0 ? completed / total : 0
  state.progress = Math.max(state.progress, Math.min(0.95, 0.05 + fraction * 0.9))
  state.etaMs = completed > 0 && total > completed && fraction >= CLEAN_ETA_MIN_FRACTION ? Math.round(state.elapsedMs / completed * (total - completed)) : null
}
export function wireCleanPlan(items: readonly CleanItem[], scan: Pick<CleanScanState, 'id' | 'startedAt'>, now: number, protectedPaths = new Map<string, string>()): CleanWebPlan {
  const rows = items.map(i => {
    const f = i.facts
    const protectedReason = protectedPaths.get(f.path)
    const kind = protectedReason ? 'keep' as const : i.action.kind
    const reason = protectedReason ?? (i.action.kind === 'keep' ? i.action.reason : i.action.kind === 'remove' ? 'merged and clean' : i.action.kind === 'prune' ? 'directory is gone' : 'no commit in 30+ days')
    return { id: `${f.repo}:${f.path}:${kind}`, repo: f.repo, project: basename(f.repo), path: f.path,
      name: basename(f.path) + (kind === 'node-modules' ? '/node_modules' : ''), kind,
      bytes: kind === 'keep' ? f.sizeBytes : i.action.kind === 'keep' ? 0 : i.action.frees,
      reason, lastActivityMs: f.lastActivityMs ?? f.lastCommitMs, ...(f.sizeUnknown ? { bytesUnknown: true } : {}) }
  })
  return { items: rows, reclaimable: rows.reduce((sum, i) => i.kind === 'keep' ? sum : { bytes: sum.bytes + i.bytes, count: sum.count + 1 }, { bytes: 0, count: 0 }),
    scannedAt: now, elapsedMs: Math.max(0, now - scan.startedAt), scanId: scan.id }
}
