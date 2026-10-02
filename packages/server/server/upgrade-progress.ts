/**
 * upgrade-progress.ts — PURE: what an in-flight `agentop upgrade` says about itself, so the page
 * that started it can narrate REAL progress instead of a spinner.
 *
 * The upgrade runs DETACHED (see `upgrade-web.ts`): the server that spawned it cannot observe it,
 * and is in fact killed by it. So the child writes one small JSON file at every stage it really
 * reaches — `upgrade-progress.json` under the data dir — and `GET /api/upgrade/status` reads it
 * back. The file is a statement by the process doing the work, never an estimate: a stage absent
 * from it was not reached, and the download fraction is bytes received over the `content-length`
 * GitHub sent (absent when GitHub sent none, and then the page draws no percentage at all).
 *
 * The stage after `restarting` is not written here at all: once the service is bounced, the one
 * fact that matters is `/api/version` answering the target version, which the page polls itself.
 */

export const UPGRADE_STAGES = ['checking', 'downloading', 'verifying', 'swapping', 'restarting', 'done', 'failed'] as const
export type UpgradeStage = (typeof UPGRADE_STAGES)[number]

export interface UpgradeProgress {
  stage: UpgradeStage
  /** The version being installed; blank while still `checking`. */
  version: string
  /** Bytes received so far — only while `downloading`. */
  received?: number
  /** Total bytes, when the server sent a `content-length`. */
  total?: number
  /** Machine-readable failure cause — only on `failed`. Never shown verbatim (it can carry paths). */
  reason?: string
  /** Epoch ms of the write. */
  at: number
}

/** A record older than this describes an upgrade that is not running any more. */
export const PROGRESS_STALE_MS = 15 * 60_000

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Total: anything that is not a well-formed record reads as "no upgrade has said anything". */
export function parseUpgradeProgress(raw: string | null | undefined): UpgradeProgress | null {
  if (!raw) return null
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  if (typeof r.stage !== 'string' || !(UPGRADE_STAGES as readonly string[]).includes(r.stage)) return null
  if (typeof r.version !== 'string' || !isCount(r.at)) return null
  const out: UpgradeProgress = { stage: r.stage as UpgradeStage, version: r.version, at: r.at }
  if (isCount(r.received)) out.received = r.received
  if (isCount(r.total) && r.total > 0) out.total = r.total
  if (typeof r.reason === 'string' && r.stage === 'failed') out.reason = r.reason.slice(0, 200)
  return out
}

/**
 * What the status route answers. A stale record is `null` (an upgrade that died an hour ago is not
 * "in progress"), and `reason` is DROPPED: it is the CLI's own text and can name local paths, so
 * the page shows its own sentence for a failure rather than the child's.
 */
export function progressForWire(p: UpgradeProgress | null, now: number): Omit<UpgradeProgress, 'reason'> | null {
  if (!p) return null
  if (now - p.at > PROGRESS_STALE_MS || p.at - now > 60_000) return null
  const { reason: _drop, ...rest } = p
  return rest
}

/**
 * Throttle for the download stage: write when the fraction moved by at least 2 points or a quarter
 * second passed. A 140 MB body arrives in thousands of chunks; one write per chunk is thousands of
 * writes for a bar a person reads at a glance.
 */
export function shouldWriteDownload(last: { received: number; at: number } | null, received: number, total: number | undefined, now: number): boolean {
  if (!last) return true
  if (now - last.at >= 250) return true
  if (total && total > 0) return (received - last.received) / total >= 0.02
  return false
}
