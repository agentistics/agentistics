/** Read-only, timestamped billing facts. Never open the journal's writer or run a backfill. */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { calcCost, hasModelPrice, type AgentisticsEvent, type HarnessId, type PlanLimits } from '@agentistics/core'
import { parseCodexRollout } from '../adapters/codex-parse'
import { AGENTISTICS_DATA_DIR, JOURNAL_PATH } from '../config'
import { durableWriteFile } from '../durable-write'
import { decodeRow, rowToEvent, type JournalRow, type StoredRow } from '../journal/journal-plan'
import { IMPORT_STORE_SOURCE_ID } from '../journal/import-store'
import { emptyCostCell, foldCostResponse, priceCell, pricingModelOf } from '../projections/kit'
import { accountAtPath, resolveLiveTranscriptPath } from '../plan-limits'
import { resolveSessionAccount } from './session-account'
import { canonicalAccountId, type AccountsFile } from '../harness-accounts'
import type { ManagedSession } from './types'
import type { IntegrationRegistry } from '@agentistics/engine-api'
import type { HandoffQuotaRate } from './handoff-panel'
import { claudeBilledReplies, geminiBilledReplies, nativeQuotaSources, nativeQuotaHarnesses, type NativeQuotaRoots } from './handoff-artifacts'

export interface BilledReply { harness: HarnessId; conversationId: string; account?: string; at: number; costUSD: number | null; model?: string }
export const replyKey = (harness: string, id: string) => `${harness}:${id}`
export function accountForReply(harness: HarnessId, conversationId: string, path: string | undefined,
  accounts: AccountsFile, managed: readonly ManagedSession[], limits: readonly PlanLimits[]): string | undefined {
  const retired = new Set(accounts.accounts.filter(a => a.retired).map(a => a.id))
  // A registered transcript root records its source login, even after a session switches.
  // The default-home login is only a fallback and must not override a managed binding.
  const { [`${harness}:`]: _default, ...roots } = accounts.bindings
  const source = path?.replace(/:\d+$/, '')
  const resolved = resolveSessionAccount(managed, { conversationId }, accounts)
  const at = (source ? accountAtPath(harness, source, roots, retired) : undefined) ?? resolved
    ?? (source ? accountAtPath(harness, source, accounts.bindings, retired) : undefined)
  return at ? canonicalAccountId(accounts, at) : undefined
}

/** A managed binding is authoritative, including an alias of an account merged later. */
export function handoffSessionLimit(harness: HarnessId, session: Pick<ManagedSession, 'accountId'> & Partial<Pick<ManagedSession, 'id' | 'conversationId'>>,
  accounts: AccountsFile, limits: readonly PlanLimits[]): PlanLimits | undefined {
  const mine = limits.filter(l => l.harness === harness)
  if (!session.id && !session.conversationId && !session.accountId) return undefined
  const rowId = session.id ?? session.conversationId ?? 'handoff'
  const id = resolveSessionAccount([{
    id: rowId,
    harness,
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
  }], { id: rowId, ...(session.conversationId ? { conversationId: session.conversationId } : {}) }, accounts)
  return id ? mine.find(l => canonicalAccountId(accounts, l.account) === canonicalAccountId(accounts, id)) : undefined
}

/** Includes closed/unmanaged conversations; coarse lifetime imports cannot supply window spend. */
export async function readBilledReplies(accounts: AccountsFile, managed: readonly ManagedSession[], limits: readonly PlanLimits[], path = JOURNAL_PATH): Promise<BilledReply[]> {
  if (!existsSync(path)) return []
  const { Database } = await import('bun:sqlite')
  const db = new Database(path, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    const strings = new Map<number, string>()
    const lookup = (id: number) => {
      if (!strings.has(id)) strings.set(id, (db.query('SELECT s FROM event_strings WHERE id = ?').get(id) as { s: string }).s)
      return strings.get(id)!
    }
    const key = (s: string) => version >= 2 ? (db.query('SELECT id FROM event_strings WHERE s = ?').get(s) as { id: number } | null)?.id : s
    const event = (r: unknown) => rowToEvent(version >= 2 ? decodeRow(r as StoredRow, lookup) : r as JournalRow)
    let walked = 0
    const yieldOccasionally = async () => { if (++walked % 250 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0)) }
    const runs = new Map<string, { harness: HarnessId; conversationId: string }>()
    const started = key('run.started')
    if (started !== undefined) for (const row of db.query('SELECT * FROM events WHERE type = ?').iterate(started)) {
      await yieldOccasionally()
      const e = event(row) as AgentisticsEvent<'run.started'>
      if (e.runId && e.data.conversationId) runs.set(e.runId, { harness: e.data.harness as HarnessId, conversationId: e.data.conversationId })
    }
    const replies: BilledReply[] = []
    const attribution = new Map<string, string | undefined>()
    const since = Math.min(Date.now(), ...limits.flatMap(l => l.windows.map(w => w.resetsAt - (w.kind === '5h' ? 5 * 3600_000 : 7 * 24 * 3600_000))))
    const completed = key('model.completed')
    if (completed !== undefined) for (const row of db.query('SELECT * FROM events WHERE type = ? AND occurred_at >= ?').iterate(completed, version >= 2 ? since : new Date(since).toISOString())) {
      await yieldOccasionally()
      const e = event(row) as AgentisticsEvent<'model.completed'>
      if (e.source.id === IMPORT_STORE_SOURCE_ID || e.data.replayed) continue
      const run = e.runId ? runs.get(e.runId) : undefined
      if (!run) continue
      const cell = emptyCostCell()
      foldCostResponse(cell, e)
      const attributionKey = replyKey(run.harness, run.conversationId) + ':' + (e.provenance.sourceRef ?? '').replace(/:\d+$/, '')
      if (!attribution.has(attributionKey)) attribution.set(attributionKey, accountForReply(run.harness, run.conversationId, e.provenance.sourceRef, accounts, managed, limits))
      replies.push({ ...run, account: attribution.get(attributionKey),
        at: Date.parse(e.occurredAt), model: pricingModelOf(e), costUSD: priceCell(cell, pricingModelOf(e)).costUSD })
    }
    return replies
  } finally { db.close() }
}

