/**
 * The ONE dialog autonomous mode asks — and it asks almost nothing (owner, 2026-11-06): an on/off
 * switch and WHEN ("until I turn it off", or a schedule). The schedule is the very editor the
 * agent-use agenda of an account uses (`AgentScheduleDays` — weekdays, hour windows, "all day"),
 * minus the usage ceilings, which have no meaning here. What sessions may do without asking
 * (releases, workers, merges), the worker ceiling and the per-provider top-model ceiling are
 * automatic defaults decided by the server — they are not asked. A free note stays, collapsed.
 */
import React, { useEffect, useState } from 'react'
import { AWAY_DEFAULT_MAX_WORKERS, AWAY_DEFAULT_TOP_CAP, AWAY_NOTE_MAX, defaultAgentSchedule, scheduleCanBeOn, type AgentDay, type AgentSchedule } from '@agentistics/core'
import { ConfirmModal, FieldTextarea } from '../pages/settings/primitives'
import { ToggleSwitch } from './ToggleSwitch'
import { AgentScheduleDays } from './AgentScheduleEditor'
import { CenteredLoader } from './CenteredLoader'
import { AUTONOMOUS_ICON, setAway, useAway, type AwayRequest } from '../lib/awayMode'
import { scheduleProblem, scheduleSummaryText } from '../lib/agentScheduleView'
import { useIsMobile } from '../hooks/useIsMobile'

export type AwayWhen = 'indefinite' | 'scheduled'

/** The request body for what the dialog holds. Pure: the ceilings and authorisations are the server's defaults. */
export function awayRequestOf(on: boolean, when: AwayWhen, schedule: AgentSchedule, note: string): AwayRequest {
  if (!on) return { on: false }
  return {
    on: true,
    ...(when === 'scheduled' ? { schedule: { ...schedule, enabled: true } } : {}),
    ...(note.trim() ? { note } : {}),
  }
}

/** Why the dialog cannot be confirmed, in words; null when it can. */
export function awayDialogProblem(on: boolean, when: AwayWhen, schedule: AgentSchedule, lang: 'pt' | 'en'): string | null {
  if (!on || when !== 'scheduled') return null
  const p = scheduleProblem(schedule, lang)
  if (p) return p
  return scheduleCanBeOn(schedule) ? null : (lang === 'pt' ? 'Marque ao menos um dia com horário (ou "Dia inteiro").' : 'Pick at least one day with hours (or "All day").')
}

