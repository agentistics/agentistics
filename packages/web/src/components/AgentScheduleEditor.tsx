/**
 * AgentScheduleEditor — WHEN agents may use an account (CONTAS.AGENDA-AGENTICA): weekdays, hour
 * windows per day and the usage ceilings. A CONTROLLED part of the account drawer
 * (CONTAS.AGENDA-SALVAR): it owns no draft, no Save and no master switch — the drawer holds ONE
 * draft (`lib/agentUseDraft.ts`), saves it with its single footer Save in ONE `PATCH
 * /api/accounts/:id`, and the "Agenda" / "Sobrescrever a agenda" switches live in
 * `AgentUseSwitches`. The popup ("Uso dos planos") never draws it.
 */
import { useState } from 'react'
import { AGENT_DAYS, type AgentDay, type AgentSchedule } from '@agentistics/core'
import { Plus, X } from 'lucide-react'
import {
  addWindow, agentUseReasonText, copyToSelected, DAY_SHORT, dailyUsageText, scheduleSummaryText, dayReadingHint, removeWindow, scheduleProblem,
  setAllDay, setDailyCap, setWeeklyCap, setWindow, toggleDay, weekReadingHint, type AgentUseView,
} from '../lib/agentScheduleView'

type Lang = 'pt' | 'en'
const TODAY_ID = (): AgentDay => (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date().getDay()]!

/** The state badge: why the account is on or off for agents right now. */
export function AgentUseBadge({ view, lang }: { view: AgentUseView; lang: Lang }) {
  const daily = dailyUsageText(view, lang)
  return <div data-agent-use-badge={view.reason} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11.5, minWidth: 0 }}>
    <span style={{ padding: '2px 8px', borderRadius: 99, fontWeight: 600, overflowWrap: 'anywhere',
      background: view.on ? 'color-mix(in srgb, var(--accent-green) 14%, transparent)' : 'var(--ag-tint-2)',
      color: view.on ? 'var(--accent-green)' : 'var(--text-secondary)' }}>{agentUseReasonText(view.reason, lang)}</span>
    {daily && <span data-agent-use-daily style={{ color: 'var(--text-tertiary)' }}>{daily}</span>}
  </div>
}

/** Soft, tinted field — never `--bg-base` (the black inputs the owner rejected). */
export const SCHEDULE_FIELD: React.CSSProperties = { background: 'var(--ag-tint-3)', border: '1px solid var(--ag-line, var(--border))', color: 'var(--text-primary)', borderRadius: 8, padding: '4px 8px', colorScheme: 'dark light', minWidth: 0, flex: '1 1 0', maxWidth: 140 }

export function AgentScheduleEditor({ draft, onChange, who, view, lang, isMobile = false, muted = false }: {
  /** The account's name as the screen shows it, for labels. */
  who: string
  draft: AgentSchedule
  onChange: (next: AgentSchedule) => void
  view?: AgentUseView
  lang: Lang
  isMobile?: boolean
  /** Agenda off, or override on: the schedule is kept but does not decide — drawn dimmed. */
  muted?: boolean
}) {
  const pt = lang === 'pt'
  const [focusDay, setFocusDay] = useState<AgentDay | null>(null)
  const problem = scheduleProblem(draft, lang)
  const tap = isMobile ? 44 : undefined
  const setDraft: React.Dispatch<React.SetStateAction<AgentSchedule>> = next => onChange(typeof next === 'function' ? next(draft) : next)
  const field: React.CSSProperties = { ...SCHEDULE_FIELD, minHeight: tap }
  const summary = scheduleSummaryText(draft, lang)

  return <div data-agent-schedule data-agent-schedule-who={who} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, opacity: muted ? 0.45 : 1 }}>
    {summary && <span data-agent-schedule-line style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{summary}</span>}
    <label data-agent-weekly-cap style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)' }}>
      {pt ? 'Parar os agentes quando a semana chegar a' : 'Stop agents when the week reaches'}
      <input type="number" inputMode="decimal" min={1} max={100} step={1} placeholder="—" aria-label={pt ? 'Teto da semana (% de uso semanal)' : 'Weekly ceiling (% of weekly usage)'}
        value={draft.maxWeeklyPct ?? ''} onChange={e => { const v = e.target.value.trim(); setDraft(s => setWeeklyCap(s, v === '' ? undefined : Number(v))) }}
        style={{ ...field, width: 64, flex: '0 0 auto' }} />
      %
      {weekReadingHint(view, lang) && <span data-agent-week-hint style={{ color: 'var(--text-tertiary)', fontSize: 11.5 }}>{weekReadingHint(view, lang)}</span>}
    </label>
    <AgentScheduleDays draft={draft} setDraft={setDraft} focusDay={focusDay} setFocusDay={setFocusDay} view={view} lang={lang} isMobile={isMobile} />
    {problem && <span role="alert" data-agent-schedule-problem style={{ fontSize: 12, color: 'var(--accent-red)' }}>{problem}</span>}
  </div>
}

/**
 * The weekday chips + the per-day hour windows ("Dia inteiro", copy to the selected days): the part of
 * the agent-use schedule that says WHEN. One component, drawn by the account editor above and by the
 * autonomous-mode dialog (`caps={false}` there: no usage-based ceilings, only days and hours).
 */
