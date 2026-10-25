import { useEffect, useState, useSyncExternalStore } from 'react'
import { Moon } from 'lucide-react'
import { SESSION_CHIP_STYLE } from './RoleChip'
import { ConfirmModal, Select } from '../../pages/settings/primitives'
import { setSessionAway, useAway } from '../../lib/awayMode'
import { sessionAwayView } from '@agentistics/core'
import { AwayImpact } from '../AwayImpact'
import { useIsMobile } from '../../hooks/useIsMobile'

/**
 * ONE dialog for the whole app. Several surfaces can show the same session at once (the top bar, the
 * dedicated terminal, the mobile header), and a listener per mount opened one dialog per surface. The
 * request lives in this tiny store instead and `AwayDialogHost` — mounted once, in App — owns the dialog.
 */
interface Request { id: string; away: boolean; pt: boolean }
const store = { req: null as Request | null, pending: {} as Record<string, boolean | undefined>, listeners: new Set<() => void>() }
const emit = () => { for (const l of store.listeners) l() }
const subscribe = (l: () => void) => { store.listeners.add(l); return () => { store.listeners.delete(l) } }
let version = 0
const versioned = () => version
const bump = () => { version++; emit() }

/** Opens the away dialog of session `id`. `trigger` (the ⋯ button) gets the focus back when it closes. */
export function openSessionAwayDialog(id: string, opts: { away?: boolean; pt?: boolean; trigger?: HTMLElement | null } = {}) {
  if (typeof document !== 'undefined') opts.trigger?.focus() // the dialog remembers what had focus when it opened
  store.req = { id, away: opts.away ?? store.pending[id] ?? false, pt: opts.pt ?? false }
  bump()
}
export function closeSessionAwayDialog() { store.req = null; bump() }
/** The request currently open, for tests and the host. */
export function currentAwayDialog() { return store.req }
export function __resetAwayDialogForTest() { store.req = null; store.pending = {}; bump() }

/** The ⋯ menu row for a session's own away switch — `[]` for a session that cannot take one. */
export function awayMenuItems(session: { id: string; actionable?: boolean; away?: boolean } | undefined, pt: boolean, globalActive: boolean) {
  if (!session?.actionable) return []
  return [{
    id: 'away', icon: <Moon size={14} aria-hidden />, on: session.away === true || globalActive,
    label: pt ? 'Modo ausente nesta sessão…' : 'Away mode on this session…',
    onSelect: (trigger?: HTMLElement | null) => openSessionAwayDialog(session.id, { away: session.away === true, pt, trigger }),
  }]
}

/**
 * The session header shows NOTHING while the session merely inherits the global away switch (the top
 * bar's pill already says it). It shows a small moon only when THIS session overrides the global —
 * away on for it while the global is off. The scope dialog is `AwayDialogHost`'s, never this chip's.
 */
export function AwayChip({ pt, id, away = false }: { pt: boolean; compact?: boolean; id?: string; away?: boolean }) {
  const global = useAway()
  const mobile = useIsMobile()
  useSyncExternalStore(subscribe, versioned, versioned)
  useEffect(() => { if (id && store.pending[id] !== undefined) { store.pending[id] = undefined; bump() } }, [id, away])
  const on = (id ? store.pending[id] : undefined) ?? away // the session's OWN flag: what the dialog toggles
  const override = on && !global.active
  const label = pt ? 'Modo ausente só nesta sessão' : 'Away mode on this session only'
  const hit = mobile ? { minWidth: 44, minHeight: 44, justifyContent: 'center' } as const : {}
  if (!override || !id) return null
  return (
    <button type="button" data-testid="session-away-chip" role="switch" aria-checked title={label} aria-label={label}
      onClick={e => openSessionAwayDialog(id, { away: on, pt, trigger: e.currentTarget })}
      style={{ ...SESSION_CHIP_STYLE, border: 'none', padding: 3, alignSelf: 'center', background: 'transparent', cursor: 'pointer', color: 'var(--anthropic-orange)', ...hit }}>
      <Moon size={13} aria-hidden />
    </button>
  )
}

/** Mounted ONCE (App). Owns the single away dialog every surface asks for. */
export function AwayDialogHost() {
  const global = useAway()
  useSyncExternalStore(subscribe, versioned, versioned)
  const req = store.req
  const [scope, setScope] = useState('session')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setScope('session'); setError(null) }, [req?.id])
  if (!req) return null
  const { id, pt } = req
  // With the global switch active the session is away whatever its own flag says: the dialog states
  // that (and where to turn it off) instead of offering a per-session OFF that would change nothing.
  const view = sessionAwayView(global.active, store.pending[id] ?? req.away)
  const on = view.on
  const confirm = async () => {
    if (view.locked) { closeSessionAwayDialog(); return }
    if (busy) return
    setBusy(true); setError(null)
    const result = await setSessionAway(id, !on, pt ? 'pt' : 'en', scope === 'active' ? 'active' : undefined)
    setBusy(false)
    if (result.ok) { store.pending[id] = !on; closeSessionAwayDialog() }
    else setError(pt ? `Não foi possível alterar (${result.error}).` : `Could not change it (${result.error}).`)
  }
  return <AwayScopeDialog pt={pt} open on={on} scope={scope} setScope={setScope} busy={busy} error={error}
    globalActive={global.active} locked={view.locked} onConfirm={() => { void confirm() }} onCancel={() => { if (!busy) closeSessionAwayDialog() }} />
}

/** The scope question uses the same modal and picker as Settings, for both ON and OFF. */
export function AwayScopeDialog({ pt, open, on, scope, setScope, busy, error, globalActive, locked = false, onConfirm, onCancel }: {
  pt: boolean; open: boolean; on: boolean; scope: string; setScope: (scope: string) => void
  /** The global switch decides this session's state: say so, offer nothing to change here. */
  locked?: boolean
  busy: boolean; error: string | null; globalActive: boolean; onConfirm: () => void; onCancel: () => void
}) {
  if (locked) return (
    <ConfirmModal open={open} tone="default" icon={<Moon size={17} />}
      title={pt ? 'Ligado pelo modo ausente geral' : 'On through global away mode'}
      message={pt
        ? 'Enquanto o modo ausente geral estiver ligado, esta sessão segue ausente. Para voltar, desligue o modo ausente geral.'
        : 'While global away mode is on, this session stays away. To come back, turn global away mode off.'}
      confirmLabel={pt ? 'Entendi' : 'Got it'} cancelLabel={pt ? 'Fechar' : 'Close'} onConfirm={onConfirm} onCancel={onCancel} />
  )
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
