/**
 * TopBarGroup — the ONE grid button in the top bar (TOPBAR.AGRUPAR, owner-approved 07/11).
 *
 * It groups Hardware, Autonomous mode, Vault, Live Delivery and Calls. Hover opens a glass popover under
 * the button (aligned right); keyboard focus opens it too, Esc closes it, and a click toggles it (touch has
 * no hover). On a phone a tap opens the shared bottom sheet instead. NO coloured dots: the button turns
 * orange — the accent border and icon the autonomous-mode button wears — while something in the group is
 * going on, and stays neutral otherwise. The bell stays outside, to the right.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Cpu, LayoutGrid, Phone, Radio, type LucideIcon } from 'lucide-react'
import { AUTONOMOUS_ICON, awayUntilLabel, useAway } from '../../lib/awayMode'
import { useEngineSurfaces } from '../../hooks/useEngineSurfaces'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import { surfacePagePath } from '../../lib/engineSurfaces'
import { useMountedEngineSurfaces } from '../../lib/engineSurfaceHost'
import { useVaultWatch } from '../../lib/vaultWatch'
import { pathOfView } from '../../lib/tasksViewRoute'
import { liveActivity } from '../tasks/liveShortcutModel'
import { BetaTag } from '../BetaTag'
import { BottomSheet } from '../BottomSheet'
import { VaultGlyph } from '../vault/VaultGlyph'
import { surfaceGlyph } from '../EngineSurfaceButtons'
import { groupAccented, groupRows, type GroupRow, type GroupRowId } from './topBarGroupModel'

const HOVER_CLOSE_MS = 180

export function TopBarGroup({ lang, enabled = true, onOpenHardware }: { lang: 'pt' | 'en'; enabled?: boolean; onOpenHardware?: () => void }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const isMobile = useIsMobile()
  const away = useAway()
  const lock = useVaultWatch(enabled).lock
  const { fleet } = useFleet(lang, enabled)
  const act = liveActivity(fleet.sessions)
  const calls = useEngineSurfaces('rail')[0]
  const mounted = useMountedEngineSurfaces()
  const callActive = !!calls && mounted.some(m => m.surface.id === calls.id && m.indicator)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const skipFocusOpen = useRef(false)
  const cancel = () => { if (closeTimer.current) clearTimeout(closeTimer.current) }
  useEffect(() => cancel, [])
  useEffect(() => {
    if (!open || isMobile) return
    // Focus goes back to the button WITHOUT reopening the menu its focus would otherwise open.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); skipFocusOpen.current = true; btn.current?.focus() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile])

  const rows = useMemo(() => groupRows({
    pt, hasHardware: !!onOpenHardware, host: enabled,
    awayActive: away.active && !!away.state, awayUntil: away.state ? awayUntilLabel(away.state, lang, Date.now()) : undefined,
    vault: lock, liveWorking: act.working, liveWaiting: act.waiting,
    callsSurface: calls ? { id: calls.id, label: calls.label[lang], beta: !!calls.beta } : null, callActive,
  }), [pt, lang, onOpenHardware, enabled, away.active, away.state, lock, act.working, act.waiting, calls, callActive])
  if (rows.length === 0) return null

  const accented = groupAccented(rows)
  const go = (id: GroupRowId) => {
    cancel(); setOpen(false)
    if (id === 'hardware') onOpenHardware?.()
    else if (id === 'autonomous') navigate('/leadership/away')
    else if (id === 'vault') navigate('/vault')
    else if (id === 'live') navigate(pathOfView('live'))
    else if (calls) navigate(surfacePagePath(calls.id))
  }
  const label = pt ? 'Atalhos da barra' : 'Bar shortcuts'
  const full = accented ? `${label} — ${rows.filter(r => r.active).map(r => `${r.label}: ${r.state}`).join('; ')}` : label
  const enter = () => { if (isMobile) return; cancel(); setOpen(true) }
  const leave = () => { if (isMobile) return; cancel(); closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS) }
  const glyph = (id: GroupRowId): LucideIcon | null => id === 'hardware' ? Cpu : id === 'autonomous' ? AUTONOMOUS_ICON : id === 'live' ? Radio
    : id === 'calls' ? (surfaceGlyph(calls?.icon) ?? Phone) : null
  const hrefOf = (id: GroupRowId): string | undefined => id === 'autonomous' ? '/leadership/away' : id === 'vault' ? '/vault'
    : id === 'live' ? pathOfView('live') : id === 'calls' && calls ? surfacePagePath(calls.id) : undefined
  const rowEls = rows.map(r => <GroupRowButton key={r.id} row={r} Icon={glyph(r.id)} lang={lang} onGo={() => go(r.id)} sheet={isMobile}
    href={hrefOf(r.id)} current={hrefOf(r.id) !== undefined && pathname === hrefOf(r.id)} />)

  const button = (
    <button ref={btn} type="button" className="ag-tap-icon" data-topbar-group data-accent={accented ? 'true' : undefined}
      aria-label={full} title={full} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(v => !v)}
      onFocus={e => { if (isMobile) return; if (skipFocusOpen.current) { skipFocusOpen.current = false; return }; let visible = false; try { visible = e.currentTarget.matches(':focus-visible') } catch { /* keep closed */ } if (visible) enter() }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
        border: `1px solid ${accented ? 'var(--anthropic-orange)' : 'var(--border)'}`, background: 'transparent',
        color: accented ? 'var(--anthropic-orange)' : open ? 'var(--text-primary)' : 'var(--text-tertiary)',
      }}>
      <LayoutGrid size={15} aria-hidden />
    </button>
  )
  if (isMobile) {
    return (
      <>
        {button}
        <BottomSheet open={open} onClose={() => setOpen(false)} title={label} lang={lang}>
          <div style={{ padding: '4px 8px 12px', overflowY: 'auto' }}>{rowEls}</div>
        </BottomSheet>
      </>
    )
  }
  return (
    <div style={{ position: 'relative', display: 'flex' }} onMouseEnter={enter} onMouseLeave={leave}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave() }}>
      {button}
      {open && (
        <div role="menu" data-portalled-menu data-topbar-group-popover aria-label={label}
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 900, minWidth: 268, padding: 6, boxSizing: 'border-box',
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.45)',
          }}>
          {rowEls}
        </div>
      )}
    </div>
  )
}

