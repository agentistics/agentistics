import { useCallback, useEffect, useState } from 'react'
import { BarChart3, ChevronDown, ChevronRight, ClipboardList, Ellipsis, Gauge, House, KeyRound, LogOut, ShieldCheck, Terminal, type LucideIcon } from 'lucide-react'
import type { IamAccount } from '../../App'
import { areaOfPath, type AreaId } from '../../lib/appAreas'
import { activateMobileSessions, mobileAreaSlot, scrollMobileSessionsToTop } from '../../lib/mobileAreaTabs'
import { BottomSheet } from '../BottomSheet'
import { ChangePasswordSelf } from '../ChangePasswordSelf'
import { MfaSetup } from '../MfaSetup'
import { AreaTree, areaRowStyle, areaTrailingStyle } from './AreaTree'
import { MobilePillBar } from './MobilePillBar'

export interface MobileAreaAction {
  key: string
  label: string
  icon: LucideIcon
  onClick: () => void
  accent?: boolean
  badge?: string
  value?: string
  description?: string
  /** Toggles such as language and theme remain open for immediate feedback. */
  keepOpen?: boolean
}

/** Global actions share the area-list geometry, with current values aligned to the right. */
export function MobileActionRow({ action }: { action: MobileAreaAction }) {
  const Icon = action.icon
  return (
    <button type="button" onClick={action.onClick} style={{
      ...areaRowStyle(true), width: '100%', flex: 'none', border: 'none',
      cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
      ...(action.accent ? {
        boxShadow: 'inset 0 0 0 1px var(--anthropic-orange)', color: 'var(--anthropic-orange)',
        background: 'var(--anthropic-orange-dim)',
      } : {}),
    }}>
      <Icon size={17} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: action.accent ? 700 : 500 }}>{action.label}</span>
        {action.description && <span style={{ display: 'block', whiteSpace: 'normal', fontSize: 12, color: 'var(--text-tertiary)' }}>{action.description}</span>}
      </span>
      <span style={{ ...areaTrailingStyle(true), marginRight: -12 }}>
      {action.badge ? <span style={{ borderRadius: 9, padding: '2px 9px', background: 'var(--anthropic-orange)', color: '#111', fontSize: 10, fontWeight: 700 }}>{action.badge}</span>
        : action.value ? <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{action.value}</span>
        : <ChevronRight size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
      </span>
    </button>
  )
}

