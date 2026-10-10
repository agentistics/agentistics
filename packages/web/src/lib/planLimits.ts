/**
 * PLAN LIMITS — the browser's one copy of `GET /api/plan-limits`, shared by every surface that
 * draws it (the composer circle, the new-session cards, Nay's Limits tab), plus the words they all
 * use. The rules (forecast, renewal, most room) are core's `planLimits.ts`; this file only fetches,
 * follows the shared SSE stream (`event: plan-limits`, no poll of its own) and formats.
 */
import { useSyncExternalStore } from 'react'
import {
  currentUsedPct, forecastWindow, limitsStale, windowRenewed,
  type PlanForecast, type PlanLimitSource, type PlanLimitWindow, type PlanLimits, type PlanWindowKind,
} from '@agentistics/core'
import { subscribeEvent } from './eventStream'
import { HARNESS_LABELS } from './harness'

export interface PlanLimitsSnapshot {
  /** `null` until the first answer — never an empty list standing in for "not asked yet". */
  limits: PlanLimits[] | null
  /** Plans registered in Settings → Billing whose harness has reported no window yet. */
  registered: { harness: PlanLimits['harness']; plan: string }[]
  /** A clock that ticks once a minute while anything is subscribed, for "in X min" / "X min ago". */
  now: number
}

let snap: PlanLimitsSnapshot = { limits: null, registered: [], now: Date.now() }
const listeners = new Set<() => void>()
let stop: (() => void) | null = null

function emit(next: Partial<PlanLimitsSnapshot>): void {
  snap = { ...snap, ...next }
  for (const l of listeners) l()
}

async function refresh(): Promise<void> {
  try {
    const r = await fetch('/api/plan-limits', { cache: 'no-store' })
    if (!r.ok) return
    const body = await r.json() as { limits?: PlanLimits[]; registered?: PlanLimitsSnapshot['registered'] }
    emit({
      limits: Array.isArray(body.limits) ? body.limits : [],
      registered: Array.isArray(body.registered) ? body.registered : [],
      now: Date.now(),
    })
  } catch { /* keep what is on screen */ }
}

function start(): () => void {
  void refresh()
  const offChange = subscribeEvent('plan-limits', () => { void refresh() })
  const offConnected = subscribeEvent('connected', () => { void refresh() })
  const tick = setInterval(() => emit({ now: Date.now() }), 60_000)
  return () => { offChange(); offConnected(); clearInterval(tick) }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (listeners.size === 1) stop = start()
  return () => {
    listeners.delete(l)
    if (listeners.size === 0) { stop?.(); stop = null }
  }
}

export function usePlanLimits(): PlanLimitsSnapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap)
}

/** Tests / fixtures: put a snapshot in place without the network. */
export function __setPlanLimitsForTest(limits: PlanLimits[] | null, now = Date.now(), registered: PlanLimitsSnapshot['registered'] = []): void {
  emit({ limits, registered, now })
}

// ─── Words ────────────────────────────────────────────────────────────────────────────────────

type Lang = 'pt' | 'en'

export function windowLabel(kind: PlanWindowKind, lang: Lang): string {
  return kind === '5h' ? '5 h' : lang === 'pt' ? 'Semana' : 'Week'
}

export const SOURCE_LABEL: Record<PlanLimitSource, { pt: string; en: string }> = {
  'claude-stream': { pt: 'eventos do Claude Code', en: 'Claude Code events' },
  'codex-rollout': { pt: 'registro da sessão do Codex', en: 'Codex session log' },
  'codex-app-server': { pt: 'protocolo do Codex', en: 'Codex protocol' },
}

/** "12 min", "3 h 05", "2 d 4 h". */
export function fmtSpan(ms: number, lang: Lang): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, '0')}`
  return lang === 'pt' ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d ${h % 24} h`
}

/** "14:30" today, "sex 14:30" within a week, else a date. */
export function fmtWhen(ms: number, now: number, lang: Lang): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(lang === 'pt' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' })
  if (new Date(now).toDateString() === d.toDateString()) return time
  const day = d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', ms - now < 7 * 86_400_000 ? { weekday: 'short' } : { day: '2-digit', month: '2-digit' })
  return `${day.replace('.', '')} ${time}`
}

