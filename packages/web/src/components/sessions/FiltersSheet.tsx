/**
 * FiltersSheet — the filters, on a phone, out of the way until asked for.
 *
 * The mobile sessions page used to spend a fixed band of a 664px viewport on a filter row that is
 * consulted occasionally and read never. A sheet costs nothing until it is opened, and opened it
 * has the whole screen — which is the only place these controls have ever had enough room.
 *
 * It is the SAME `FiltersBar` in `compact` mode, passed in as children, not a second
 * implementation: the dimensions, the pickers and the chips are one control everywhere, and a
 * phone-only copy would drift.
 *
 * There is deliberately no "Apply". `FiltersBar` writes straight through to the shared filter
 * state, so every change is already live behind the sheet — a button promising to apply what is
 * applied is a button that teaches people the filters do not take until they press it. The footer
 * says `Done`, which is what it does, beside a `Clear` that is absent when there is nothing to
 * clear.
 */

import { BottomSheet } from '../BottomSheet'

export function FiltersSheet({ open, onClose, onClear, lang, children }: {
  open: boolean
  onClose: () => void
  onClear?: () => void
  lang: 'pt' | 'en'
  children: React.ReactNode
}) {
  const pt = lang === 'pt'
  return (
    <BottomSheet open={open} onClose={onClose} title={pt ? 'Filtros' : 'Filters'} lang={lang} footer={
      <footer style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', flexShrink: 0,
          borderTop: '1px solid var(--border)',
        }}>
          {onClear && (
            <button
              onClick={onClear}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 44, padding: '0 16px', borderRadius: 9,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 14,
                fontWeight: 600, cursor: 'pointer',
              }}
            >
              {pt ? 'Limpar' : 'Clear'}
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              minHeight: 44, borderRadius: 9, border: 'none',
              background: 'var(--anthropic-orange)', color: '#fff',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {pt ? 'Pronto' : 'Done'}
          </button>
      </footer>
    }>
      {children}
    </BottomSheet>
  )
}
