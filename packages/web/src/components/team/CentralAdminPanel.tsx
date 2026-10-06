import { AgentisticsLoader } from '../../components/AgentisticsLoader'
import React, { useState, useEffect } from 'react'
import { Server } from 'lucide-react'
import { TeamMembers } from '../TeamMembers'
import { PUSH_INTERVAL, type MemberPresence } from '@agentistics/core'
import { SectionHeader, Divider, PrefRow } from '../../pages/settings/primitives'
import { useIsMobile } from '../../hooks/useIsMobile'

/**
 * CentralAdminPanel — the team-central branch of the old `TeamSettings.tsx`, lifted verbatim
 * (Task 10). This instance IS the central: there is no connection to configure here, only the
 * push-interval policy this central enforces on every member, plus the members roster.
 *
 * `SectionHeader`/`Divider`/`PrefRow` now come from `pages/settings/primitives.tsx` instead of
 * being redeclared locally (the old file's own copies were byte-identical) — see CLAUDE.md's
 * rule against re-declaring a primitive.
 */

// Interval options shown in the selector. Must stay in sync with PUSH_INTERVAL.MIN_SEC/MAX_SEC.
const INTERVAL_OPTIONS = ([15, 30, 60, 120, 300] as const).filter(
  (sec) => sec >= PUSH_INTERVAL.MIN_SEC && sec <= PUSH_INTERVAL.MAX_SEC,
) as readonly number[]
// Express mode reveals sub-15s options (down to EXPRESS_MIN_SEC) — central-only.
const EXPRESS_OPTIONS = ([5, 10, ...INTERVAL_OPTIONS] as const).filter(
  (sec) => sec >= PUSH_INTERVAL.EXPRESS_MIN_SEC && sec <= PUSH_INTERVAL.MAX_SEC,
) as readonly number[]

export interface CentralAdminPanelProps {
  lang: 'pt' | 'en'
  /** Shared dashboard presence (/api/data), threaded to the members panel so it can't diverge
   *  from the FiltersBar presence pill. */
  presence?: Record<string, MemberPresence>
}

const COPY = {
  centralTitle: { en: 'Team central', pt: 'Central do time' },
  centralDesc: {
    en: 'This instance is running as the team central. Use the panel below to manage team members and their access tokens.',
    pt: 'Esta instância está rodando como central do time. Use o painel abaixo para gerenciar membros e seus tokens de acesso.',
  },
  pushInterval: { en: 'Push interval', pt: 'Intervalo de envio' },
  pushIntervalSubCentral: { en: 'Members push at this interval (min 15 s)', pt: 'Membros enviam neste intervalo (mín. 15 s)' },
  express: { en: 'Express', pt: 'Express' },
  expressHint: { en: 'Allow intervals below 15 s (higher load on the central)', pt: 'Permite intervalos abaixo de 15 s (mais carga na central)' },
} satisfies Record<string, { en: string; pt: string }>

function c(key: keyof typeof COPY, lang: 'pt' | 'en'): string {
  return COPY[key][lang]
}

function formatInterval(sec: number): string {
  if (sec < 60) return `${sec} s`
  const m = sec / 60
  return m === 1 ? '1 min' : `${m} min`
}

function IntervalSelect({ value, onChange, options, disabled = false }: {
  value: number
  onChange: (sec: number) => void
  options: readonly number[]
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      disabled={disabled}
      style={{
        padding: '5px 8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 7, fontSize: 12, color: 'var(--text-primary)', fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', outline: 'none',
        ...(disabled ? { opacity: 0.6 } : {}),
      }}
    >
      {options.map(sec => <option key={sec} value={sec}>{formatInterval(sec)}</option>)}
    </select>
  )
}

export function CentralAdminPanel({ lang, presence }: CentralAdminPanelProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [centralInterval, setCentralInterval] = useState<number>(PUSH_INTERVAL.DEFAULT_SEC)
  const [express, setExpress] = useState(false)
  const [intervalSaving, setIntervalSaving] = useState(false)
  const [intervalSaveErr, setIntervalSaveErr] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/team/config')
      .then(r => (r.ok ? (r.json() as Promise<{ pushIntervalSec?: number }>) : Promise.reject()))
      .then(cfg => {
        if (typeof cfg.pushIntervalSec === 'number') {
          const opts = cfg.pushIntervalSec < PUSH_INTERVAL.MIN_SEC ? EXPRESS_OPTIONS : INTERVAL_OPTIONS
          const val = opts.includes(cfg.pushIntervalSec) ? cfg.pushIntervalSec : PUSH_INTERVAL.DEFAULT_SEC
          setCentralInterval(val)
          if (cfg.pushIntervalSec < PUSH_INTERVAL.MIN_SEC) setExpress(true)
        }
      })
      .catch(() => { /* ignore — server may not have the field yet */ })
  }, [])

  function handleCentralIntervalChange(sec: number) {
    const opts = express ? EXPRESS_OPTIONS : INTERVAL_OPTIONS
    const snapped = opts.includes(sec) ? sec : PUSH_INTERVAL.DEFAULT_SEC
    setCentralInterval(snapped)
    setIntervalSaving(true)
    setIntervalSaveErr(null)
    fetch('/api/team/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushIntervalSec: snapped }),
    })
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        setIntervalSaveErr(null)
      })
      .catch((err: unknown) => {
        setIntervalSaveErr(err instanceof Error ? err.message : 'Save failed')
      })
      .finally(() => { setIntervalSaving(false) })
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '12px 14px', borderRadius: 8, marginBottom: 20,
        background: 'var(--anthropic-orange-dim)', border: '1.5px solid var(--anthropic-orange)',
      }}>
        <Server size={16} style={{ color: 'var(--anthropic-orange)', flexShrink: 0, marginTop: 1 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--anthropic-orange)', marginBottom: 3 }}>
            {c('centralTitle', lang)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            {c('centralDesc', lang)}
          </div>
        </div>
      </div>

      <SectionHeader label={pt ? 'Configurações de envio' : 'Push settings'} />
      <PrefRow label={c('pushInterval', lang)} sub={c('pushIntervalSubCentral', lang)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
          <IntervalSelect
            value={centralInterval}
            onChange={handleCentralIntervalChange}
            options={express ? EXPRESS_OPTIONS : INTERVAL_OPTIONS}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }} title={c('expressHint', lang)}>
            <input
              type="checkbox"
              checked={express}
              onChange={e => {
                const on = e.target.checked
                setExpress(on)
                if (!on && centralInterval < PUSH_INTERVAL.MIN_SEC) handleCentralIntervalChange(PUSH_INTERVAL.MIN_SEC)
              }}
              style={{ accentColor: 'var(--anthropic-orange)', cursor: 'pointer' }}
            />
            {c('express', lang)}
          </label>
          {intervalSaving && (
            <AgentisticsLoader size={12} style={{ color: 'var(--text-tertiary)' }} />
          )}
          {!intervalSaving && intervalSaveErr !== null && (
            <span style={{ fontSize: 11, color: '#ef4444' }}>{intervalSaveErr}</span>
          )}
        </div>
      </PrefRow>

      <Divider />

      <TeamMembers lang={lang} presence={presence} />
    </div>
  )
}
