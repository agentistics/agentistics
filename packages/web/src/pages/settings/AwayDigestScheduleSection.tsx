/**
 * Settings → Sessions → Away mode: WHEN the away summary is offered. A machine preference
 * (`preferences.awayDigestSchedule`), because the server's timer is what offers it; the closed option
 * lists and the defaults live in `@agentistics/core` `awayDigestSchedule.ts`, and the server
 * re-validates whatever arrives.
 */
import { useEffect, useRef, useState } from 'react'
import {
  AWAY_DIGEST_EVERY_OPTIONS, AWAY_DIGEST_FIRST_OPTIONS, DEFAULT_AWAY_DIGEST_SCHEDULE, awayDigestDurationLabel, parseAwayDigestSchedule,
  type AwayDigestSchedule,
} from '@agentistics/core'
import { PrefRow, Select } from './primitives'
import { useIsMobile } from '../../hooks/useIsMobile'

const OFF = 'off'

export function firstAfterOptions(pt: boolean): { value: string; label: string }[] {
  return [
    ...AWAY_DIGEST_FIRST_OPTIONS.map(min => ({ value: String(min), label: awayDigestDurationLabel(min) })),
    { value: OFF, label: pt ? 'Desligado' : 'Off' },
  ]
}

export function everyOptions(): { value: string; label: string }[] {
  return AWAY_DIGEST_EVERY_OPTIONS.map(min => ({ value: String(min), label: awayDigestDurationLabel(min) }))
}

export default function AwayDigestScheduleSection({ pt }: { pt: boolean }) {
  const [schedule, setSchedule] = useState<AwayDigestSchedule>(DEFAULT_AWAY_DIGEST_SCHEDULE)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<'saving' | 'saved' | 'save-error' | 'load-error' | null>(null)
  const busy = useRef(false)
  const isMobile = useIsMobile()
  const box = { width: isMobile ? '100%' : 180 }

  useEffect(() => {
    let active = true
    fetch('/api/preferences').then(r => { if (!r.ok) throw new Error(); return r.json() as Promise<{ awayDigestSchedule?: unknown }> })
      .then(p => { if (active) { setSchedule(parseAwayDigestSchedule(p.awayDigestSchedule)); setLoaded(true) } })
      .catch(() => { if (active) setStatus('load-error') })
    return () => { active = false }
  }, [])

  const save = async (next: AwayDigestSchedule) => {
    if (!loaded || busy.current) return
    busy.current = true
    const prev = schedule
    setSchedule(next); setStatus('saving')
    try {
      const r = await fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ awayDigestSchedule: next }) })
      if (!r.ok) throw new Error()
      setStatus('saved')
    } catch { setSchedule(prev); setStatus('save-error') } finally { busy.current = false }
  }

  const off = schedule.firstAfterMin === null
  return (
    <div data-testid="away-digest-schedule" style={{ marginTop: 12 }}>
      <PrefRow label={pt ? 'Resumo da ausência: primeiro depois de' : 'Away summary: first after'}
        sub={pt ? 'A Nay oferece um resumo do que aconteceu enquanto você estava fora.' : 'Nay offers a summary of what happened while you were away.'}>
        <div style={box}><Select value={off ? OFF : String(schedule.firstAfterMin)} disabled={!loaded}
          onChange={v => { void save({ ...schedule, firstAfterMin: v === OFF ? null : Number(v) }) }} options={firstAfterOptions(pt)} /></div>
      </PrefRow>
      <PrefRow label={pt ? 'Depois, a cada' : 'Then every'}
        sub={off ? (pt ? 'Sem efeito com o resumo desligado.' : 'No effect while the summary is off.')
          : (pt ? 'Se você não responder, o aviso volta nesse intervalo. Depois de um resumo, a contagem recomeça.'
            : 'If you don’t answer, the offer comes back at this interval. After a summary, the count starts over.')}>
        <div style={box}><Select value={String(schedule.everyMin)} disabled={!loaded || off}
          onChange={v => { void save({ ...schedule, everyMin: Number(v) }) }} options={everyOptions()} /></div>
      </PrefRow>
      <div role="status" style={{ fontSize: 12, minHeight: 16, color: status?.endsWith('error') ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
        {status === 'saving' ? (pt ? 'Salvando…' : 'Saving…') : status === 'saved' ? (pt ? 'Salvo' : 'Saved')
          : status === 'save-error' ? (pt ? 'Não foi possível salvar. Tente novamente.' : 'Could not save. Please try again.')
          : status === 'load-error' ? (pt ? 'Não foi possível carregar esta configuração.' : 'Could not load this setting.') : null}
      </div>
    </div>
  )
}
