/**
 * AreaRail — the app's areas as a 60px column of icons, drawn beside the sessions list in the
 * Sessões area (APP.AREAS Task 4, prototype `ASessoesColuna`). It replaces the Painel/Sessões
 * switch: every area is one click away without leaving the list, and the full tree is one more
 * ("show tree"), opened as a panel anchored to the rail's right edge.
 *
 * Icons and the tooltip come from `AreaTree` — one icon per area, never a second map. Ajustes is not
 * on the rail: the panel's own footer carries the settings shortcut, and the tree lists its sections.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ListTree } from 'lucide-react'
import { APP_AREAS, areaOfPath, pageLabel, type AreaId } from '../../lib/appAreas'
import { useEscapeOwner } from '../../lib/overlayStack'
import { ATTN_COUNT_CLASS } from './AttentionDot'
import { AREA_ICON, AreaTree, Tip, areaEntryPath, rememberAreaPath } from './AreaTree'

export const AREA_RAIL_W = 60

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

  const icon: React.CSSProperties = {
    position: 'relative', width: 40, height: 40, borderRadius: 9, border: 'none', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontFamily: 'inherit',
    textDecoration: 'none',
  }

  return (
    <div style={{ position: 'relative', display: 'flex', flexShrink: 0, minHeight: 0 }}>
      <nav
        aria-label={pt ? 'Áreas do app' : 'App areas'}
        data-area-rail
        style={{
          width: AREA_RAIL_W, boxSizing: 'border-box', flexShrink: 0, minHeight: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 0',
          border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-surface)', overflowY: 'auto',
        }}
      >
        {APP_AREAS.filter(a => a.id !== 'settings').map(area => {
          const label = pageLabel(area, lang)
          const active = current === area.id
          const n = badges[area.id]
          const to = areaEntryPath(area)
          const name = n ? `${label}, ${n} ${area.id === 'sessions' ? (pt ? 'precisam de você' : 'need you') : (pt ? 'avisos' : 'alerts')}` : label
          return (
            <Tip key={area.id} label={label} show>
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
                  <span className={ATTN_COUNT_CLASS} style={{
                    position: 'absolute', top: 2, right: 1, minWidth: 15, height: 15, padding: '0 4px', borderRadius: 8,
                    boxSizing: 'border-box', background: 'var(--anthropic-orange)', color: '#fff', fontSize: 9.5, fontWeight: 700,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>{n}</span>
                ) : null}
              </a>
            </Tip>
          )
        })}
        <span style={{ flex: 1 }} />
        <Tip label={treeLabel} show={!treeOpen}>
          <button
            type="button"
            aria-label={treeLabel}
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
      </nav>
      {treeOpen && (
        <div
          id="ag-area-rail-tree"
          role="dialog"
          aria-label={pt ? 'Árvore de áreas' : 'Area tree'}
          style={{
            position: 'absolute', top: 0, bottom: 0, left: AREA_RAIL_W + 6, width: 280, zIndex: 260,
            boxSizing: 'border-box', padding: '10px 8px', overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-surface)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          }}
        >
          <AreaTree lang={lang} pathname={pathname} badges={badges} visibleSettings={visibleSettings}
            onNavigate={to => { setTreeOpen(false); (onNavigate ?? navigate)(to) }} />
        </div>
      )}
    </div>
  )
}
