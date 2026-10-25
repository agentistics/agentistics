/**
 * PageHeader — the one header every area page draws: crumb, title, ONE status sentence, ≤2 actions
 * (owner's page rules, 2026-10-17). The crumb is read from the registry so it can never disagree with
 * the tree.
 */
import { BetaTag } from '../BetaTag'
import { APP_AREAS, pageLabel, type AreaId } from '../../lib/appAreas'
import { dialogButtonStyle } from '../../pages/settings/primitives'

export interface PageAction { label: string; onClick: () => void; primary?: boolean }

export function PageHeader({ lang, areaId, pageId, title, status, actions = [], isMobile = false }: {
  lang: 'pt' | 'en'; areaId: AreaId; pageId?: string; title?: string; status?: string
  actions?: readonly PageAction[]
  /** Passed by the caller (it already holds `useIsMobile()`); keeps this component renderable without a window. */
  isMobile?: boolean
}) {
  const area = APP_AREAS.find(a => a.id === areaId)!
  const page = area.pages.find(p => p.id === pageId)
  const heading = title ?? (page ? pageLabel(page, lang) : pageLabel(area, lang))
  return (
    // The desktop stats pull-tab hangs inside the page panel above this header.
    <header style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20, paddingTop: isMobile ? 0 : 24, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 280px', minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 2 }}>
          {pageLabel(area, lang)}{page ? <> <span aria-hidden>›</span> {pageLabel(page, lang)}</> : null}
        </div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--text-primary)' }}>{heading}{(area.beta || page?.beta) && <> <BetaTag what={pageLabel(area, lang)} lang={lang} /></>}</h1>
        {status ? <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--text-secondary)' }}>{status}</p> : null}
      </div>
      {actions.slice(0, 2).map(a => (
        <button key={a.label} type="button" onClick={a.onClick} style={dialogButtonStyle(a.primary ? 'primary' : 'secondary', isMobile)}>{a.label}</button>
      ))}
    </header>
  )
}
