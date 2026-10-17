/**
 * AreaTree — the app's navigation tree, rendered from the area registry.
 *
 * Desktop aside (`variant="aside"`) and the mobile sheet (`variant="sheet"`, larger targets) are the
 * same tree. Only the area holding the current URL is expanded; clicking another area goes to the page
 * last visited inside it (remembered per area in sessionStorage), else its first page.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useNavigate } from 'react-router-dom'
import { BarChart3, ChevronRight, ClipboardList, Crown, Gauge, GitBranch, Lock, SlidersHorizontal, Terminal } from 'lucide-react'
import {
  APP_AREAS, areaOfPath, firstPath, pageLabel, searchAreas, type Area, type AreaIcon, type AreaId,
} from '../../lib/appAreas'
import { BetaTag } from '../BetaTag'
import { FieldInput } from '../../pages/settings/primitives'
import { ATTN_COUNT_CLASS } from './AttentionDot'
import { areaOpenStore, isAreaOpen, openedArea, toggledAreaOpen } from '../../lib/areaOpen'

export const AREA_ICON: Record<AreaIcon, (size: number) => React.ReactNode> = {
  terminal: s => <Terminal size={s} />,
  clipboard: s => <ClipboardList size={s} />,
  crown: s => <Crown size={s} />,
  gauge: s => <Gauge size={s} />,
  chart: s => <BarChart3 size={s} />,
  git: s => <GitBranch size={s} />,
  lock: s => <Lock size={s} />,
  settings: s => <SlidersHorizontal size={s} />,
}

const LAST_KEY = 'ag-area-last:'

export function rememberAreaPath(pathname: string): void {
  const hit = areaOfPath(pathname)
  if (!hit) return
  try { sessionStorage.setItem(LAST_KEY + hit.area.id, pathname) } catch { /* private window */ }
}

function recalled(id: AreaId): string | null {
  try { return sessionStorage.getItem(LAST_KEY + id) } catch { return null }
}

/** Themed hover tooltip for the icons-only state. */
function Tip({ label, show, children }: { label: string; show: boolean; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  if (!show) return <>{children}</>
  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setPos({ top: r.top + r.height / 2, left: r.right + 10 }) }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && typeof document !== 'undefined' && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-50%)',
          background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '5px 10px', fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)', zIndex: 500, pointerEvents: 'none',
        }}>{label}</div>,
        document.body,
      )}
    </div>
  )
}