export default function AwayModeDialog({ open, lang, onClose }: { open: boolean; lang: 'pt' | 'en'; onClose: () => void }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const away = useAway()
  const [on, setOn] = useState(true)
  const [when, setWhen] = useState<AwayWhen>('indefinite')
  const [schedule, setSchedule] = useState<AgentSchedule>(() => ({ ...defaultAgentSchedule(), enabled: true }))
  const [focusDay, setFocusDay] = useState<AgentDay | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Opening reads what is stored (editing a running schedule), otherwise starts from the defaults.
  const stored = away.state
  useEffect(() => {
    if (!open) return
    setError(null); setBusy(false); setOn(true); setFocusDay(null)
    const s = stored && stored.on ? stored : null
    setWhen(s?.schedule ? 'scheduled' : 'indefinite')
    setSchedule(s?.schedule ?? { ...defaultAgentSchedule(), enabled: true })
    setNote(s?.note ?? '')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const problem = awayDialogProblem(on, when, schedule, lang)
  const confirm = async () => {
    if (busy || problem) return
    setBusy(true)
    const r = await setAway(awayRequestOf(on, when, schedule, note))
    setBusy(false)
    if (r.ok) onClose()
    else setError(pt ? `Não foi possível salvar o modo autônomo (${r.error}).` : `Could not save autonomous mode (${r.error}).`)
  }

  const tap = isMobile ? 44 : undefined
  const seg = (id: AwayWhen, text: string) => {
    const sel = when === id
    return <button key={id} type="button" aria-pressed={sel} data-away-when={id} onClick={() => setWhen(id)}
      style={{ flex: 1, minHeight: tap ?? 34, padding: '6px 10px', fontSize: 13, cursor: 'pointer', border: 'none',
        background: sel ? 'var(--anthropic-orange)' : 'transparent', color: sel ? '#000' : 'var(--text-secondary)', fontWeight: sel ? 650 : 500 }}>{text}</button>
  }
  const defaultsLine = pt
    ? `Padrão automático: releases, workers e merges liberados; até ${AWAY_DEFAULT_MAX_WORKERS} workers e ${AWAY_DEFAULT_TOP_CAP} no modelo de topo por provedor.`
    : `Automatic defaults: releases, workers and merges allowed; up to ${AWAY_DEFAULT_MAX_WORKERS} workers and ${AWAY_DEFAULT_TOP_CAP} on each provider's top model.`
  const summary = on && when === 'scheduled' ? scheduleSummaryText(schedule, lang) : ''

  return (
    <ConfirmModal
      open={open}
      tone="default"
      icon={<AUTONOMOUS_ICON size={17} />}
      title={pt ? 'Modo autônomo' : 'Autonomous mode'}
      message={pt ? 'Ligado, as sessões trabalham sem pedir permissão: os líderes decidem e registram, os workers reportam ao líder.'
        : 'When on, sessions work without asking permission: leaders decide and record, workers report to their leader.'}
      confirmLabel={busy ? (pt ? 'Salvando…' : 'Saving…') : on ? (pt ? 'Ligar' : 'Turn on') : (pt ? 'Desligar' : 'Turn off')}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'}
      busy={busy || !!problem || stored === null}
      onConfirm={() => { void confirm() }}
      onCancel={onClose}
    >
      {stored === null ? <CenteredLoader placement="area" label={pt ? 'Carregando…' : 'Loading…'} testId="away-dialog-loader" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: tap }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{pt ? 'Sessões trabalham sem pedir permissão' : 'Sessions work without asking permission'}</span>
            <ToggleSwitch on={on} onToggle={() => setOn(v => !v)} tap={tap} label={pt ? 'Modo autônomo' : 'Autonomous mode'} />
          </div>
          {on && <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{pt ? 'Quando' : 'When'}</span>
              <div role="group" aria-label={pt ? 'Quando' : 'When'} style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                {seg('indefinite', pt ? 'Até eu desligar' : 'Until I turn it off')}
                {seg('scheduled', pt ? 'Agendado' : 'Scheduled')}
              </div>
            </div>
            {when === 'scheduled' && <div data-away-schedule style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <AgentScheduleDays draft={schedule} setDraft={setSchedule} focusDay={focusDay} setFocusDay={setFocusDay} lang={lang} isMobile={isMobile} caps={false}
                emptyHint={pt ? 'Nenhum dia marcado: o modo autônomo nunca ligaria.' : 'No day selected: autonomous mode would never turn on.'} />
              {summary && <span data-away-schedule-line style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{summary}</span>}
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{pt ? 'Fora destes horários as sessões voltam a perguntar a você.' : 'Outside these hours sessions ask you again.'}</span>
            </div>}
            <span data-away-defaults style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{defaultsLine}</span>
            <details>
              <summary style={{ fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer', minHeight: tap }}>{pt ? 'Recado para os líderes (opcional)' : 'Note for the leaders (optional)'}</summary>
              <FieldTextarea label="" value={note} onChange={setNote} rows={2} maxLength={AWAY_NOTE_MAX}
                placeholder={pt ? 'ex.: foco no QUAL; nada de deploy em cloud' : 'e.g. focus on QUAL; no cloud deploys'} />
            </details>
          </>}
          {(problem || error) && <span role="alert" style={{ fontSize: 12, color: '#ef4444' }}>{problem ?? error}</span>}
        </div>
      )}
    </ConfirmModal>
  )
}
