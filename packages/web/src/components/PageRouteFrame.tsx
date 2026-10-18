import React from 'react'

/** Keep routed pages mounted when the viewport changes the surrounding scroll layout. */
export function PageRouteFrame({ compact, scrollRef, maxWidth, before, footer, children }: {
  compact: boolean
  scrollRef: React.Ref<HTMLDivElement>
  maxWidth: React.CSSProperties['maxWidth']
  before?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  return <div ref={scrollRef} data-page-scroller={compact ? undefined : true}
    style={compact ? { display: 'contents' } : { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
    <div style={compact ? { display: 'contents' } : {
      maxWidth, margin: '0 auto', width: '100%', boxSizing: 'border-box', padding: '24px 32px',
      minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 20,
    }}>
      {before}
      {children}
    </div>
    {!compact && footer}
  </div>
}
