/** Shared, additive web cleanup protocol. Byte counts are allocated disk bytes. */
export type CleanKind = 'remove' | 'node-modules' | 'prune' | 'keep'
export interface CleanWebItem {
  id: string; repo: string; project: string; path: string; name: string
  kind: CleanKind; bytes: number; reason: string; lastActivityMs: number | null
}
export interface CleanScanLog { at: number; state: 'queued' | 'running' | 'done'; name: string; bytes?: number }
export interface CleanScanState {
  id: string; state: 'scanning' | 'ready' | 'cancelled' | 'error'
  step: 1 | 2 | 3; label: 'discovering' | 'measuring' | 'preparing'
  /** Fraction in [0, 1], retained for existing plan clients. */
  progress: number; etaMs: number | null; startedAt: number; elapsedMs: number
  foundBytes: number; itemCount: number; projectCount: number; projectTotal: number
  log: CleanScanLog[]; background: boolean; error?: string
}
export interface CleanWebPlan {
  items: CleanWebItem[]; reclaimable: { bytes: number; count: number }
  scannedAt: number; elapsedMs: number; scanId: string
}
export interface CleanResult {
  /** worktrees retains the legacy remove + prune count. */
  freedBytes: number; worktrees: number; removedWorktrees: number; nodeModules: number; pruned: number
  skipped: Array<{ path: string; reason: string }>; errors: string[]
  elapsedMs: number; diskFreeBefore: number | null; diskFreeAfter: number | null
  removed: Array<{ path: string; kind: CleanKind; bytes: number }>
}
export interface CleanJob {
  id: string; state: 'verifying' | 'removing worktrees' | 'removing node_modules' | 'pruning' | 'done'
  progress: number; result?: CleanResult
}
