/**
 * NativeEffortSwitch — B9.1: the reasoning effort the session's NEXT runs ask for (off, low, medium,
 * high), asked of the provider the way it takes it. Disabled while a run is in flight. A provider or a
 * model that takes none is refused by the engine, and its sentence is shown.
 */
import { useState } from 'react'

export type EffortLevel = 'off' | 'low' | 'medium' | 'high'
const LEVELS: EffortLevel[] = ['off', 'low', 'medium', 'high']
const LABEL: Record<EffortLevel, { pt: string; en: string }> = {
  off: { pt: 'desligado', en: 'off' }, low: { pt: 'baixo', en: 'low' }, medium: { pt: 'médio', en: 'medium' }, high: { pt: 'alto', en: 'high' },
}

export function NativeEffortSwitch({ effort, running, lang, onSet }: {
  effort: EffortLevel
  running: boolean
  lang: 'pt' | 'en'
  onSet: (effort: EffortLevel) => Promise<string | null>
}) {
  const pt = lang === 'pt'
  const [error, setError] = useState<string | null>(null)
  return (
    <label data-testid="native-effort" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0 }}
      title={running ? (pt ? 'Uma run está em andamento — mude quando ela terminar.' : 'A run is in progress — change it when it ends.') : undefined}>
      <span>{pt ? 'Raciocínio' : 'Reasoning'}</span>
      <select
        aria-label={pt ? 'Esforço de raciocínio dos próximos turnos' : 'Reasoning effort for the next turns'}
        value={effort}
        disabled={running}
        onChange={async e => setError(await onSet(e.target.value as EffortLevel))}
        style={{ fontSize: 11.5, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 4px' }}
      >
        {LEVELS.map(l => <option key={l} value={l}>{LABEL[l][lang]}</option>)}
      </select>
      {error && <span role="alert" style={{ color: 'var(--accent-red)' }}>{error}</span>}
    </label>
  )
}
