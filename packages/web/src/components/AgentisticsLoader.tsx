import { useEffect, useId, useMemo, useRef, type CSSProperties } from 'react'
import { animateD1, breatheD1, d1Markup, D1_PATHS } from '../lib/d1Loader'

/** The brand logo's five paths, exactly as `branding/logo-no-background.svg` draws them. */
export const AGENTISTICS_LOGO_PATHS = D1_PATHS

type AgentisticsLoaderProps = {
  size?: number
  label?: string
  className?: string
  style?: CSSProperties
}

/**
 * The Agentistics loader — D1 · Clássico, the one the owner chose. Every frame of it comes from
 * `lib/d1Loader.ts`, which the boot splash in `index.html` runs too, so the two cannot differ.
 * The markup is built from constants only, which is why it is set as HTML.
 */
export function AgentisticsLoader({ size = 16, label, className, style }: AgentisticsLoaderProps) {
  const uid = `ag-d1-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const svgRef = useRef<SVGSVGElement>(null)
  const reducedMotion = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, [])
  const accessibleLabel = label ?? (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('pt') ? 'Carregando' : 'Loading')
  const markup = useMemo(() => d1Markup(size, uid, reducedMotion), [size, uid, reducedMotion])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof svg.animate !== 'function') return
    const animations = reducedMotion ? breatheD1(svg) : animateD1(svg)
    // Off screen, the loop pauses — as the prototype's own IntersectionObserver does.
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      if (!entry) return
      animations.forEach(animation => { if (entry.isIntersecting) animation.play(); else animation.pause() })
    })
    observer?.observe(svg)
    return () => { observer?.disconnect(); animations.forEach(animation => animation.cancel()) }
  }, [markup, reducedMotion])

  return (
    <svg ref={svgRef} width={size} height={size} viewBox="0 0 56 56" fill="none" role="status" aria-label={accessibleLabel}
      className={className} style={{ display: 'inline-block', flexShrink: 0, overflow: 'visible', ...style }}
      dangerouslySetInnerHTML={{ __html: markup }} />
  )
}
