/**
 * AgentScheduleEditor — when an account may be used by AGENTS (CONTAS.AGENDA-AGENTICA): weekdays,
 * hour windows per day and a daily ceiling. ONE component, drawn in the plan-usage modal (Nay's
 * Limits tab, `manageAgentUse`) and in Settings → Accounts (the account drawer), both writing the
 * same server record (`PATCH /api/accounts/:id {agentSchedule}`). The popup ("Uso dos planos") never
 * draws it: there, only the on/off switch and "Sign in again".
 */
import { useEffect, useRef, useState } from 'react'
import { AGENT_DAYS, defaultAgentSchedule, type AgentDay, type AgentSchedule } from '@agentistics/core'
import { Plus, X } from 'lucide-react'
import { ToggleSwitch } from './ToggleSwitch'
import { dialogButtonStyle } from '../pages/settings/primitives'
import {
  addWindow, agentUseReasonText, copyToSelected, DAY_SHORT, dailyUsageText, scheduleSummaryText, dayReadingHint, removeWindow, sameSchedule, scheduleProblem,
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

export function AgentScheduleEditor({ accountId, who, schedule, view, lang, isMobile = false, onSaved, showBadge = true }: {
  /** The plan-usage card already shows the badge right above; drawing it twice is noise. */
  showBadge?: boolean
  accountId: string
  /** The account's name as the screen shows it, for labels. */
  who: string
  schedule?: AgentSchedule
  view?: AgentUseView
  lang: Lang
  isMobile?: boolean
  /** The server's answer after a save (the account with its new `available`/`agentUse`). */
  onSaved?: (account: unknown) => void
}) {
  const pt = lang === 'pt'
  const [draft, setDraft] = useState<AgentSchedule>(() => schedule ?? defaultAgentSchedule())
  const [focusDay, setFocusDay] = useState<AgentDay | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A newer server copy replaces the draft only while nothing is being edited.
  const saved = schedule ?? defaultAgentSchedule()
  const dirty = !sameSchedule(draft, saved)
  const savedKey = JSON.stringify(saved)
  const prevSaved = useRef(saved)
  useEffect(() => {
    const before = prevSaved.current
    prevSaved.current = saved
    // Follow the server copy unless the person had unsaved edits against the previous one.
    setDraft(d => sameSchedule(d, before) ? saved : d)
  }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const problem = scheduleProblem(draft, lang)
  const tap = isMobile ? 44 : undefined
  const btn = (kind: 'primary' | 'secondary', disabled = false) => ({ ...dialogButtonStyle(kind, isMobile, disabled), ...(isMobile ? {} : { padding: '5px 12px', fontSize: 12.5 }) })
  const small: React.CSSProperties = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 8, padding: '4px 9px', fontSize: 12, cursor: 'pointer', minHeight: tap, display: 'inline-flex', alignItems: 'center', gap: 4 }
  const time: React.CSSProperties = { background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 6, padding: '4px 6px', minHeight: tap, colorScheme: 'dark light', minWidth: 0, flex: '1 1 0', maxWidth: 140 }

  const save = async () => {
    if (problem || busy) return
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSchedule: draft }) })
      if (!r.ok) { setError(pt ? 'Não foi possível salvar a agenda. Tente novamente.' : 'Could not save the schedule. Try again.'); return }
      onSaved?.((await r.json() as { account: unknown }).account)
    } catch {
      setError(pt ? 'Não foi possível salvar a agenda. Tente novamente.' : 'Could not save the schedule. Try again.')
    } finally { setBusy(false) }
  }

  const selected = AGENT_DAYS.filter(d => draft.days[d])
  return <div data-agent-schedule={accountId} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: tap }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{pt ? 'Agenda de uso por agentes' : 'Agent-use schedule'}</span>
      <ToggleSwitch on={draft.enabled} onToggle={() => setDraft(d => ({ ...d, enabled: !d.enabled }))} tap={tap}
        label={`${pt ? 'Agenda de uso por agentes' : 'Agent-use schedule'} · ${who}`} />
    </div>
    {draft.enabled && scheduleSummaryText(draft, lang) && <span data-agent-schedule-line style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{scheduleSummaryText(draft, lang)}</span>}
    {showBadge && view && !dirty && <AgentUseBadge view={view} lang={lang} />}
    <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
      {draft.enabled
        ? (pt ? 'Fora destes horários a conta fica desligada para agentes. Ligar à mão vence a agenda; desligar à mão volta ao que a agenda manda. Uma sessão já rodando não é encerrada.'
          : 'Outside these hours the account is off for agents. Turning it on by hand overrides the schedule; turning it off returns to the schedule. A session already running is not stopped.')
        : (pt ? 'Desligada: o interruptor "Uso por agentes" decide sozinho, como antes.' : 'Off: the "Agent use" switch alone decides, as before.')}
    </p>
    <label data-agent-weekly-cap style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)', opacity: draft.enabled ? 1 : 0.6 }}>
      {pt ? 'Parar os agentes quando a semana chegar a' : 'Stop agents when the week reaches'}
      <input type="number" inputMode="decimal" min={1} max={100} step={1} placeholder="—" aria-label={pt ? 'Teto da semana (% de uso semanal)' : 'Weekly ceiling (% of weekly usage)'}
        value={draft.maxWeeklyPct ?? ''} onChange={e => { const v = e.target.value.trim(); setDraft(s => setWeeklyCap(s, v === '' ? undefined : Number(v))) }}
        style={{ ...time, width: 64 }} />
      %
      {weekReadingHint(view, lang) && <span data-agent-week-hint style={{ color: 'var(--text-tertiary)', fontSize: 11.5 }}>{weekReadingHint(view, lang)}</span>}
    </label>
    <div role="group" aria-label={pt ? 'Dias da semana' : 'Weekdays'} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, opacity: draft.enabled ? 1 : 0.6 }}>
      {AGENT_DAYS.map(d => {
        const on = !!draft.days[d]
        return <button key={d} type="button" aria-pressed={on} data-agent-day={d}
          onClick={() => { setDraft(s => toggleDay(s, d, focusDay ?? selected[0])); setFocusDay(on ? null : d) }}
          style={{ minWidth: isMobile ? 44 : 40, minHeight: tap ?? 28, borderRadius: 99, padding: '3px 10px', fontSize: 12.5, cursor: 'pointer',
            border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`, background: on ? 'var(--anthropic-orange)' : 'transparent', color: on ? '#000' : 'var(--text-secondary)', fontWeight: on ? 650 : 500 }}>
          {DAY_SHORT[d][lang]}
        </button>
      })}
    </div>
    {selected.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{pt ? 'Nenhum dia marcado: com a agenda ligada, agentes não usam esta conta.' : 'No day selected: with the schedule on, agents never use this account.'}</span>}
    {selected.map(d => {
      const day = draft.days[d]!
      return <div key={d} data-agent-day-editor={d} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, opacity: draft.enabled ? 1 : 0.6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 12.5 }}>{DAY_SHORT[d][lang]}</b>
          <button type="button" aria-pressed={!!day.allDay} data-agent-allday={d} onClick={() => { setFocusDay(d); setDraft(s => setAllDay(s, d, !day.allDay)) }}
            style={{ ...small, borderRadius: 99, ...(day.allDay ? { border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)', color: '#000', fontWeight: 650 } : {}) }}>
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
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            {pt ? 'Gastar no máximo' : 'Spend at most'}
            <input type="number" inputMode="decimal" min={1} max={100} step={1} placeholder="—" aria-label={`${DAY_SHORT[d][lang]} · ${pt ? 'teto do dia (% da semana)' : 'daily ceiling (% of the week)'}`}
              value={day.maxDailyPct ?? ''} onChange={e => { const v = e.target.value.trim(); setDraft(s => setDailyCap(s, d, v === '' ? undefined : Number(v))) }}
              style={{ ...time, width: 64 }} />
            {pt ? '% da semana neste dia' : '% of the week on this day'}
          </label>
          {d === TODAY_ID() && dayReadingHint(view, lang) && <span data-agent-day-hint style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{dayReadingHint(view, lang)}</span>}
          {selected.length > 1 && <button type="button" data-agent-copy={d} onClick={() => setDraft(s => copyToSelected(s, d))} style={small}>{pt ? 'Copiar para os dias marcados' : 'Copy to the selected days'}</button>}
        </div>
      </div>
    })}
    {(dirty || error) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {(problem || error) && <span role="alert" style={{ fontSize: 12, color: 'var(--accent-red)', marginRight: 'auto' }}>{problem ?? error}</span>}
      <button type="button" disabled={busy} onClick={() => { setDraft(saved); setError(null) }} style={btn('secondary', busy)}>{pt ? 'Descartar' : 'Discard'}</button>
      <button type="button" data-agent-schedule-save disabled={busy || !!problem || !dirty} onClick={() => { void save() }} style={btn('primary', busy || !!problem || !dirty)}>{busy ? (pt ? 'Salvando…' : 'Saving…') : (pt ? 'Salvar agenda' : 'Save schedule')}</button>
    </div>}
  </div>
}
