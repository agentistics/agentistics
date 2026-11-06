/**
 * apiUsage — paid API keys and their balance, read from `GET /api/engine/x/api-usage` (served by the
 * engine when one is present). A community build, a 404 or an empty list means "no APIs": the popover
 * hides the section, the usage page says so in a sentence. Nothing is imported from the engine — this
 * file owns the wire shape it reads, and parses defensively (a malformed item is dropped, never drawn).
 *
 * The store polls lightly (60 s, only while something is subscribed) and never blocks a render: the
 * first answer lands whenever it lands, and a failed refresh keeps what is on screen.
 */
import { useSyncExternalStore } from 'react'
import { fmtWhen } from './planLimits'

export type ApiUsageStatus = 'ok' | 'no-key' | 'no-permission' | 'error'

export interface ApiUsageItem {
  id: string
  label: string
  status: ApiUsageStatus
  used?: number
  limit?: number
  unit: 'credits'
  /** Epoch ms. The wire may carry an ISO string or a number; both are read. */
  resetsAt?: number
  plan?: string
  detail?: string
}

const STATUSES: readonly ApiUsageStatus[] = ['ok', 'no-key', 'no-permission', 'error']
export const API_USAGE_URL = '/api/engine/x/api-usage'
export const API_USAGE_POLL_MS = 60_000

/** A tiny fixture shaped like the engine's answer: one item ok, one without permission. */
export const API_USAGE_FIXTURE: { items: unknown[] } = {
  items: [
    { id: 'provider-a', label: 'Provider A', status: 'ok', used: 640, limit: 1000, unit: 'credits', resetsAt: '2026-12-01T00:00:00Z', plan: 'Pay as you go' },
    { id: 'provider-b', label: 'Provider B', status: 'no-permission', unit: 'credits', detail: 'The key cannot read the balance.' },
  ],
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function instant(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t }
  return undefined
}

/** PURE. The items of an answer; anything malformed is left out, a non-object body yields none. */
export function parseApiUsage(body: unknown): ApiUsageItem[] {
  const raw = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(raw)) return []
  const out: ApiUsageItem[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    if (typeof r.id !== 'string' || !r.id || typeof r.label !== 'string' || !r.label) continue
    if (!STATUSES.includes(r.status as ApiUsageStatus)) continue
    const item: ApiUsageItem = { id: r.id, label: r.label, status: r.status as ApiUsageStatus, unit: 'credits' }
    const used = finite(r.used), limit = finite(r.limit), resetsAt = instant(r.resetsAt)
    if (used !== undefined) item.used = used
    if (limit !== undefined) item.limit = limit
    if (resetsAt !== undefined) item.resetsAt = resetsAt
    if (typeof r.plan === 'string' && r.plan) item.plan = r.plan
    if (typeof r.detail === 'string' && r.detail) item.detail = r.detail
    out.push(item)
  }
  return out
}

/** PURE. Used share, 0–100, or null when either half is missing (nothing observed is not nothing used). */
export function apiUsedPct(i: ApiUsageItem): number | null {
  if (i.status !== 'ok' || i.used === undefined || i.limit === undefined || i.limit <= 0) return null
  return Math.min(100, Math.max(0, (i.used / i.limit) * 100))
}

const nf = (lang: 'pt' | 'en') => new Intl.NumberFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { maximumFractionDigits: 0 })

/** PURE. The row's one line of words: balance and renewal for `ok`, the state otherwise. */
export function apiRowLine(i: ApiUsageItem, now: number, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  switch (i.status) {
    case 'no-key': return pt ? 'sem chave configurada' : 'no key configured'
    case 'no-permission': return pt ? 'a chave não tem permissão para ler o saldo' : 'the key cannot read the balance'
    case 'error': return pt ? 'não foi possível ler o saldo' : 'could not read the balance'
    case 'ok': {
      const left = i.used !== undefined && i.limit !== undefined ? Math.max(0, i.limit - i.used) : null
      const parts: string[] = []
      if (left !== null) parts.push(pt ? `restam ${nf(lang).format(left)} créditos` : `${nf(lang).format(left)} credits left`)
      else parts.push(pt ? 'saldo não informado' : 'balance not reported')
      if (i.resetsAt !== undefined) parts.push(`${pt ? 'renova' : 'renews'} ${fmtWhen(i.resetsAt, now, lang)}`)
      return parts.join(' · ')
    }
  }
}

export interface ApiUsageSnapshot { items: ApiUsageItem[] | null }
let snap: ApiUsageSnapshot = { items: null }
const listeners = new Set<() => void>()
let stop: (() => void) | null = null
const emit = (next: ApiUsageSnapshot) => { snap = next; for (const l of listeners) l() }

async function refresh(): Promise<void> {
  try {
    const r = await fetch(API_USAGE_URL, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    // 404 = community build / no engine route; any other refusal reads the same: no APIs to show.
    if (!r.ok) { emit({ items: [] }); return }
    emit({ items: parseApiUsage(await r.json()) })
  } catch {
    // A dropped connection keeps what is on screen; before the first answer there is simply nothing.
    if (snap.items === null) emit({ items: [] })
  }
}

function start(): () => void {
  void refresh()
  const t = setInterval(() => { void refresh() }, API_USAGE_POLL_MS)
  return () => clearInterval(t)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (listeners.size === 1) stop = start()
  return () => { listeners.delete(l); if (listeners.size === 0) { stop?.(); stop = null } }
}

/** `items` is null until the first answer, then the (possibly empty) list. */
export function useApiUsage(): ApiUsageSnapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap)
}

/** Tests / fixtures: put a list in place without the network. */
export function __setApiUsageForTest(items: ApiUsageItem[] | null): void { emit({ items }) }
