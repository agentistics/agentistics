/**
 * agentUseDraft.ts — PURE. The account drawer's ONE draft of how agents use an account
 * (CONTAS.AGENDA-SALVAR): the two switches and the schedule are edited together and saved by the
 * drawer's single Save, in ONE `PATCH /api/accounts/:id`. This file builds that request, says in
 * words WHAT changed (the "Sair sem salvar?" list) and what the "Agora" line reads.
 *
 * The rule itself (`available = enabled && (override || schedule on)`) is `@agentistics/core`
 * `agentSchedule.ts`; the server is its only evaluator. Nothing here recomputes it: "Agora" reads
 * the server's verdict.
 */
import { AGENT_DAYS, dayWindowsText, defaultAgentSchedule, type AgentDay, type AgentSchedule } from '@agentistics/core'
import { agentUseReasonText, sameSchedule, type AgentUseView } from './agentScheduleView'

type Lang = 'pt' | 'en'

export interface AgentUseDraft {
  /** The "Agenda" master switch. */
  enabled: boolean
  /** "Sobrescrever a agenda". */
  override: boolean
  schedule: AgentSchedule
}

/** What an account row carries (`GET /api/accounts`). */
export interface AgentUseAccount { available: boolean; agentSchedule?: AgentSchedule; agentUse?: AgentUseView }

/** The drawer opens WITH what the server says; an account that never had a schedule starts from the default one. */
export function draftOf(a: AgentUseAccount): AgentUseDraft {
  return {
    enabled: a.agentUse?.enabled ?? a.available,
    override: a.agentUse?.override ?? false,
    schedule: { ...(a.agentSchedule ?? defaultAgentSchedule()), enabled: true },
  }
}

export const sameDraft = (a: AgentUseDraft, b: AgentUseDraft): boolean =>
  a.enabled === b.enabled && a.override === b.override && sameSchedule(a.schedule, b.schedule)

/**
 * The fields to send: only what changed. An edited schedule is sent ACTIVE — editing days and
 * hours is saying "follow these"; the account's own "Agenda" switch is the master, not the
 * schedule's `enabled` flag. `null` when nothing changed.
 */
export function agentUsePatch(saved: AgentUseDraft, draft: AgentUseDraft): { agentUseEnabled?: boolean; agentOverride?: boolean; agentSchedule?: AgentSchedule } | null {
  const patch: { agentUseEnabled?: boolean; agentOverride?: boolean; agentSchedule?: AgentSchedule } = {}
  if (draft.enabled !== saved.enabled) patch.agentUseEnabled = draft.enabled
  if (draft.override !== saved.override) patch.agentOverride = draft.override
  if (!sameSchedule(draft.schedule, saved.schedule)) patch.agentSchedule = { ...draft.schedule, enabled: true }
  return Object.keys(patch).length ? patch : null
}

const DAY_LONG: Record<AgentDay, { pt: string; en: string }> = {
  mon: { pt: 'Segunda', en: 'Monday' }, tue: { pt: 'Terça', en: 'Tuesday' }, wed: { pt: 'Quarta', en: 'Wednesday' },
  thu: { pt: 'Quinta', en: 'Thursday' }, fri: { pt: 'Sexta', en: 'Friday' }, sat: { pt: 'Sábado', en: 'Saturday' }, sun: { pt: 'Domingo', en: 'Sunday' },
}
const onOff = (v: boolean, lang: Lang) => lang === 'pt' ? (v ? 'ligado' : 'desligado') : (v ? 'on' : 'off')
const hoursOf = (s: AgentSchedule, d: AgentDay, lang: Lang) => { const day = s.days[d]; return day ? dayWindowsText(day, lang) || (lang === 'pt' ? 'sem janela' : 'no window') : '' }
const cap = (v: number | undefined, lang: Lang) => v === undefined ? (lang === 'pt' ? 'sem teto' : 'no ceiling') : `${v}%`

/** WHAT changed, in words — one line per fact, in the order the drawer shows them. Empty = nothing. */
export function agentUseChanges(saved: AgentUseDraft, draft: AgentUseDraft, lang: Lang): string[] {
  const out: string[] = []
  const pt = lang === 'pt'
  if (draft.enabled !== saved.enabled) out.push(`${pt ? 'Agenda' : 'Schedule'}: ${onOff(saved.enabled, lang)} → ${onOff(draft.enabled, lang)}`)
  if (draft.override !== saved.override) out.push(`${pt ? 'Sobrescrever a agenda' : 'Override the schedule'}: ${onOff(saved.override, lang)} → ${onOff(draft.override, lang)}`)
  for (const d of AGENT_DAYS) {
    const was = saved.schedule.days[d], now = draft.schedule.days[d]
    const name = DAY_LONG[d][lang]
    if (!was && now) out.push(pt ? `${name} entrou na agenda (${hoursOf(draft.schedule, d, lang)})` : `${name} joined the schedule (${hoursOf(draft.schedule, d, lang)})`)
    else if (was && !now) out.push(pt ? `${name} saiu da agenda` : `${name} left the schedule`)
    else if (was && now) {
      const a = hoursOf(saved.schedule, d, lang), b = hoursOf(draft.schedule, d, lang)
      if (a !== b) out.push(pt ? `${name}: ${a} → ${b}` : `${name}: ${a} → ${b}`)
      if (was.maxDailyPct !== now.maxDailyPct) out.push(pt ? `${name}, teto do dia: ${cap(was.maxDailyPct, lang)} → ${cap(now.maxDailyPct, lang)}` : `${name}, daily ceiling: ${cap(was.maxDailyPct, lang)} → ${cap(now.maxDailyPct, lang)}`)
    }
  }
  if (saved.schedule.maxWeeklyPct !== draft.schedule.maxWeeklyPct) {
    out.push(pt ? `Teto da semana: ${cap(saved.schedule.maxWeeklyPct, lang)} → ${cap(draft.schedule.maxWeeklyPct, lang)}` : `Weekly ceiling: ${cap(saved.schedule.maxWeeklyPct, lang)} → ${cap(draft.schedule.maxWeeklyPct, lang)}`)
  }
  return out
}

/** The "n alterações não salvas" footer note. */
export function unsavedCountText(n: number, lang: Lang): string {
  if (n <= 0) return ''
  return lang === 'pt' ? `${n} ${n > 1 ? 'alterações não salvas' : 'alteração não salva'}` : `${n} unsaved ${n > 1 ? 'changes' : 'change'}`
}

export type NowKind = 'ok' | 'free' | 'off'
/**
 * The "Agora" line for the state the switches are in. With the server's view in hand and the
 * switches unchanged it is the server's own reason; once a switch has moved in the draft the line
 * says what that switch does by itself, and falls back to "segue a agenda" where only the clock
 * could decide (the server answers on Save).
 */
export function agentUseNow(view: AgentUseView | undefined, draft: Pick<AgentUseDraft, 'enabled' | 'override'>, lang: Lang): { kind: NowKind; text: string } {
  const pt = lang === 'pt'
  if (!draft.enabled) return { kind: 'off', text: pt ? 'Agentes não usam esta conta' : 'Agents do not use this account' }
  if (draft.override) return { kind: 'free', text: pt ? 'Uso livre — agenda ignorada' : 'Free use — schedule ignored' }
  if (view && view.enabled === draft.enabled && (view.override ?? false) === draft.override) return { kind: view.on ? 'ok' : 'off', text: agentUseReasonText(view.reason, lang) }
  return { kind: 'ok', text: pt ? 'Segue a agenda' : 'Follows the schedule' }
}
