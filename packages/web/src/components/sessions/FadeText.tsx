/**
 * FadeText — one line of text that fades out at its right edge ONLY when it really overflows.
 *
 * A mask applied unconditionally eats the last letters of a title that fits exactly (the box shrinks
 * to its text, so the 28px ramp lands on real glyphs). The overflow is measured (`scrollWidth >
 * clientWidth`) on mount, on every text change and whenever the box is resized.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react'

export const FADE_MASK = 'linear-gradient(to right, #000 calc(100% - 28px), transparent calc(100% - 4px))'

/** True while `el`'s content is wider than its box. */
export function useOverflowing<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const measure = () => setOver(el.scrollWidth > el.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dep])
  return { ref, over }
}

export function FadeText({ children, style, as, mask = FADE_MASK, ...rest }: {
  children: ReactNode
  style?: CSSProperties
  as?: ElementType
  mask?: string
  [data: `data-${string}`]: string | boolean | undefined
}) {
  const { ref, over } = useOverflowing<HTMLElement>(children)
  const Tag = (as ?? 'span') as ElementType
  return (
    <Tag
      ref={ref} {...rest}
      data-fade={over ? 'on' : 'off'}
      style={{ whiteSpace: 'nowrap', overflow: 'hidden', ...style, ...(over ? { maskImage: mask, WebkitMaskImage: mask } : null) }}
    >{children}</Tag>
  )
}
