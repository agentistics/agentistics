/**
 * ExperimentalSettings — Settings → Experimental: the features that run on THIS host and are not yet
 * stable, one row each, with the switch the CLI used to be the only door to (`GET/PUT /api/experimental`).
 *
 * Turning one on or off ASKS first (`ConfirmModal`: what changes, and that it is experimental), then
 * writes. The server applies it without a restart, so this page stays connected; it then tells every
 * reader that cached "is the native harness on" to ask again (`invalidateEngineCaps`), which is what
 * makes the native harness appear in — or leave — the rest of the app without a reload.
 *
 * Host-only (`settingsSections.ts`): a central has no local features to switch, and answers 404.
 */
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { FlaskConical } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { ConfirmModal, ScopeNote, SectionHeader } from './primitives'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { useIsMobile } from '../../hooks/useIsMobile'
import { invalidateEngineCaps } from '../../lib/engineCapsBus'
import {
  confirmCopy, featureBlurb, featureName, requestSwitch, stateSentence, switchDisabled,
  type ExperimentalReportWire, type SwitchRequest,
} from '../../lib/experimentalSettings'

export default function ExperimentalSettings() {
  const { lang } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [report, setReport] = useState<ExperimentalReportWire | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<SwitchRequest | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/experimental', { cache: 'no-store' })
      if (!r.ok) { setError(pt ? `Não foi possível ler os recursos experimentais (HTTP ${r.status}).` : `Could not read the experimental features (HTTP ${r.status}).`); return }
      setError(null)
      setReport(await r.json() as ExperimentalReportWire)
    } catch {
      setError(pt ? 'Erro de rede ao ler os recursos experimentais.' : 'Network error reading the experimental features.')
    }
  }, [pt])
  useEffect(() => { void load() }, [load])

  const confirm = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const r = await fetch('/api/experimental', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: pending.next }),
      })
      if (!r.ok) { setError(pt ? `Não foi possível aplicar a mudança (HTTP ${r.status}).` : `The change could not be applied (HTTP ${r.status}).`); return }
      setError(null)
      setReport(await r.json() as ExperimentalReportWire)
      invalidateEngineCaps()
    } catch {
      setError(pt ? 'Erro de rede ao aplicar a mudança.' : 'Network error applying the change.')
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const pendingFeature = pending && report?.features.find(f => f.id === pending.id)
  const copy = pending && pendingFeature ? confirmCopy(pending, pendingFeature, lang) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <SectionHeader label="Experimental" />
      <ScopeNote>
        {pt
          ? 'Recursos que ainda estão sendo testados. Mudam sem aviso e podem quebrar. A mudança vale na hora, sem reiniciar o servidor.'
          : 'Features still being tried out. They change without notice and may break. A change takes effect immediately, without restarting the server.'}
      </ScopeNote>
      {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--accent-red)' }}>{error}</div>}
      {report === null && !error && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>…</div>}
      {report?.features.map(f => (
        <div key={f.id} data-testid={`experimental-${f.id}`} style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0,
          border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-card)',
        }}>
          <FlaskConical size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{featureName(f, lang)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>{featureBlurb(f, lang)}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 4 }}>{stateSentence(f, lang)}</div>
          </div>
          {f.switchable && (
            <ToggleSwitch
              on={f.on}
              label={featureName(f, lang)}
              disabled={switchDisabled(f) || busy}
              tap={isMobile ? 44 : undefined}
              onToggle={() => setPending(requestSwitch(f))}
            />
          )}
        </div>
      ))}
      {copy && (
        <ConfirmModal
          open
          title={copy.title}
          message={copy.message}
          confirmLabel={copy.confirmLabel}
          cancelLabel={copy.cancelLabel}
          onConfirm={() => { void confirm() }}
          onCancel={() => { if (!busy) setPending(null) }}
        />
      )}
    </div>
  )
}
