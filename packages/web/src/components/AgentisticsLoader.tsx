import { useEffect, useId, useMemo, useRef, type CSSProperties } from 'react'

export const AGENTISTICS_LOGO_PATHS = {
  shell: 'M14.5 42.75L13.9004 42.2998L8.5 38.249V14.8652L28.6504 3.23145L48.8018 14.8662V38.1328L28.6094 49.791L23.5068 47.166L22.6943 46.748L21.9502 47.2783L14.5 52.5879V42.75Z',
  earRight: 'M54 37.0665L50 39.2002V20.2002L54 22.664V37.0665Z',
  earLeft: 'M3 36.8663L7 39V20L3 22.4638V36.8663Z',
  eyeLeft: 'M16 26.5L20 19.5L24 26.5',
  eyeRight: 'M33 26.5L37 19.5L41 26.5',
} as const

const ORANGE = '#FD8924'
const HARNESS = ['#D97757', '#10A37F', '#4E86F7', '#A371F7']
const EASING = 'cubic-bezier(.5,0,.2,1)'

type AgentisticsLoaderProps = {
  size?: number
  label?: string
  className?: string
  style?: CSSProperties
}

const clamp = (value: number) => Math.min(.995, Math.max(.002, value))

function flickKeyframes(at: number, width: number, flashes: number) {
  const keyframes: Keyframe[] = [{ opacity: 0 }, { offset: clamp(at - width), opacity: 0 }]
  for (let index = 0; index < flashes; index += 1) {
    const start = at - width + index * width / flashes
    const opacity = index % 2 ? 0 : 1
    keyframes.push(
      { offset: clamp(start + .002), opacity },
      { offset: clamp(start + width / flashes - .002), opacity },
    )
  }
  keyframes.push({ offset: clamp(at), opacity: 0 }, { opacity: 0 })
  return keyframes
}

function animateForever(element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  return element.animate(keyframes, { ...options, iterations: Infinity })
}