function Badge({ n }: { n: number }) {
  return (
    <span
      className={ATTN_COUNT_CLASS}
      style={{
        marginLeft: 'auto', minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, boxSizing: 'border-box',
        background: 'var(--anthropic-orange)', color: '#fff', fontSize: 11, fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >{n}</span>
  )
}

export interface AreaTreeProps {
  lang: 'pt' | 'en'
  pathname: string
  collapsed?: boolean
  variant?: 'aside' | 'sheet'
  badges?: Partial<Record<AreaId, number>>
  onNavigate?: (to: string) => void
  /** Settings section ids this viewer may see (`visibleSettingsSections`). Absent = all of them. */
  visibleSettings?: ReadonlySet<string>
}

const GROUP_HEADING = { personal: { pt: 'Pessoal', en: 'Personal' }, governance: { pt: 'Governança', en: 'Governance' } } as const

export function AreaTree({ lang, pathname, collapsed = false, variant = 'aside', badges = {}, onNavigate, visibleSettings }: AreaTreeProps) {
  const navigate = useNavigate()
  const go = (to: string) => { rememberAreaPath(to); (onNavigate ?? navigate)(to) }
  const sheet = variant === 'sheet'
  const pt = lang === 'pt'
  const current = areaOfPath(pathname)
  const openMap = useSyncExternalStore(areaOpenStore.subscribe, areaOpenStore.get, areaOpenStore.serverSnapshot)
  const [query, setQuery] = useState('')
  const results = searchAreas(query, lang).filter(r => r.area.id !== 'settings' || !visibleSettings || visibleSettings.has(r.page.id))
  const pagesOf = (area: Area) => area.id === 'settings' && visibleSettings ? area.pages.filter(p => visibleSettings.has(p.id)) : area.pages
  useEffect(() => { rememberAreaPath(pathname) }, [pathname])

  const areaRow = (area: Area) => {
    const label = pageLabel(area, lang)
    const active = current?.area.id === area.id
    const n = badges[area.id]
    const to = firstPath(area, recalled(area.id))
    const hasPages = pagesOf(area).length > 0
    const expanded = hasPages && isAreaOpen(openMap, area.id, active)
    return (
      <Tip key={area.id} label={label} show={collapsed}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
        <a
          href={to}
          aria-label={collapsed ? label : undefined}
          aria-current={active && !area.pages.length ? 'page' : undefined}
          onClick={e => { e.preventDefault(); if (hasPages) areaOpenStore.set(openedArea(openMap, area.id)); go(to) }}
          style={{
            display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, boxSizing: 'border-box', flex: 1,
            minHeight: sheet ? 46 : 40, padding: collapsed ? '0' : '0 12px',
            justifyContent: collapsed ? 'center' : 'flex-start', borderRadius: 10, textDecoration: 'none',
            fontSize: '0.8438rem', fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
            color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
            background: active && !area.pages.length ? 'var(--anthropic-orange-dim)' : 'transparent',
          }}
        >
          <span style={{ flexShrink: 0, display: 'flex', position: 'relative' }}>
            {AREA_ICON[area.icon](17)}
            {collapsed && n ? <span aria-hidden style={{ position: 'absolute', top: -3, right: -4, width: 8, height: 8, borderRadius: 4, background: 'var(--anthropic-orange)' }} /> : null}
          </span>
          {!collapsed && label}
          {!collapsed && area.beta && <BetaTag what={label} style={{ marginLeft: 4 }} />}
          {!collapsed && n ? <Badge n={n} /> : null}
        </a>
        {!collapsed && hasPages && (
          <button
            type="button" aria-expanded={expanded}
            aria-label={(expanded ? (pt ? 'Recolher ' : 'Collapse ') : (pt ? 'Expandir ' : 'Expand ')) + label}
            onClick={() => areaOpenStore.set(toggledAreaOpen(openMap, area.id, active))}
            style={{
              flexShrink: 0, width: sheet ? 44 : 28, height: sheet ? 44 : 28, display: 'flex', alignItems: 'center',
              justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'var(--text-tertiary)', borderRadius: 8,
            }}
          >
            <ChevronRight size={14} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
          </button>
        )}
        </div>
      </Tip>
    )
  }

  const body = query.trim() ? (
    <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {results.length === 0 && (
        <p style={{ margin: 0, padding: '8px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>
          {pt ? 'Nada encontrado.' : 'Nothing found.'}
        </p>
      )}
      {results.map(({ area, page }) => (
        <a
          key={area.id + page.id} role="listitem" href={page.path}
          onClick={e => { e.preventDefault(); setQuery(''); go(page.path) }}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, minHeight: sheet ? 44 : 34, padding: '0 12px',
            borderRadius: 8, textDecoration: 'none', fontSize: '0.8125rem', color: 'var(--text-secondary)',
          }}
        >
          <span style={{ display: 'flex', flexShrink: 0 }}>{AREA_ICON[area.icon](15)}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>{pageLabel(area, lang)}</span>
          <span aria-hidden>›</span>
          <span style={{ color: 'var(--text-primary)' }}>{pageLabel(page, lang)}</span>
        </a>
      ))}
    </div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {APP_AREAS.map(area => (
        <div key={area.id}>
          {areaRow(area)}
          {!collapsed && isAreaOpen(openMap, area.id, current?.area.id === area.id) && pagesOf(area).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, margin: '2px 0 6px 22px', borderLeft: '1px solid var(--border)' }}>
              {pagesOf(area).map((page, i, list) => {
                const active = current?.area.id === area.id && current.page?.id === page.id
                return (
                  <div key={page.id}>
                    {page.group && page.group !== list[i - 1]?.group && (
                      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', padding: '8px 12px 3px' }}>
                        {GROUP_HEADING[page.group][lang]}
                      </div>
                    )}
                    <NavLink
                      to={page.path} end
                      aria-current={active ? 'page' : undefined}
                      onClick={() => rememberAreaPath(page.path)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box',
                        minHeight: sheet ? 44 : 32, padding: '0 12px', marginLeft: -1,
                        borderLeft: `2px solid ${active ? 'var(--anthropic-orange)' : 'transparent'}`,
                        textDecoration: 'none', fontSize: '0.8125rem', fontWeight: active ? 700 : 500,
                        color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                        background: active ? 'var(--anthropic-orange-dim)' : 'transparent',
                        borderRadius: '0 8px 8px 0',
                      }}
                    >{pageLabel(page, lang)}</NavLink>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <nav aria-label={pt ? 'Áreas do app' : 'App areas'} style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      {!collapsed && (
        <div
          id="ag-area-search"
          style={{ margin: '0 2px' }}
          onKeyDown={e => {
            if (e.key === 'Escape') { setQuery(''); return }
            if (e.key === 'Enter' && results[0]) { const to = results[0].page.path; setQuery(''); go(to) }
          }}
        >
          <FieldInput
            label={pt ? 'Buscar página' : 'Find page'} value={query} onChange={setQuery}
            hideLabel placeholder={pt ? 'Buscar  Ctrl K' : 'Search  Ctrl K'} autoComplete="off" spellCheck={false}
          />
        </div>
      )}
      {body}
    </nav>
  )
}