/** "renova 14:30 (em 2 h 10)" / "renovou" */
export function resetPhrase(w: PlanLimitWindow, now: number, lang: Lang): string {
  if (windowRenewed(w, now)) return lang === 'pt' ? 'renovado — sem leitura desde então' : 'renewed — no reading since'
  const pt = lang === 'pt'
  return pt
    ? `renova ${fmtWhen(w.resetsAt, now, lang)} (em ${fmtSpan(w.resetsAt - now, lang)})`
    : `resets ${fmtWhen(w.resetsAt, now, lang)} (in ${fmtSpan(w.resetsAt - now, lang)})`
}

export function forecastPhrase(f: PlanForecast, now: number, lang: Lang): string {
  const pt = lang === 'pt'
  switch (f.kind) {
    case 'renewed': return pt ? 'renovado' : 'renewed'
    case 'lasts': return pt ? 'dura até depois da renovação' : 'lasts past the renewal'
    case 'exhausted': return pt ? `esgotado até ${fmtWhen(f.until, now, lang)}` : `used up until ${fmtWhen(f.until, now, lang)}`
    case 'runs-out': return pt ? `acaba ~${fmtWhen(f.at, now, lang)}` : `runs out ~${fmtWhen(f.at, now, lang)}`
  }
}

/** "atualizado há 12 min" — said only when the record is stale (older than 10 min). */
export function stalePhrase(l: PlanLimits, now: number, lang: Lang): string | null {
  if (!limitsStale(l, now)) return null
  return lang === 'pt' ? `atualizado há ${fmtSpan(now - l.updatedAt, lang)}` : `updated ${fmtSpan(now - l.updatedAt, lang)} ago`
}

export function updatedPhrase(l: PlanLimits, now: number, lang: Lang): string {
  const ago = now - l.updatedAt
  if (ago < 60_000) return lang === 'pt' ? 'atualizado agora' : 'updated just now'
  return lang === 'pt' ? `atualizado há ${fmtSpan(ago, lang)}` : `updated ${fmtSpan(ago, lang)} ago`
}

/** One colour ramp for every limit surface: the notice thresholds (75 / 95). */
export function limitTone(pct: number): string {
  return pct >= 95 ? 'var(--accent-red)' : pct >= 75 ? 'var(--anthropic-orange)' : 'var(--accent-green)'
}

export { currentUsedPct, forecastWindow }

// ─── The threshold notice (bell, toast and the Nay card share these words) ──────────────────

export interface LimitNoticeMeta {
  harness: string
  window: PlanWindowKind
  threshold: number
  pct: number
  resetsAt: number
  alt?: string
}

/** Read a notification's `meta` back into a notice, or null when it is not one. */
export function limitNoticeMeta(meta: Record<string, unknown> | undefined): LimitNoticeMeta | null {
  if (!meta || typeof meta.harness !== 'string' || (meta.window !== '5h' && meta.window !== 'week')) return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const threshold = n(meta.threshold), pct = n(meta.pct), resetsAt = n(meta.resetsAt)
  if (threshold === null || pct === null || resetsAt === null) return null
  return { harness: meta.harness, window: meta.window, threshold, pct, resetsAt, ...(typeof meta.alt === 'string' ? { alt: meta.alt } : {}) }
}

const harnessName = (h: string): string => (HARNESS_LABELS as Record<string, string>)[h] ?? h

export function limitNoticeText(m: LimitNoticeMeta, lang: Lang, now = Date.now()): { title: string; message: string } {
  const pt = lang === 'pt'
  const name = harnessName(m.harness)
  const win = m.window === '5h' ? (pt ? 'janela de 5 h' : '5-hour window') : (pt ? 'janela semanal' : 'weekly window')
  const when = `${fmtWhen(m.resetsAt, now, lang)} (${pt ? 'em' : 'in'} ${fmtSpan(m.resetsAt - now, lang)})`
  if (m.threshold >= 100) {
    const alt = m.alt ? (pt ? ` Dá para continuar no ${harnessName(m.alt)}, que tem folga.` : ` You can continue in ${harnessName(m.alt)}, which has room.`) : ''
    return pt
      ? { title: `${name}: ${win} esgotada`, message: `O plano chegou a 100% da ${win}. Renova ${when}.${alt}` }
      : { title: `${name}: ${win} used up`, message: `The plan reached 100% of its ${win}. It resets ${when}.${alt}` }
  }
  return pt
    ? { title: `${name}: ${m.threshold}% da ${win}`, message: `Já foram ${Math.round(m.pct)}% da ${win} do plano. Renova ${when}.` }
    : { title: `${name}: ${m.threshold}% of the ${win}`, message: `${Math.round(m.pct)}% of the plan's ${win} is used. It resets ${when}.` }
}