export function AgentScheduleDays({ draft, setDraft, focusDay, setFocusDay, view, lang, isMobile = false, caps = true, emptyHint }: {
  draft: AgentSchedule
  setDraft: React.Dispatch<React.SetStateAction<AgentSchedule>>
  focusDay: AgentDay | null
  setFocusDay: (d: AgentDay | null) => void
  view?: AgentUseView
  lang: Lang
  isMobile?: boolean
  /** The per-day "spend at most N% of the week" ceiling. Off where no usage is measured. */
  caps?: boolean
  emptyHint?: string
}) {
  const pt = lang === 'pt'
  const tap = isMobile ? 44 : undefined
  const small: React.CSSProperties = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 8, padding: '4px 9px', fontSize: 12, cursor: 'pointer', minHeight: tap, display: 'inline-flex', alignItems: 'center', gap: 4 }
  const time: React.CSSProperties = { ...SCHEDULE_FIELD, minHeight: tap }
  const selected = AGENT_DAYS.filter(d => draft.days[d])
  return <>
    <div role="group" aria-label={pt ? 'Dias da semana' : 'Weekdays'} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, opacity: draft.enabled ? 1 : 0.6 }}>
      {AGENT_DAYS.map(d => {
        const on = !!draft.days[d]
        return <button key={d} type="button" aria-pressed={on} data-agent-day={d}
          onClick={() => { setDraft(s => toggleDay(s, d, focusDay ?? selected[0])); setFocusDay(on ? null : d) }}
          style={{ minWidth: isMobile ? 44 : 40, minHeight: tap ?? 28, borderRadius: 99, padding: '3px 10px', fontSize: 12.5, cursor: 'pointer',
            border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--ag-line, var(--border))'}`, background: on ? 'var(--anthropic-orange-dim)' : 'transparent', color: on ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)', fontWeight: on ? 650 : 500 }}>
          {DAY_SHORT[d][lang]}
        </button>
      })}
    </div>
    {selected.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{emptyHint ?? (pt ? 'Nenhum dia marcado: com a agenda ligada, agentes não usam esta conta.' : 'No day selected: with the schedule on, agents never use this account.')}</span>}
    {selected.map(d => {
      const day = draft.days[d]!
      return <div key={d} data-agent-day-editor={d} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, opacity: draft.enabled ? 1 : 0.6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 12.5 }}>{DAY_SHORT[d][lang]}</b>
          <button type="button" aria-pressed={!!day.allDay} data-agent-allday={d} onClick={() => { setFocusDay(d); setDraft(s => setAllDay(s, d, !day.allDay)) }}
            style={{ ...small, borderRadius: 99, ...(day.allDay ? { border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)', fontWeight: 650 } : {}) }}>
            {pt ? 'Dia inteiro' : 'All day'}
          </button>
        </div>
        {!day.allDay && day.windows.map((w, i) => <div key={i} data-agent-window style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
          <input type="time" step={60} aria-label={`${DAY_SHORT[d][lang]} · ${pt ? 'início' : 'from'} ${i + 1}`} value={w.from} onChange={e => { setFocusDay(d); setDraft(s => setWindow(s, d, i, { from: e.target.value })) }} style={time} />
          <span style={{ color: 'var(--text-tertiary)' }}>–</span>
          <input type="time" step={60} aria-label={`${DAY_SHORT[d][lang]} · ${pt ? 'fim' : 'to'} ${i + 1}`} value={w.to} onChange={e => { setFocusDay(d); setDraft(s => setWindow(s, d, i, { to: e.target.value })) }} style={time} />
          <button type="button" aria-label={pt ? 'Remover janela' : 'Remove window'} onClick={() => setDraft(s => removeWindow(s, d, i))} style={{ ...small, padding: 4, minWidth: tap, flexShrink: 0 }}><X size={13} aria-hidden /></button>
        </div>
          {w.to <= w.from && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pt ? 'termina no dia seguinte' : 'ends the next day'}</span>}
        </div>)}
        {!day.allDay && day.windows.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{pt ? 'Sem janela: o dia fica desligado.' : 'No window: the day stays off.'}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!day.allDay && <button type="button" onClick={() => setDraft(s => addWindow(s, d))} style={small}><Plus size={13} aria-hidden />{pt ? 'janela' : 'window'}</button>}
          {caps && <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            {pt ? 'Gastar no máximo' : 'Spend at most'}
            <input type="number" inputMode="decimal" min={1} max={100} step={1} placeholder="—" aria-label={`${DAY_SHORT[d][lang]} · ${pt ? 'teto do dia (% da semana)' : 'daily ceiling (% of the week)'}`}
              value={day.maxDailyPct ?? ''} onChange={e => { const v = e.target.value.trim(); setDraft(s => setDailyCap(s, d, v === '' ? undefined : Number(v))) }}
              style={{ ...time, width: 64 }} />
            {pt ? '% da semana neste dia' : '% of the week on this day'}
          </label>}
          {d === TODAY_ID() && dayReadingHint(view, lang) && <span data-agent-day-hint style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{dayReadingHint(view, lang)}</span>}
          {selected.length > 1 && <button type="button" data-agent-copy={d} onClick={() => setDraft(s => copyToSelected(s, d))} style={small}>{pt ? 'Copiar para os dias marcados' : 'Copy to the selected days'}</button>}
        </div>
      </div>
    })}
  </>
}
