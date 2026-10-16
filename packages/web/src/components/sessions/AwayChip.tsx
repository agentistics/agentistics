import { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { SESSION_CHIP_STYLE } from './RoleChip'
import { ConfirmModal, Select } from '../../pages/settings/primitives'
import { setSessionAway, useAway } from '../../lib/awayMode'
import { AwayImpact } from '../AwayImpact'
import { useIsMobile } from '../../hooks/useIsMobile'

const OPEN_EVENT = 'ag-away-session-dialog'

/** Opens the away dialog of the session `id` (the ⋯ menu's item calls this; the chip below owns the dialog). */
export function openSessionAwayDialog(id: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }))
}

/** The ⋯ menu row for a session's own away switch — `[]` for a session that cannot take one. */
export function awayMenuItems(session: { id: string; actionable?: boolean; away?: boolean } | undefined, pt: boolean, globalActive: boolean) {
  if (!session?.actionable) return []
  return [{
    id: 'away', icon: <Moon size={14} aria-hidden />, on: session.away === true || globalActive,
    label: pt ? 'Modo ausente nesta sessão…' : 'Away mode on this session…',
    onSelect: () => openSessionAwayDialog(session.id),
  }]
}

/**
 * The session header shows NOTHING while the session merely inherits the global away switch (the top
 * bar's pill already says it). It shows a small moon only when THIS session overrides the global —
 * away on for it while the global is off — and it always owns the scope dialog the ⋯ menu opens.
 */
export function AwayChip({ pt, id, away = true }: { pt: boolean; compact?: boolean; id?: string; away?: boolean }) {
  const global = useAway()
  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState('session')
  const [pending, setPending] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setPending(null) }, [id, away])
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent).detail === id) { setScope('session'); setError(null); setOpen(true) } }
    window.addEventListener(OPEN_EVENT, h)
    return () => window.removeEventListener(OPEN_EVENT, h)
  }, [id])
  const on = pending ?? away // the session's OWN flag: what the dialog toggles
  const confirm = async () => {
    if (!id || busy) return
    setBusy(true); setError(null)
    const result = await setSessionAway(id, !on, pt ? 'pt' : 'en', scope === 'active' ? 'active' : undefined)
    setBusy(false)
    if (result.ok) { setPending(!on); setOpen(false) }
    else setError(pt ? `Não foi possível alterar (${result.error}).` : `Could not change it (${result.error}).`)
  }
  const override = on && !global.active
  const label = pt ? 'Modo ausente só nesta sessão' : 'Away mode on this session only'
  const hit = mobile ? { minWidth: 44, minHeight: 44, justifyContent: 'center' } as const : {}
  return <>
    {override && id && (
      <button type="button" data-testid="session-away-chip" role="switch" aria-checked title={label} aria-label={label}
        onClick={() => { setScope('session'); setError(null); setOpen(true) }}
        style={{ ...SESSION_CHIP_STYLE, border: 'none', padding: 3, alignSelf: 'center', background: 'transparent', cursor: 'pointer', color: 'var(--anthropic-orange)', ...hit }}>
        <Moon size={13} aria-hidden />
      </button>
    )}
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
