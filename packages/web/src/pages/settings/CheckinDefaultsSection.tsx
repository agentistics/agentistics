import { useEffect, useRef, useState } from 'react'
import { CheckinConfigControls } from '../../components/sessions/CheckinConfigControls'
import { buildCheckinPatch, checkinDefaults, saveCheckinDefaults, type CheckinConfig } from '../../lib/checkin'
import { SectionHeader } from './primitives'

export default function CheckinDefaultsSection({ pt, isMobile }: { pt: boolean; isMobile: boolean }) {
  const [config, setConfig] = useState<CheckinConfig>(() => checkinDefaults())
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'saved' | 'load-error' | 'save-error' | null>(null)
  const busy = useRef(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    fetch('/api/preferences').then(async response => {
      if (!response.ok) throw new Error('load failed')
      return response.json()
    }).then(prefs => {
      if (!active) return
      setConfig(checkinDefaults(prefs.checkinDefaults)); setLoaded(true); setStatus(null)
    }).catch(() => { if (active) setStatus('load-error') })
    return () => { active = false }
  }, [retry])

  const update = async (patch: Partial<CheckinConfig>) => {
    if (!loaded || busy.current) return
    busy.current = true; setSaving(true); setStatus(null)
    const next = buildCheckinPatch(config, patch)
    try {
      await saveCheckinDefaults(next)
      setConfig(next); setStatus('saved')
    } catch { setStatus('save-error') }
    finally { busy.current = false; setSaving(false) }
  }

  return <section data-testid="checkin-defaults-section">
    <SectionHeader label={pt ? 'Check-in dos líderes' : 'Leader check-ins'} />
    <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
      {pt ? 'Cada novo líder começa com estas escolhas, inclusive após uma passagem de liderança. Você pode ajustar o check-in de cada sessão; líderes atuais mantêm suas escolhas.'
        : 'Every new leader starts with these choices, including after a leadership handoff. You can adjust each session’s check-in; current leaders keep their choices.'}
    </p>
    <CheckinConfigControls config={config} pt={pt} isMobile={isMobile} update={update} global disabled={!loaded || saving} />
    <div role="status" style={{ fontSize: 12, marginTop: 8, color: status?.endsWith('error') ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
      {!loaded && !status ? (pt ? 'Carregando…' : 'Loading…') : saving ? (pt ? 'Salvando…' : 'Saving…') : status === 'saved' ? (pt ? 'Salvo' : 'Saved')
        : status === 'save-error' ? (pt ? 'Não foi possível salvar. Tente novamente.' : 'Could not save. Please try again.')
        : status === 'load-error' ? (pt ? 'Não foi possível carregar suas escolhas.' : 'Could not load your choices.') : null}
    </div>
    {status === 'load-error' && <button type="button" onClick={() => { setStatus(null); setRetry(n => n + 1) }} style={{ minHeight: isMobile ? 44 : undefined }}>{pt ? 'Tentar novamente' : 'Try again'}</button>}
  </section>
}
