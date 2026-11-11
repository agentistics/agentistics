import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/** Keep the scrollbar at the card edge while preserving the content's inset. */
export function PlanUsageScroll({ children, lang, embedded = false }: { children: ReactNode; lang: 'pt' | 'en'; embedded?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measure = () => {
    const el = scrollRef.current
    setMore(!!el && !embedded && el.scrollHeight - el.clientHeight - el.scrollTop > 1)
  }
  useLayoutEffect(() => {
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (scrollRef.current) observer?.observe(scrollRef.current)
    if (contentRef.current) observer?.observe(contentRef.current)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [children, embedded])
  const advance = () => {
    const el = scrollRef.current
    if (!el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-plan-scroll-item]'))
    const itemHeight = items.reduce((sum, item) => sum + item.getBoundingClientRect().height + 4, 0) / items.length
    const height = itemHeight > 0 ? itemHeight : el.clientHeight
    const count = Math.max(1, Math.round(el.clientHeight / height))
    el.scrollBy({ top: Math.min(count * height, el.scrollHeight - el.clientHeight - el.scrollTop), behavior: 'smooth' })
  }
  return <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', ...(embedded ? {} : { flex: '1 1 auto', minHeight: 0, marginRight: -10 }) }}>
    <div ref={scrollRef} data-plan-usage-scroll className="ag-scroll" onScroll={measure} style={{ ...(embedded ? {} : { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }) }}>
      <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingRight: embedded ? 0 : 10, paddingBottom: embedded ? 0 : 26 }}>{children}</div>
    </div>
    {more && <button type="button" data-plan-scroll-more aria-label={lang === 'pt' ? 'Rolar para mais contas' : 'Scroll to more accounts'} onClick={advance}
      style={{ position: 'absolute', bottom: 4, left: '50%', transform: 'translateX(-50%)', width: 44, height: 44, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 0, border: 0, background: 'transparent', color: 'var(--anthropic-orange)', cursor: 'pointer' }}>
      <ChevronDown size={16} aria-hidden style={{ background: 'var(--bg-card)', borderRadius: 8 }} />
    </button>}
  </div>
}
