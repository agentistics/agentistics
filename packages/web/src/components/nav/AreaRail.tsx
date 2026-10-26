/**
 * AreaRail — the app's areas as a 60px column of icons, drawn beside the sessions list in the
 * Sessões area (APP.AREAS Task 4, prototype `ASessoesColuna`). It replaces the Painel/Sessões
 * switch: every area is one click away without leaving the list. The button at its foot WIDENS this
 * same bar (icons gain their labels and sections, drawn by `AreaTree`) — one bar, never a second
 * column beside it; closing folds it back to icons.
 *
 * Icons and the tooltip come from `AreaTree` — one icon per area, never a second map. Ajustes is not
 * on the rail: the panel's own footer carries the settings shortcut, and the tree lists its sections.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BetaTag } from '../BetaTag'
import { ListTree } from 'lucide-react'
import { APP_AREAS, areaOfPath, pageLabel, type AreaId } from '../../lib/appAreas'
import { useEscapeOwner } from '../../lib/overlayStack'
import { SOLID_COUNT } from './countBadge'
import { AREA_ICON, AreaTree, Tip, areaEntryPath, rememberAreaPath } from './AreaTree'

export const AREA_RAIL_W = 60
/** The width the same bar takes when opened: icons plus their labels and sections. */
export const AREA_RAIL_OPEN_W = 264

export interface AreaRailProps {
  lang: 'pt' | 'en'
  pathname: string
  badges?: Partial<Record<AreaId, number>>
  onNavigate?: (to: string) => void
  /** Settings section ids this viewer may see — handed to the tree panel. */
  visibleSettings?: ReadonlySet<string>
  /** Opens the tree panel on the first render (tests). */
  initialTreeOpen?: boolean
}

export function AreaRail({ lang, pathname, badges = {}, onNavigate, visibleSettings, initialTreeOpen = false }: AreaRailProps) {
  const navigate = useNavigate()
  const pt = lang === 'pt'
  const [treeOpen, setTreeOpen] = useState(initialTreeOpen)
  const current = areaOfPath(pathname)?.area.id
  // Navigating anywhere closes the tree panel: it answered "where to", and the answer was given.
  useEffect(() => { setTreeOpen(false) }, [pathname])
  useEscapeOwner(treeOpen, () => setTreeOpen(false))
  const go = (to: string) => { rememberAreaPath(to); (onNavigate ?? navigate)(to) }
  const treeLabel = pt ? 'Mostrar a árvore de áreas' : 'Show the area tree'
  const closeLabel = pt ? 'Recolher a barra de áreas' : 'Collapse the area bar'

  const icon: React.CSSProperties = {
    position: 'relative', width: 40, height: 40, borderRadius: 9, border: 'none', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontFamily: 'inherit',
    textDecoration: 'none',
  }

  // A pointer-only preference read once per render: with reduced motion the bar just snaps.
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  return (
    // The host keeps the closed width in the layout; the bar widens OVER the list beside it, so
    // opening it never reflows (or squeezes) the Sessões panel.
    <div style={{ position: 'relative', display: 'flex', flexShrink: 0, minHeight: 0, width: AREA_RAIL_W }}>
      <nav
        aria-label={pt ? 'Áreas do app' : 'App areas'}
        data-area-rail
        data-open={treeOpen ? 'true' : 'false'}
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: treeOpen ? 260 : 1,
          width: treeOpen ? AREA_RAIL_OPEN_W : AREA_RAIL_W, boxSizing: 'border-box',
          transition: reduced ? 'none' : 'width 150ms ease-out',
          display: 'flex', flexDirection: 'column', alignItems: treeOpen ? 'stretch' : 'center', gap: 4, padding: '8px 0',
          border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-surface)', overflow: 'hidden',
          boxShadow: treeOpen ? '0 12px 32px rgba(0,0,0,0.35)' : 'none',
        }}
      >
        {treeOpen ? (
          <div id="ag-area-rail-tree" className="ag-noscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '0 8px' }}>
            <AreaTree lang={lang} pathname={pathname} badges={badges} visibleSettings={visibleSettings}
              onNavigate={to => { setTreeOpen(false); (onNavigate ?? navigate)(to) }} />
          </div>
        ) : (
          <>
            {APP_AREAS.filter(a => a.id !== 'settings').map(area => {
              const label = pageLabel(area, lang)
              const active = current === area.id
              const n = badges[area.id]
              const to = areaEntryPath(area)
              // The badge's count named in words, per area: what it counts is different in each.
              const what = area.id === 'sessions' ? (pt ? 'precisam de você' : 'need you')
                : area.id === 'usage' ? (pt ? 'acima do ritmo' : 'over pace')
                : (pt ? 'avisos' : 'alerts')
              const name = n ? `${label}, ${n} ${what}` : label
              return (
                <Tip key={area.id} label={<>{label}{area.beta && <> <BetaTag what={label} lang={lang} /></>}</>} show>
                  <a
                    href={to}
                    aria-label={name}
                    aria-current={active ? 'page' : undefined}
                    onClick={e => { e.preventDefault(); go(to) }}
                    style={{
                      ...icon,
                      color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                      background: active ? 'var(--anthropic-orange-dim)' : 'transparent',
                    }}
                  >
                    {AREA_ICON[area.icon](18)}
                    {n ? (
                      <span data-area-badge style={{
                        position: 'absolute', top: 2, right: 1, minWidth: 15, height: 15, padding: '0 4px', borderRadius: 8,
                        boxSizing: 'border-box', ...SOLID_COUNT, fontSize: 9.5, fontWeight: 700,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      }}>{n}</span>
                    ) : null}
                  </a>
                </Tip>
              )
            })}
            <span style={{ flex: 1 }} />
          </>
        )}
        <div style={{ display: 'flex', justifyContent: treeOpen ? 'flex-start' : 'center', padding: treeOpen ? '0 10px' : 0, flexShrink: 0 }}>
          <Tip label={treeLabel} show={!treeOpen}>
            <button
              type="button"
              aria-label={treeOpen ? closeLabel : treeLabel}
              aria-expanded={treeOpen}
              aria-controls="ag-area-rail-tree"
              onClick={() => setTreeOpen(o => !o)}
              style={{
                ...icon,
                color: treeOpen ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                background: treeOpen ? 'var(--anthropic-orange-dim)' : 'transparent',
              }}
            >
              <ListTree size={18} />
            </button>
          </Tip>
        </div>
      </nav>
    </div>
  )
}
