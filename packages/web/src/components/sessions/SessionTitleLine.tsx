import { useLayoutEffect, useRef, useState } from 'react'

export const TAB_TITLE_BUDGET = 28
const FADE_WIDTH = 16
const FADE_TAIL = 8
const FADE = `linear-gradient(to right, #000 calc(100% - ${FADE_WIDTH}px), transparent)`

function cappedTitle(title: string, budget: number): string {
  const chars = Array.from(title)
  if (chars.length <= budget) return title
  const prefix = chars.slice(0, budget).join('')
  const boundary = prefix.search(/\s+\S*$/u)
  return (boundary > 0 && !/^\s/u.test(chars[budget]!) ? prefix.slice(0, boundary) : prefix).trimEnd()
}

/** Tabs fit whole words into their actual chrome; menus retain the complete title. */
export function SessionTitleLine({ title, budget, menu = false, opacity = 1 }: { title: string; budget?: number; menu?: boolean; opacity?: number }) {
  const initial = budget === undefined ? title : cappedTitle(title, budget)
  const [fit, setFit] = useState({ title, text: initial })
  const shown = fit.title === title ? fit.text : initial
  const ref = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const tab = budget === undefined ? null : el.closest<HTMLElement>('[data-session-tab]')
    const measure = () => {
      if (!tab) { setClipped(el.scrollWidth > el.clientWidth); return }
      // Desktop's cap is independent of the current intrinsic width, so shortening a title
      // shrinks the tab without causing a resize/shorten feedback loop. Mobile fills its track.
      const css = getComputedStyle(tab)
      const cap = css.maxWidth.endsWith('px') ? parseFloat(css.maxWidth) : tab.clientWidth
      if (!cap) return // DOM-only tests have no layout.
      const siblings = Array.from(tab.children).filter(child => child !== el.parentElement)
      const chrome = siblings.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
        + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + parseFloat(css.columnGap) * siblings.length
      const available = cap - chrome
      const probe = document.createElement('span')
      const textStyle = getComputedStyle(el)
      Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'nowrap', font: textStyle.font, letterSpacing: textStyle.letterSpacing })
      document.body.appendChild(probe)
      const width = (text: string) => { probe.textContent = text; return probe.getBoundingClientRect().width }
      let text = initial
      // Reserve a short fade tail too, keeping the complete final word inside the box.
      // Half the gradient covers text; the last glyph retains at least half its opacity.
      while (text && width(text) + (text !== title ? FADE_TAIL : 0) > available) {
        const boundary = text.search(/\s+\S+$/u)
        text = boundary > 0 ? text.slice(0, boundary) : Array.from(text).slice(0, -1).join('')
      }
      probe.remove()
      setFit(previous => previous.title === title && previous.text === text ? previous : { title, text })
    }
    measure()
    let disposed = false
    void document.fonts?.ready.then(() => { if (!disposed) measure() })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(tab ?? el)
    if (tab) observer?.observe(el)
    return () => { disposed = true; observer?.disconnect() }
  }) // Re-measure after active/hover/role changes alter the surrounding tab chrome or font.
  const fade = shown !== title || clipped ? FADE : undefined
  return <span style={{ flex: budget === undefined ? 1 : '0 0 auto', minWidth: 0, opacity, overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: 1.35 }}>
    <span ref={ref} data-session-title data-menu-title={menu ? true : undefined} title={title} style={{
      display: 'inline-block', maxWidth: budget === undefined ? '100%' : undefined, verticalAlign: 'bottom', whiteSpace: 'nowrap', overflow: 'hidden',
      paddingRight: budget !== undefined && shown !== title ? FADE_TAIL : undefined,
      maskImage: fade, WebkitMaskImage: fade,
    }}>{shown}</span>
  </span>
}
