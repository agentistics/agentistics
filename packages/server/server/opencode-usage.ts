/**
 * opencode-usage.ts — the OpenCode account's plan and its estimated use of the Go allowance.
 *
 * Plan: the person's own choice (`preferences.opencodePlan`) wins, because no local file tells Go from
 * Go Plus or Go Teams; without one, a credential under `opencode-go` reads as Go, one under `opencode`
 * as Zen, and nothing as none. Use: the `cost` OpenCode stamps on each assistant message of the
 * `opencode-go` provider, read from `opencode.db` (1.x tables) under `goUsage` — an ESTIMATE of what
 * the responses this machine saw counted, which the UI labels as such.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { opencodePaths } from './opencode-paths'
import { HOME_DIR } from './config'
import { opencodePlan, goUsage, goPlanLimits, GO_WINDOW_MS, type GoCostRow, type GoUsage, type OpencodePlanId } from '@agentistics/core'
import { join } from 'node:path'
import { readAuth, authDir, authDirCandidates } from './opencode-auth'
import { readPreferences, updatePreferences } from './preferences'
import { ingestFromRoot } from './plan-limits'
import { readGoLimit, type OpencodeLimit } from './sessions/opencode-limit'

const PLAN_IDS: readonly OpencodePlanId[] = ['go', 'go-plus', 'go-teams', 'zen', 'none']
export const isPlanId = (v: unknown): v is OpencodePlanId => typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v)

/** The plan, and whether it was chosen or inferred. */
export function resolvePlan(chosen: unknown, connected: readonly string[]): { plan: OpencodePlanId; chosen: boolean } {
  if (isPlanId(chosen)) return { plan: chosen, chosen: true }
  if (connected.includes('opencode-go')) return { plan: 'go', chosen: false }
  if (connected.includes('opencode')) return { plan: 'zen', chosen: false }
  return { plan: 'none', chosen: false }
}

/** The database OpenCode writes: the default location, or on macOS the Application Support one when only that holds it. */
export function opencodeDbPath(env: Readonly<Record<string, string | undefined>> = process.env, home: string = HOME_DIR, platform: string = process.platform): string {
  const main = opencodePaths(env, home).dbPath
  if (env.OPENCODE_DB || existsSync(main)) return main
  const alt = authDirCandidates(env, home, platform).map(d => join(d, 'opencode.db')).find(p => existsSync(p))
  return alt ?? main
}

interface MsgRow { data: string; time_created: number }

/** Priced responses of the Go provider in the last month, newest data included (WAL-aware, read-only). Null: the store cannot be read. */
export function readGoCostRows(dbPath: string, now: number): GoCostRow[] | null {
  if (!existsSync(dbPath)) return []
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const rows = db.query<MsgRow, [number]>(
      "SELECT data, time_created FROM message WHERE json_valid(data) AND json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.providerID') = 'opencode-go' AND time_created >= ?",
    ).all(now - GO_WINDOW_MS.month)
    const out: GoCostRow[] = []
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data) as { modelID?: unknown; cost?: unknown; time?: { created?: unknown } }
        if (typeof d.modelID !== 'string' || typeof d.cost !== 'number') continue
        out.push({ model: d.modelID, costUsd: d.cost, at: typeof d.time?.created === 'number' ? d.time.created : r.time_created })
      } catch { /* one unreadable message never hides the rest */ }
    }
    return out
  } catch { return null } finally { db?.close() }
}

export interface OpencodeUsageReply {
  plan: { id: OpencodePlanId; label: string; priceUsd: number | null; perMember: boolean; chosen: boolean }
  /** Null when the plan has no Go limits, or the store cannot be read (`reason`). */
  usage: GoUsage | null
  reason?: 'no-go-plan' | 'unreadable'
  /** The figures are what this machine saw; the allowance is the provider's. */
  estimated: true
  blocked?: OpencodeLimit
  now: number
}

export async function opencodeUsage(now: number = Date.now()): Promise<OpencodeUsageReply> {
  const prefs = await readPreferences()
  const connected = Object.keys(await readAuth(authDir()))
  const { plan, chosen } = resolvePlan(prefs.opencodePlan, connected)
  const p = opencodePlan(plan)
  const head = { id: plan, label: p.label, priceUsd: p.priceUsd, perMember: p.perMember === true, chosen }
  if (plan !== 'go' && plan !== 'go-plus' && plan !== 'go-teams') return { plan: head, usage: null, reason: 'no-go-plan', estimated: true, now }
  const rows = readGoCostRows(opencodeDbPath(), now)
  const blocked = readGoLimit(opencodeDbPath())
  if (rows === null) return { plan: head, usage: null, reason: 'unreadable', estimated: true, now, ...(blocked ? { blocked } : {}) }
  return { plan: head, usage: goUsage(rows, plan, now), estimated: true, now, ...(blocked ? { blocked } : {}) }
}

export async function setOpencodePlan(plan: unknown): Promise<boolean> {
  if (plan !== null && !isPlanId(plan)) return false
  await updatePreferences(() => ({ opencodePlan: plan === null ? undefined : plan }))
  return true
}

export const OPENCODE_USAGE_POLL_MS = 5 * 60_000

/**
 * Feed `agentistics_plan_limits` for harness opencode: now, then every five minutes. `AGENTISTICS_OPENCODE_USAGE=0`
 * turns it off. Local costs cannot measure the provider quota: publish an
 * unmeasured plan (including any observed refusal), never estimated routing windows. Returns the stop function.
 */
export function startOpencodeUsagePoll(): () => void {
  if (process.env.AGENTISTICS_OPENCODE_USAGE === '0') return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const tick = async (): Promise<void> => {
    try {
      const r = await opencodeUsage()
      const l = goPlanLimits(r.usage ?? goUsage([], r.plan.id, r.now), r.now)
      if (l) {
        if (r.blocked) l.unmeasuredReason = `${r.blocked.message}. On hold; reset unknown. Waiting for provider recovery.`
        await ingestFromRoot(l, null).catch(() => false)
      }
    } catch { /* a failed read keeps the held record, which ages into stale on its own */ }
    if (stopped) return
    timer = setTimeout(() => { void tick() }, OPENCODE_USAGE_POLL_MS)
    timer.unref?.()
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
