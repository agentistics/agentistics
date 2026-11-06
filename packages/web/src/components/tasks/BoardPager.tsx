/**
 * BoardPager — prev / next and the page-size choice under a board column or a list band.
 *
 * The page size is ONE preference for the whole board (`BoardPrefs.pageSize`), so changing it in
 * any column changes every column. Drawn only when the rows do not fit one page, except that the
 * size choice stays reachable from a `showSize` pager so it is never hidden behind a full column.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { BOARD_PAGE_SIZES, type BoardPage, type BoardPageSize } from './boardPaging'

export function BoardPager(p: {
  info: BoardPage
  pageSize: number
  lang?: 'pt' | 'en'
  onPage: (page: number) => void
  onPageSize: (n: BoardPageSize) => void
  /** Compact (a kanban column ~280px wide) wraps the size chips under the arrows. */
  compact?: boolean
}) {
  const pt = p.lang === 'pt'
  const h = 26
  const btn = (disabled: boolean): React.CSSProperties => ({
    display: 'inline-grid', placeItems: 'center', minWidth: 26, height: h, padding: 0,
    borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
    fontFamily: 'inherit',
  })
  const { info } = p
  // Under the smallest size there is nothing to page and nothing to choose.
  if (info.total <= BOARD_PAGE_SIZES[0]) return null
  return (
    <div
      data-board-pager
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 2px', fontSize: 11, color: 'var(--text-tertiary)' }}
    >
      {info.paged && (
        <>
          <button type="button" className="ag-tap-icon" aria-label={pt ? 'Página anterior' : 'Previous page'} disabled={info.page === 0}
            onClick={() => p.onPage(info.page - 1)} style={btn(info.page === 0)}><ChevronLeft size={13} /></button>
          <span style={{ whiteSpace: 'nowrap' }}>{info.start + 1}–{info.end} {pt ? 'de' : 'of'} {info.total}</span>
          <button type="button" className="ag-tap-icon" aria-label={pt ? 'Próxima página' : 'Next page'} disabled={info.page >= info.pageCount - 1}
            onClick={() => p.onPage(info.page + 1)} style={btn(info.page >= info.pageCount - 1)}><ChevronRight size={13} /></button>
        </>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: p.compact ? 0 : 'auto', flexWrap: 'wrap' }}>
        <span>{pt ? 'por página' : 'per page'}</span>
        {BOARD_PAGE_SIZES.map(n => (
          <button
            key={n} type="button" className="ag-tap" aria-pressed={p.pageSize === n} onClick={() => p.onPageSize(n)}
            style={{
              ...btn(false), padding: '0 6px', fontSize: 11,
              borderColor: p.pageSize === n ? 'var(--anthropic-orange)' : 'var(--border)',
              color: p.pageSize === n ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
            }}
          >{n}</button>
        ))}
      </span>
    </div>
  )
}