export function AgentisticsLoader({ size = 16, label, className, style }: AgentisticsLoaderProps) {
  const uid = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const reducedMotion = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const accessibleLabel = label ?? (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('pt') ? 'Carregando' : 'Loading')
  const cells = size >= 40 ? 10 : 7

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || reducedMotion) return
    const animations: Animation[] = []
    const duration = 3800
    const tailNodes = Array.from(svg.querySelectorAll<SVGPathElement>('[data-loader-tail]'))
    const length = tailNodes[0]?.getTotalLength() ?? 0
    const dash = length * .035

    tailNodes.forEach((tail, index) => {
      const opacity = 1 - index * .19
      tail.style.strokeDasharray = `${dash} ${3 * length}`
      animations.push(animateForever(tail, [
        { strokeDashoffset: dash + index * length * .03, opacity: 0 },
        { offset: .08, strokeDashoffset: dash + index * length * .03, opacity, easing: EASING },
        { offset: .42, strokeDashoffset: dash + index * length * .03 - length, opacity },
        { offset: .46, strokeDashoffset: dash + index * length * .03 - length, opacity: 0 },
        { strokeDashoffset: dash + index * length * .03 - length, opacity: 0 },
      ], { duration }))
    })

    const pixels = Array.from(svg.querySelectorAll<SVGRectElement>('[data-loader-pixel]'))
    const flashes = Array.from(svg.querySelectorAll<SVGRectElement>('[data-loader-flash]'))
    pixels.forEach((pixel, index) => {
      const order = Number(pixel.dataset.order ?? 0)
      const start = clamp(.16 + order * .34 + Math.random() * .03)
      const end = clamp(.86 + order * .08 + Math.random() * .02)
      animations.push(animateForever(pixel, [
        { opacity: 0 }, { offset: start, opacity: 0 }, { offset: clamp(start + .004), opacity: 1 },
        { offset: end, opacity: 1 }, { offset: clamp(end + .004), opacity: 0 }, { opacity: 0 },
      ], { duration }))
      if (flashes[index]) animations.push(animateForever(flashes[index], flickKeyframes(start, .09, 4), { duration }))
    })

    const halo = svg.querySelector<SVGPathElement>('[data-loader-halo]')
    if (halo) animations.push(animateForever(halo, [
      { opacity: 0 }, { offset: .5, opacity: 0 }, { offset: .53, opacity: .7 }, { offset: .72, opacity: 0 }, { opacity: 0 },
    ], { duration }))

    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      if (!entry) return
      animations.forEach(animation => { if (entry.isIntersecting) animation.play(); else animation.pause() })
    })
    observer?.observe(svg)
    return () => { observer?.disconnect(); animations.forEach(animation => animation.cancel()) }
  }, [reducedMotion])

  const grid = Array.from({ length: cells * cells }, (_, index) => {
    const x = index % cells
    const y = Math.floor(index / cells)
    const side = 56 / cells
    const angle = ((Math.atan2((y + .5) * side - 28, (x + .5) * side - 28) * 180 / Math.PI - 132 + 720) % 360) / 360
    return { x, y, order: Math.min(1, angle), fill: HARNESS[(x * 7 + y * 3) % HARNESS.length] }
  })

  return (
    <svg ref={svgRef} width={size} height={size} viewBox="0 0 56 56" fill="none" role="status" aria-label={accessibleLabel}
      className={className} style={{ display: 'inline-block', flexShrink: 0, overflow: 'visible', ...style }}>
      <style>{`@keyframes agentistics-loader-breath-${uid}{0%,100%{opacity:.55}50%{opacity:1}}`}</style>
      <defs>
        <filter id={`agentistics-loader-glow-${uid}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3.2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <mask id={`agentistics-loader-mask-${uid}`} maskUnits="userSpaceOnUse" x="-10" y="-10" width="76" height="76">
          {grid.map(cell => <rect key={`${cell.x}-${cell.y}`} data-loader-flash={cell.order} x={cell.x * 56 / cells} y={cell.y * 56 / cells} width={56 / cells + .06} height={56 / cells + .06} fill={cell.fill} opacity="0" data-order={cell.order} />)}
        </mask>
      </defs>
      <g opacity={reducedMotion ? 1 : .1} style={reducedMotion ? { animation: `agentistics-loader-breath-${uid} 3s ease-in-out infinite` } : undefined}>
        <path d={AGENTISTICS_LOGO_PATHS.shell} fill="none" stroke={ORANGE} strokeWidth="3" />
        <path d={AGENTISTICS_LOGO_PATHS.earRight} fill={ORANGE} /><path d={AGENTISTICS_LOGO_PATHS.earLeft} fill={ORANGE} />
        <path d={AGENTISTICS_LOGO_PATHS.eyeLeft} fill="none" stroke={ORANGE} strokeWidth="2" /><path d={AGENTISTICS_LOGO_PATHS.eyeRight} fill="none" stroke={ORANGE} strokeWidth="2" />
      </g>
      <g mask={`url(#agentistics-loader-mask-${uid})`}>
        {grid.map(cell => <rect key={`pixel-${cell.x}-${cell.y}`} data-loader-pixel x={cell.x * 56 / cells} y={cell.y * 56 / cells} width={56 / cells + .06} height={56 / cells + .06} fill={ORANGE} opacity="0" data-order={cell.order} />)}
      </g>
      <path data-loader-halo d={AGENTISTICS_LOGO_PATHS.shell} fill="none" stroke={ORANGE} strokeWidth="3" filter={`url(#agentistics-loader-glow-${uid})`} opacity="0" />
      {Array.from({ length: 5 }, (_, index) => <path key={index} data-loader-tail d={AGENTISTICS_LOGO_PATHS.shell} fill="none" stroke={index === 0 ? '#fff6ec' : '#fff3e3'} strokeWidth="3" strokeLinecap="round" filter={`url(#agentistics-loader-glow-${uid})`} opacity={reducedMotion ? 0 : undefined} />)}
      {size >= 40 && Array.from({ length: 8 }, (_, index) => <circle key={index} r=".8" fill="#ffd9b3" opacity="0" />)}
    </svg>
  )
}
