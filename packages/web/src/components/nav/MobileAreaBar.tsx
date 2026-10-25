import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, KeyRound, LogOut, ShieldCheck, MessagesSquare, type LucideIcon } from 'lucide-react'
import type { IamAccount } from '../../App'
import { areaOfPath, isSessionsWorkspace, pageLabel, type AreaId } from '../../lib/appAreas'
import { BottomSheet } from '../BottomSheet'
import { BetaTag } from '../BetaTag'
import { ChangePasswordSelf } from '../ChangePasswordSelf'
import { MfaSetup } from '../MfaSetup'
import { AreaTree } from './AreaTree'
import { MobilePillBar } from './MobilePillBar'

export interface MobileAreaAction {
  key: string
  label: string
  icon: LucideIcon
  onClick: () => void
  active?: boolean
  accent?: boolean
  badge?: string
  beta?: boolean
  /** Toggles such as language and theme remain open for immediate feedback. */
  keepOpen?: boolean
}

/** A global action tile in the areas sheet (theme, language, refresh, …). */
export function MobileActionTile({ tile }: { tile: MobileAreaAction }) {
  const orange = 'var(--anthropic-orange)'
  const Icon = tile.icon
  const lit = tile.active || tile.accent
  return (
    <button
      onClick={tile.onClick}
      style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minWidth: 44, minHeight: 64, gap: 6, padding: '11px 4px',
        borderRadius: 12,
        border: `1px solid ${lit ? orange : 'var(--border)'}`,
        background: lit ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
        color: lit ? orange : 'var(--text-primary)',
        cursor: 'pointer', fontFamily: 'inherit',
        fontSize: '0.6875rem', fontWeight: 600,
        transition: 'all 0.15s',
      }}
    >
      <Icon size={19} strokeWidth={1.8} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{tile.label}</span>
      {/* Top-LEFT, so it cannot collide with the count badge on the right. */}
      {tile.beta && <BetaTag what={tile.label} style={{ position: 'absolute', top: 4, left: 5 }} />}
      {tile.badge && (
        <span style={{
          position: 'absolute', top: 4, right: 5,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 15, height: 15, padding: '0 4px', borderRadius: 8,
          background: orange, color: '#fff', fontSize: '0.5625rem', fontWeight: 700,
        }}>
          {tile.badge}
        </span>
      )}
    </button>
  )
}

export function MobileAreaBar({ lang, pathname, badges, attention, onNavigate, actions, principal, visibleSettings }: {
  lang: 'pt' | 'en'
  pathname: string
  badges?: Partial<Record<AreaId, number>>
  attention?: number
  onNavigate: (to: string) => void
  actions: MobileAreaAction[]
  principal?: IamAccount
  visibleSettings?: ReadonlySet<string>
}) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [mfaOpen, setMfaOpen] = useState(false)
  const closeSheet = useCallback(() => { setOpen(false); setAccountOpen(false) }, [])
  useEffect(() => { closeSheet() }, [pathname, closeSheet])
  const go = (to: string) => { closeSheet(); onNavigate(to) }
  const current = areaOfPath(pathname)
  // The prototype (CelBarraLugar): the area quiet, the page bold, a chevron from the icon set.
  const page = current?.page && pageLabel(current.page, lang) !== pageLabel(current.area, lang) ? current.page : null
  const placeText = current
    ? pageLabel(current.area, lang) + (page ? ` › ${pageLabel(page, lang)}` : '')
    : (pt ? 'Navegar' : 'Navigate')
  const place: React.ReactNode = current && page
    ? <><span style={{ color: 'rgba(255,255,255,0.5)' }}>{pageLabel(current.area, lang)} ›</span> <b>{pageLabel(page, lang)}</b></>
    : <b>{placeText}</b>
  // On Sessions the pill already names the place: a round shortcut to the same page is a duplicate.
  const onSessions = isSessionsWorkspace(pathname)
  const sessions = pt ? 'Sessões' : 'Sessions'
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
        variant="place"
        ariaLabel={pt ? 'Navegação principal' : 'Main navigation'}
        activeIndex={0}
        items={[
          { key: 'areas', label: placeText, content: place, ariaLabel: (pt ? 'Ir para · ' : 'Go to · ') + placeText,
            icon: open ? ChevronUp : ChevronDown, onActivate: () => setOpen(v => !v), expanded: open, hasPopup: 'dialog' },
          ...(onSessions ? [] : [{ key: 'sessions', label: sessions, ariaLabel: attention && attention > 0 ? `${sessions}, ${attention} ${pt ? 'precisam de você' : 'need you'}` : sessions,
            icon: MessagesSquare, onActivate: () => go('/sessions'), badge: attention && attention > 0 ? attention : undefined }]),
        ]}
      />
      <BottomSheet open={open} onClose={closeSheet} title={pt ? 'Ir para' : 'Go to'} lang={lang}>
        <div style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <AreaTree lang={lang} pathname={pathname} variant="sheet" badges={badges} onNavigate={go} visibleSettings={visibleSettings} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
            {actions.map(action => <MobileActionTile key={action.key} tile={{ ...action, onClick: () => { if (!action.keepOpen) closeSheet(); action.onClick() } }} />)}
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