export function MobileAreaBar({ lang, pathname, badges, attention, onNavigate, actions, principal, visibleSettings, onSheetOpenChange }: {
  lang: 'pt' | 'en'
  pathname: string
  badges?: Partial<Record<AreaId, number>>
  attention?: number
  onNavigate: (to: string) => void
  actions: MobileAreaAction[]
  principal?: IamAccount
  visibleSettings?: ReadonlySet<string>
  onSheetOpenChange?: (open: boolean) => void
}) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [mfaOpen, setMfaOpen] = useState(false)
  useEffect(() => {
    onSheetOpenChange?.(open)
    return () => onSheetOpenChange?.(false)
  }, [open, onSheetOpenChange])
  const closeSheet = useCallback(() => { setOpen(false); setAccountOpen(false) }, [])
  useEffect(() => { closeSheet() }, [pathname, closeSheet])
  const go = (to: string) => { closeSheet(); onNavigate(to) }
  const current = areaOfPath(pathname)
  // Away from the sessions list the centre is the way back to it: a house labelled Início inside the
  // Sessions area (an open conversation, Leadership), the Sessions icon everywhere else and on the list itself.
  const atSessionsList = pathname === '/sessions' || pathname === '/sessions/'
  const homeButton = current?.area.id === 'sessions' && !atSessionsList
  const sessions = homeButton ? (pt ? 'Início' : 'Home') : (pt ? 'Sessões' : 'Sessions')
  const sessionBadge = badges?.sessions ?? attention
  const orange = 'var(--anthropic-orange)'
  const roleLabel = principal
    ? (principal.role === 'owner' ? 'Owner' : (principal.memberships.some(m => m.role === 'manager') ? 'Manager' : 'User'))
    : ''
  const logout = () => { void fetch('/api/iam/logout', { method: 'POST' }).then(() => window.location.reload()) }
  const accountActionStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44,
    padding: '0 14px', borderRadius: 12, border: '1px solid var(--border)',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
    fontSize: '0.8438rem', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
  }

  return (
    <>
      <MobilePillBar
        centerIndex={2}
        ariaLabel={pt ? 'Navegação principal' : 'Main navigation'}
        activeIndex={open ? 4 : mobileAreaSlot(pathname)}
        items={[
          { key: 'tasks', label: 'Agentask', icon: ClipboardList, onActivate: () => go('/tasks'), badge: badges?.tasks },
          { key: 'usage', label: pt ? 'Uso' : 'Usage', icon: Gauge, onActivate: () => go('/usage'), badge: badges?.usage },
          { key: 'sessions', label: sessions, ariaLabel: sessionBadge && sessionBadge > 0 ? `${sessions}, ${sessionBadge} ${pt ? 'precisam de você' : 'need you'}` : sessions,
            icon: homeButton ? House : Terminal, onActivate: () => { closeSheet(); activateMobileSessions(pathname, onNavigate, scrollMobileSessionsToTop) }, badge: sessionBadge },
          { key: 'metrics', label: pt ? 'Métricas' : 'Metrics', icon: BarChart3, onActivate: () => go('/'), badge: badges?.metrics },
          { key: 'more', label: pt ? 'Mais' : 'More', icon: Ellipsis, onActivate: () => setOpen(v => !v), expanded: open, hasPopup: 'dialog' },
        ]}
      />
      <BottomSheet open={open} onClose={closeSheet} title={pt ? 'Ir para' : 'Go to'} lang={lang}>
        <div style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <AreaTree lang={lang} pathname={pathname} variant="sheet" badges={badges} onNavigate={go} visibleSettings={visibleSettings} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {actions.map(action => <MobileActionRow key={action.key} action={{ ...action, onClick: () => { if (!action.keepOpen) closeSheet(); action.onClick() } }} />)}
          </div>
        {principal && (
          <button
            onClick={() => setAccountOpen(o => !o)}
            aria-expanded={accountOpen}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44,
              padding: '8px 10px', marginBottom: 10, borderRadius: 12,
              border: `1px solid ${accountOpen ? orange : 'var(--border)'}`,
              background: accountOpen ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
              cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{
              width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-surface)',
              border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', flexShrink: 0,
            }}>{principal.name.slice(0, 2)}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{principal.name}</span>
              <span style={{ display: 'block', fontSize: '0.625rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{roleLabel}</span>
            </span>
            <ChevronDown size={16} style={{ flexShrink: 0, color: 'var(--text-tertiary)', transform: accountOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
          </button>
        )}
        {accountOpen && principal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              onClick={() => { setAccountOpen(false); setOpen(false); setPwOpen(true) }}
              style={accountActionStyle}
            >
              <KeyRound size={16} /> {pt ? 'Trocar senha' : 'Change password'}
            </button>
            <button
              onClick={() => { setAccountOpen(false); setOpen(false); setMfaOpen(true) }}
              style={accountActionStyle}
            >
              <ShieldCheck size={16} /> {pt ? 'Duas etapas' : 'Two-factor'}
            </button>
            <button
              onClick={logout}
              style={{ ...accountActionStyle, color: '#ef4444', borderColor: 'color-mix(in srgb, #ef4444 40%, transparent)' }}
            >
              <LogOut size={16} /> {pt ? 'Sair' : 'Log out'}
            </button>
          </div>
        )}

        </div>
      </BottomSheet>
      {pwOpen && <ChangePasswordSelf lang={lang} onClose={() => setPwOpen(false)} />}
      {mfaOpen && <MfaSetup lang={lang} onClose={() => setMfaOpen(false)} canDisable={principal?.role !== 'owner'} />}
    </>
  )
}
