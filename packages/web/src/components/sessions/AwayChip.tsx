import { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { SESSION_CHIP_STYLE } from './RoleChip'
import { ConfirmModal, Select } from '../../pages/settings/primitives'
import { setSessionAway, useAway } from '../../lib/awayMode'
import { AwayImpact } from '../AwayImpact'

export function AwayChip({ pt, compact = false, id, away = true }: { pt: boolean; compact?: boolean; id?: string; away?: boolean }) {
  const global = useAway()
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState('session')
  const [pending, setPending] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setPending(null) }, [id, away])
  const on = pending ?? away // the session's OWN flag: what a click toggles
  const viaGlobal = !on && global.active
  const effective = on || global.active // what the chip shows: the true state
  const label = pt ? 'Modo ausente nesta sessão' : 'Away mode on this session'
  const confirm = async () => {
    if (!id || busy) return
    setBusy(true); setError(null)
    const result = await setSessionAway(id, !on, pt ? 'pt' : 'en', scope === 'active' ? 'active' : undefined)
    setBusy(false)
    if (result.ok) { setPending(!on); setOpen(false) }
    else setError(pt ? `Não foi possível alterar (${result.error}).` : `Could not change it (${result.error}).`)
  }
  const style = { ...SESSION_CHIP_STYLE, color: effective ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', alignSelf: 'center', flexShrink: 0 }
  if (!id) return <span data-testid="session-away-chip" title={label} style={style}><Moon size={11} aria-hidden />{!compact && (pt ? 'Ausente' : 'Away')}</span>
  return <>
    <button type="button" data-testid="session-away-chip" role="switch" aria-checked={effective} aria-label={label} title={label}
      onClick={() => { setScope('session'); setError(null); setOpen(true) }}
      style={{ ...style, minWidth: 44, minHeight: 44, background: 'transparent', cursor: 'pointer', justifyContent: 'center' }}>
      <Moon size={14} aria-hidden />{!compact && (viaGlobal ? (pt ? 'Ausente (global)' : 'Away (global)') : on ? (pt ? 'Ausente' : 'Away') : (pt ? 'Definir ausente' : 'Set away'))}
    </button>
    <AwayScopeDialog pt={pt} open={open} on={on} scope={scope} setScope={setScope} busy={busy} error={error}
      globalActive={global.active} onConfirm={() => { void confirm() }} onCancel={() => { if (!busy) setOpen(false) }} />
  </>
}

/** The scope question uses the same modal and picker as Settings, for both ON and OFF. */
export function AwayScopeDialog({ pt, open, on, scope, setScope, busy, error, globalActive, onConfirm, onCancel }: {
  pt: boolean; open: boolean; on: boolean; scope: string; setScope: (scope: string) => void
  busy: boolean; error: string | null; globalActive: boolean; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <ConfirmModal open={open} tone="default" icon={<Moon size={17} />}
      title={on ? (pt ? 'Desligar modo ausente' : 'Turn away mode off') : (pt ? 'Ligar modo ausente' : 'Turn away mode on')}
      message={pt ? 'Onde aplicar esta mudança?' : 'Where should this change apply?'}
      confirmLabel={busy ? (pt ? 'Salvando…' : 'Saving…') : (pt ? 'Aplicar' : 'Apply')}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'} onConfirm={onConfirm} onCancel={onCancel}>
      <Select value={scope} onChange={setScope} disabled={busy} options={[
        { value: 'session', label: pt ? 'Só esta sessão' : 'Only this session' },
        { value: 'active', label: pt ? 'Todas as sessões ativas agora' : 'All sessions active now' },
      ]} />
      {scope === 'active' && <AwayImpact pt={pt} open={open} />}
      {globalActive && <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{pt
        ? 'O modo global também está ligado e continua valendo. Use o controle global para avisar que voltou para todas as sessões.'
        : 'Global away mode is also on and still applies. Use the global control to return for every session.'}</p>}
      {error && <p role="alert">{error}</p>}
    </ConfirmModal>
  )
}
