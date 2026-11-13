/**
 * orphan-review-notice.ts — a piece in leader review with NO live leader on its task for more than N hours is told ONCE.
 *
 * ENTREGA.GARANTIDA §1 names the gap ("Sem líder is a presentation stage with no consequence and no clock") and §3.7 the
 * 24 h clock; this is the READ side of it: the Live already knows which cards have no leader (`displayStage: 'no-leader'`),
 * and this turns "for more than N hours" into one notice per piece through the bell's own channel. It judges nothing and
 * moves nothing — a card is never closed by it; the notice carries the concrete action ("review and finish, or abandon").
 *
 *  - Pure planning (`planOrphanNotices`) over the Live deliveries + a ledger of what was already said.
 *  - The old pile (cards the Live already lists apart as `old`) is ONE summary notice, never a flood of one per piece.
 *  - The ledger is persisted (`orphan-notices.json`, atomic), so a restart never repeats a notice.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLiveState } from '@agentistics/core'
import type { NotificationInput } from '../notifications-store'

export const ORPHAN_HOURS_DEFAULT = 24
/** Individual notices per sweep; whatever is over goes into the summary, never dropped from the ledger. */
export const ORPHAN_INDIVIDUAL_CAP = 5

export interface OrphanCard {
  key: string; title: string; stage: string; stageSinceMs: number | null; old?: boolean
  leaderAvailability?: 'available' | 'absent' | 'unknown'
}

export interface OrphanPlan { notices: NotificationInput[]; mark: string[] }

/** The hours from `AGENTISTICS_ORPHAN_REVIEW_HOURS`; anything not a positive number is the default. */
export function orphanHours(env: string | undefined): number {
  const n = Number(env)
  return Number.isFinite(n) && n > 0 ? n : ORPHAN_HOURS_DEFAULT
}

/** PURE: is some leader in a LIVE state? A lost/ended leader reads no notice, so it goes to the user. */
export function leaderLiveOf(leaders: readonly { state?: string }[]): boolean {
  return leaders.some(l => isLiveState(l.state))
}

const ledgerKey = (key: string) => `${key}|leader`

/** PURE: which cards deserve a notice now, and which ledger keys that settles. `to` says who it is for. */
export function planOrphanNotices(o: {
  cards: readonly OrphanCard[]; nowMs: number; said: ReadonlySet<string>; hours?: number; leaderLive: boolean
}): OrphanPlan {
  const hours = o.hours ?? ORPHAN_HOURS_DEFAULT
  const to = o.leaderLive ? 'leader' : 'user'
  const due = o.cards.filter(c =>
    c.stage === 'leader' && c.leaderAvailability === 'absent' && c.stageSinceMs !== null
    && o.nowMs - c.stageSinceMs > hours * 3600_000 && !o.said.has(ledgerKey(c.key)))
  const fresh = due.filter(c => !c.old)
  const old = due.filter(c => c.old)
  const single = fresh.slice(0, ORPHAN_INDIVIDUAL_CAP)
  const rest = [...fresh.slice(ORPHAN_INDIVIDUAL_CAP), ...old]
  const notices: NotificationInput[] = single.map(c => ({
    type: 'warning', code: 'delivery.orphan-review',
    meta: { title: c.title, hours, to, action: 'review-or-abandon', key: c.key },
  }))
  if (rest.length > 0) notices.push({ type: 'warning', code: 'delivery.orphan-review-many', meta: { count: rest.length, hours, to, action: 'review-or-abandon' } })
  return { notices, mark: due.map(c => ledgerKey(c.key)) }
}

// ---------------------------------------------------------------------------------------------- the ledger (IO)

export function readLedger(path: string): Set<string> {
  try {
    if (!existsSync(path)) return new Set()
    const v = JSON.parse(readFileSync(path, 'utf8')) as { said?: unknown }
    return new Set(Array.isArray(v.said) ? v.said.filter((x): x is string => typeof x === 'string') : [])
  } catch { return new Set() }
}

export function writeLedger(path: string, said: ReadonlySet<string>): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ said: [...said] }), { mode: 0o600 })
  renameSync(tmp, path)
}

let sweeping = false

/**
 * Sweep once: plan, deliver through the bell, THEN record in the ledger (a failed delivery is tried again next time,
 * a delivered one is never repeated). Single flight per process; never throws into the caller's read path.
 */
export async function sweepOrphanReviews(o: {
  cards: readonly OrphanCard[]; nowMs: number; dataDir: string; leaderLive: boolean; hours?: number
  deliver?: (n: NotificationInput) => Promise<unknown>
}): Promise<OrphanPlan | null> {
  if (sweeping) return null
  sweeping = true
  try {
    const path = join(o.dataDir, 'orphan-notices.json')
    const said = readLedger(path)
    const plan = planOrphanNotices({ cards: o.cards, nowMs: o.nowMs, said, leaderLive: o.leaderLive, ...(o.hours !== undefined ? { hours: o.hours } : {}) })
    if (plan.mark.length === 0) return plan
    const deliver = o.deliver ?? (async n => (await import('../notifications-store')).addStoredNotification(n))
    for (const n of plan.notices) await deliver(n)
    for (const k of plan.mark) said.add(k)
    writeLedger(path, said)
    return plan
  } catch { return null } finally { sweeping = false }
}
