/**
 * agentScheduleView.ts — PURE. The words and the draft edits of the per-account agent schedule
 * (CONTAS.AGENDA-AGENTICA). The rule itself is `@agentistics/core` `agentSchedule.ts`; the effective
 * state and its reason arrive from the server (`GET /api/accounts` → `agentUse`).
 */
import { AGENT_DAYS, type AgentDay, type AgentSchedule, type AgentUseReason, type AgentWindow } from '@agentistics/core'

type Lang = 'pt' | 'en'

/** What `GET /api/accounts` adds to an account with an active schedule. */
export interface AgentUseView { reason: AgentUseReason; on: boolean; dayUsedPct: number | null; maxDailyPct?: number }

export const DAY_SHORT: Record<AgentDay, { pt: string; en: string }> = {
  mon: { pt: 'seg', en: 'Mon' }, tue: { pt: 'ter', en: 'Tue' }, wed: { pt: 'qua', en: 'Wed' }, thu: { pt: 'qui', en: 'Thu' },
  fri: { pt: 'sex', en: 'Fri' }, sat: { pt: 'sáb', en: 'Sat' }, sun: { pt: 'dom', en: 'Sun' },
}

const REASON: Record<AgentUseReason, { pt: string; en: string }> = {
  'no-schedule': { pt: 'Sem agenda', en: 'No schedule' },
  'manual-on': { pt: 'Ligada à mão (vence a agenda)', en: 'Turned on by hand (overrides the schedule)' },
  'manual-off': { pt: 'Desligada à mão (vence a agenda)', en: 'Turned off by hand (overrides the schedule)' },
  'in-window': { pt: 'Ligada pela agenda', en: 'On by schedule' },
  'outside-window': { pt: 'Fora da agenda — desligada para agentes', en: 'Outside the schedule — off for agents' },
  'day-off': { pt: 'Dia fora da agenda — desligada para agentes', en: 'Day not scheduled — off for agents' },
  'daily-cap': { pt: 'Teto do dia atingido — desligada para agentes', en: 'Daily ceiling reached — off for agents' },
}

export function agentUseReasonText(reason: AgentUseReason, lang: Lang): string { return REASON[reason][lang] }

/** "today: 12% of 20% allowed" — null when there is no ceiling or nothing measurable. */
export function dailyUsageText(view: AgentUseView, lang: Lang): string | null {
  if (view.maxDailyPct === undefined) return null
  if (view.dayUsedPct === null) return lang === 'pt' ? `teto do dia: ${view.maxDailyPct}% (sem leitura semanal ainda)` : `daily ceiling: ${view.maxDailyPct}% (no weekly reading yet)`
  const used = Math.round(view.dayUsedPct * 10) / 10
  return lang === 'pt' ? `hoje: ${used}% de ${view.maxDailyPct}% permitido` : `today: ${used}% of ${view.maxDailyPct}% allowed`
}

const DEFAULT_WINDOW: AgentWindow = { from: '09:00', to: '18:00' }

export function toggleDay(s: AgentSchedule, day: AgentDay, template?: AgentDay): AgentSchedule {
  const days = { ...s.days }
  if (days[day]) delete days[day]
  else {
    const from = template && days[template]
    days[day] = from ? { windows: from.windows.map(w => ({ ...w })), ...(from.maxDailyPct !== undefined ? { maxDailyPct: from.maxDailyPct } : {}) } : { windows: [{ ...DEFAULT_WINDOW }] }
  }
  return { ...s, days }
}

export function setWindow(s: AgentSchedule, day: AgentDay, index: number, patch: Partial<AgentWindow>): AgentSchedule {
  const d = s.days[day]
  if (!d) return s
  return { ...s, days: { ...s.days, [day]: { ...d, windows: d.windows.map((w, i) => i === index ? { ...w, ...patch } : w) } } }
}

export function addWindow(s: AgentSchedule, day: AgentDay): AgentSchedule {
  const d = s.days[day]
  if (!d) return s
  const last = d.windows[d.windows.length - 1]
  const next: AgentWindow = last && last.to < '23:00' ? { from: last.to, to: '23:00' } : { ...DEFAULT_WINDOW }
  return { ...s, days: { ...s.days, [day]: { ...d, windows: [...d.windows, next] } } }
}

export function removeWindow(s: AgentSchedule, day: AgentDay, index: number): AgentSchedule {
  const d = s.days[day]
  if (!d) return s
  return { ...s, days: { ...s.days, [day]: { ...d, windows: d.windows.filter((_, i) => i !== index) } } }
}

export function setDailyCap(s: AgentSchedule, day: AgentDay, pct: number | undefined): AgentSchedule {
  const d = s.days[day]
  if (!d) return s
  const { maxDailyPct: _drop, ...rest } = d
  return { ...s, days: { ...s.days, [day]: pct === undefined ? rest : { ...rest, maxDailyPct: pct } } }
}

/** Copy one day's windows and ceiling to every other SELECTED day. */
export function copyToSelected(s: AgentSchedule, from: AgentDay): AgentSchedule {
  const src = s.days[from]
  if (!src) return s
  const days = { ...s.days }
  for (const d of AGENT_DAYS) if (d !== from && days[d]) days[d] = { windows: src.windows.map(w => ({ ...w })), ...(src.maxDailyPct !== undefined ? { maxDailyPct: src.maxDailyPct } : {}) }
  return { ...s, days }
}

/** Why the draft cannot be saved, in words; null when it can. */
export function scheduleProblem(s: AgentSchedule, lang: Lang): string | null {
  for (const d of AGENT_DAYS) {
    const day = s.days[d]
    if (!day) continue
    if (day.windows.some(w => !/^\d\d:\d\d$/.test(w.from) || !/^\d\d:\d\d$/.test(w.to))) return lang === 'pt' ? `${DAY_SHORT[d].pt}: horário incompleto` : `${DAY_SHORT[d].en}: incomplete time`
    if (day.windows.some(w => w.from === w.to)) return lang === 'pt' ? `${DAY_SHORT[d].pt}: uma janela começa e termina no mesmo horário` : `${DAY_SHORT[d].en}: a window starts and ends at the same time`
    if (day.maxDailyPct !== undefined && (!(day.maxDailyPct > 0) || day.maxDailyPct > 100)) return lang === 'pt' ? `${DAY_SHORT[d].pt}: teto entre 1 e 100%` : `${DAY_SHORT[d].en}: ceiling between 1 and 100%`
  }
  return null
}

export const sameSchedule = (a: AgentSchedule | undefined, b: AgentSchedule | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