export function windowQuotaRate(limit: PlanLimits, replies: readonly BilledReply[], now: number): HandoffQuotaRate {
  const rate = (kind: '5h' | 'week', length: number) => {
    const meter = limit.windows.find(w => w.kind === kind)
    if (!meter || !Number.isFinite(meter.resetsAt) || meter.usedPct <= 0 || meter.resetsAt <= now) return null
    // Spend stops at the reading, rather than diluting yesterday's meter with today's calls.
    const rows = replies.filter(r => r.harness === limit.harness && r.account === limit.account
      && r.at >= meter.resetsAt - length && r.at <= Math.min(now, limit.updatedAt))
    if (rows.some(r => r.costUSD === null)) return null
    const usd = rows.reduce((sum, r) => sum + (r.costUSD ?? 0), 0)
    return usd > 0 ? meter.usedPct / usd : null
  }
  return { fiveHourPctPerUSD: rate('5h', 5 * 3600_000), weekPctPerUSD: rate('week', 7 * 24 * 3600_000) }
}

/** Last useful account/window calibration survives renewal and process restarts. */
export function retainedQuotaRate(current: HandoffQuotaRate, previous?: HandoffQuotaRate): HandoffQuotaRate {
  const good = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
  return { fiveHourPctPerUSD: good(current.fiveHourPctPerUSD) ?? good(previous?.fiveHourPctPerUSD),
    weekPctPerUSD: good(current.weekPctPerUSD) ?? good(previous?.weekPctPerUSD) }
}
/** Refresh sources that can overlap a current window, replacing their journal copy wholesale.
 * Native parsers or replay supply deduplicated usage, model identities and timestamps.
 */
