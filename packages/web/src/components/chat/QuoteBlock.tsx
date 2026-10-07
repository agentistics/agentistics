/**
 * QuoteBlock — one quoted passage, drawn the way a markdown `>` blockquote is drawn in a bubble.
 *
 * ONE component for the two places a reply quote appears: the SENT bubble (`ChatBubble`) and the
 * quote stack above the composer's field (`SessionChat`). They used to differ — the bubble drew a
 * blockquote with "show more", while the composer typed raw `> …` text into the textarea — and the
 * person saw two different things for the same quote. The look is the existing `.ag-chat-md
 * blockquote` rule, never a new one.
 *
 * Collapsed to two lines by a CSS clamp (a single long line wraps past two as easily as three short
 * ones), and the "show more" control appears only when the clamp actually hid something — a toggle
 * on a one-line quote is a control that does nothing. Clicking the passage goes to its source
 * (`onOpen`); `onRemove`, when given, adds the × the composer needs.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'

const COLLAPSED_LINES = 2

export function QuoteBlock({ text, pt, onOpen, onRemove }: {
  /** The passage, WITHOUT the `> ` prefixes. */
  text: string
  pt: boolean
  onOpen?: () => void
  onRemove?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // A phone gets the 44px touch target for the ×; a desktop keeps the small control.
  const isMobile = useIsMobile()
  const removeSize = isMobile ? 44 : 22

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => {
      if (expanded) return
      setClipped(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])

  const markdown = text.split('\n').map(line => `> ${line}`).join('\n')
  const toggle = clipped || expanded
  return (
    <div className="ag-chat-md" style={{ position: 'relative', minWidth: 0 }}>
      {toggle && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          style={{
            display: 'block', padding: 0, border: 0, textAlign: 'left',
            background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
            font: 'inherit', fontSize: 11.5, lineHeight: 1.4,
          }}
        >
          <span style={{ marginRight: 8, color: 'var(--anthropic-orange)' }}>↪</span>
          {expanded ? (pt ? 'ver menos' : 'show less') : (pt ? 'ver mais' : 'show more')}
        </button>
      )}
      <div
        role={onOpen ? 'button' : undefined}
        tabIndex={onOpen ? 0 : undefined}
        onClick={onOpen}
        onKeyDown={onOpen ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } } : undefined}
        title={onOpen ? (pt ? 'Ir para a mensagem citada' : 'Go to the quoted message') : undefined}
        style={{ cursor: onOpen ? 'pointer' : undefined, paddingRight: onRemove ? removeSize + 4 : 0 }}
      >
        <div
          ref={bodyRef}
          style={expanded ? undefined : {
            // Two lines of the blockquote's own line box, plus its 2px top/bottom padding.
            maxHeight: `calc(${COLLAPSED_LINES} * 1.65em + 4px)`, overflow: 'hidden',
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{
              blockquote: ({ children }) => <blockquote style={{ margin: 0 }}>{children}</blockquote>,
              p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
            }}
          >{markdown}</ReactMarkdown>
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={pt ? 'Remover citação' : 'Remove quote'}
          title={pt ? 'Remover citação' : 'Remove quote'}
          style={{
            position: 'absolute', top: Math.max(0, (toggle ? 18 : 0) - (isMobile ? 11 : 0)), right: 0,
            width: removeSize, height: removeSize, display: 'grid', placeItems: 'center',
            padding: 0, border: 0, borderRadius: 6, cursor: 'pointer',
            background: 'transparent', color: 'var(--text-tertiary)',
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