function GroupRowButton({ row, Icon, lang, onGo, sheet, href, current }: { row: GroupRow; Icon: LucideIcon | null; lang: 'pt' | 'en'; onGo: () => void; sheet: boolean; href?: string; current: boolean }) {
  const style: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', border: 0, borderRadius: 8, background: 'transparent',
    padding: '0 10px', minHeight: sheet ? 48 : 38, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', textDecoration: 'none',
    color: 'var(--text-primary)',
  }
  const common = {
    role: sheet ? undefined : 'menuitem', 'data-group-row': row.id, 'data-active': row.active ? 'true' : undefined,
    ...(row.surfaceId ? { 'data-engine-rail': row.surfaceId } : {}), style,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--ag-tint-3, rgba(127,127,127,.12))' },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'transparent' },
  }
  const Tag = href ? 'a' : 'button'
  return (
    <Tag {...common} {...(href ? { href, 'aria-current': current ? 'page' as const : undefined, title: row.label, onClick: (e: React.MouseEvent) => { e.preventDefault(); onGo() } } : { type: 'button' as const, onClick: onGo })}>
      <span style={{ display: 'flex', flexShrink: 0, color: row.active ? 'var(--anthropic-orange)' : 'var(--text-secondary)' }}>
        {row.id === 'vault' ? <VaultGlyph size={16} /> : Icon ? <Icon size={16} aria-hidden /> : null}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{row.label}</span>
      {row.beta && <BetaTag what={row.label} lang={lang} />}
      <span style={{ marginLeft: 'auto', paddingLeft: 12, fontSize: 11.5, color: row.active ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{row.state}</span>
    </Tag>
  )
}