const artifactMemo = new Map<string, { stamp: string; replies: BilledReply[]; calls?: number }>()
export const artifactReplyCounts = new Map<string, number>()
export async function refreshArtifactReplies(existing: readonly BilledReply[], integrations: IntegrationRegistry<AgentisticsEvent>,
  accounts: AccountsFile, managed: readonly ManagedSession[], limits: readonly PlanLimits[], now = Date.now(), roots?: NativeQuotaRoots): Promise<BilledReply[]> {
  const replaced = new Set<string>()
  const fresh: BilledReply[] = []
  const nativeSources = await nativeQuotaSources(accounts, limits, roots)
  const activePaths = new Set(nativeSources.map(s => s.path))
  for (const path of artifactMemo.keys()) if (path.startsWith('/') && !activePaths.has(path)) artifactMemo.delete(path)
  for (const source of nativeSources) {
    let cached = artifactMemo.get(source.path)
    if (!cached || cached.stamp !== source.stamp) {
      const content = await Promise.all(source.paths.map(path => readFile(path, 'utf8'))).then(parts => parts.join('\n')).catch(() => null)
      if (content === null) continue
      const codex = source.harness === 'codex' ? codexBilledReplies(content, source.conversationId) : undefined
      cached = { stamp: source.stamp, calls: codex?.calls, replies: codex?.replies
        ?? (source.harness === 'claude' ? claudeBilledReplies(content, source.conversationId) : geminiBilledReplies(content, source.conversationId)) }
      artifactMemo.set(source.path, cached)
    }
    const key = replyKey(source.harness, source.conversationId)
    const account = accountForReply(source.harness, source.conversationId, source.path, accounts, managed, limits)
    if (cached.calls !== undefined) artifactReplyCounts.set(key, cached.calls)
    replaced.add(key)
    for (const reply of cached.replies) replaced.add(replyKey(reply.harness, reply.conversationId))
    fresh.push(...cached.replies.map(r => ({ ...r, account })))
  }
  for (const [harness, integration] of Object.entries(integrations)) {
    if ((nativeQuotaHarnesses as readonly string[]).includes(harness)) continue
    const replay = integration?.replay
    const meters = limits.filter(l => l.harness === harness)
    if (!replay || !meters.length) continue
    const starts = meters.flatMap(l => l.windows.map(w => w.resetsAt - (w.kind === '5h' ? 5 * 3600_000 : 7 * 24 * 3600_000)))
    const since = Math.min(now, ...starts)
    for (const source of await replay.discover()) {
      const path = await resolveLiveTranscriptPath({ harness, session_id: source.sessionId }, accounts.bindings)
      const info = path ? await stat(path).catch(() => null) : null
      if (!info || info.mtimeMs < since) continue
      const key = replyKey(harness, source.sessionId)
      const stamp = `${info.size}:${info.mtimeMs}`
      let cached = artifactMemo.get(key)
      if (!cached || cached.stamp !== stamp) {
        const result = await replay.replay(source, null)
        const replies: BilledReply[] = []
        for (const e of result.events) {
          if (e.type !== 'model.completed') continue
          const completed = e as AgentisticsEvent<'model.completed'>
          if (completed.data.replayed) continue
          const cell = emptyCostCell()
          foldCostResponse(cell, completed)
          replies.push({ harness: harness as HarnessId, conversationId: source.sessionId,
            at: Date.parse(e.occurredAt), costUSD: priceCell(cell, pricingModelOf(completed)).costUSD })
        }
        cached = { stamp, replies }
        artifactMemo.set(key, cached)
      }
      if (cached.calls !== undefined) artifactReplyCounts.set(key, cached.calls)
      // Re-evaluate attribution when bindings change; never cache an account on a conversation.
      const account = accountForReply(harness as HarnessId, source.sessionId, path ?? undefined, accounts, managed, limits)
      replaced.add(key)
      fresh.push(...cached.replies.map(r => ({ ...r, account })))
    }
  }
  return [...existing.filter(r => !replaced.has(replyKey(r.harness, r.conversationId))), ...fresh]
}

/** The live Codex turn has not closed yet, so replay holds its model.completed.
 * Price each recorded cumulative-usage increment at its own timestamp instead.
 * token_usage_record is a mirror: only token_count is the adapter's authoritative counter.
 */
export function codexBilledReplies(content: string, conversationId: string): { replies: BilledReply[]; calls: number } {
  const replies: BilledReply[] = []
  let model = '', previous = { input: 0, cached: 0, output: 0 }
  for (const line of content.split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const data = e.payload ?? e
    const type = e.type === 'event_msg' || e.type === 'response_item' ? data.type : e.type
    if (type === 'turn_context' && typeof data.model === 'string') model = data.model
    if (type !== 'token_count') continue
    const u = data.info?.total_token_usage ?? data.total_token_usage
    if (!u) continue
    const current = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0 }
    if (current.input < previous.input || current.cached < previous.cached || current.output < previous.output) previous = { input: 0, cached: 0, output: 0 }
    const input = current.input - previous.input, cached = current.cached - previous.cached, output = current.output - previous.output
    previous = current
    if (input === 0 && cached === 0 && output === 0) continue
    const costUSD = hasModelPrice(model) ? calcCost({ inputTokens: Math.max(0, input - cached), cacheReadInputTokens: cached,
      outputTokens: output, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }, model) : null
    replies.push({ harness: 'codex', conversationId, at: Date.parse(e.timestamp), model, costUSD })
  }
  return { replies, calls: parseCodexRollout(content, conversationId)?.assistant_message_count ?? 0 }
}

const RATE_PATH = join(AGENTISTICS_DATA_DIR, 'handoff-quota-rates.json')
export async function readQuotaRates(path = RATE_PATH): Promise<Record<string, HandoffQuotaRate>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, retainedQuotaRate(v as HandoffQuotaRate)]))
  } catch { return {} }
}
export async function saveQuotaRates(rates: Record<string, HandoffQuotaRate>): Promise<void> {
  await durableWriteFile(RATE_PATH, JSON.stringify(rates))
}
export function countBilledReplies(replies: readonly BilledReply[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of replies) { const k = replyKey(r.harness, r.conversationId); counts.set(k, (counts.get(k) ?? 0) + 1) }
  return counts
}
