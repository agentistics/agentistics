/**
 * LiveOdometer — a number whose changed digits roll up from below (~450 ms), like an odometer.
 * Only the digits that differ move; the rest stay put. With prefers-reduced-motion it just changes.
 * Pure presentation: the value and the colour come in.
 */

import { useEffect, useRef, useState } from 'react'

const ROLL_MS = 450
const reduced = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

/** PURE: per character of `next`, the character it replaces (or null when it did not change). */
export function rollPlan(prev: string, next: string): { char: string; from: string | null }[] {
  const width = Math.max(prev.length, next.length)
  const p = prev.padStart(width, ' '), n = next.padStart(width, ' ')
  return [...n].map((char, i) => ({ char, from: p[i] === char ? null : p[i]! }))
}

export function LiveOdometer({ value, color, suffix = '%' }: { value: number; color?: string; suffix?: string }) {
  const text = `${value}${suffix}`
  const prev = useRef(text)
  const [plan, setPlan] = useState(() => rollPlan(text, text))
  const [moving, setMoving] = useState(false)
  useEffect(() => {
    if (prev.current === text) return
    setPlan(rollPlan(prev.current, text))
    prev.current = text
    if (reduced()) { setMoving(false); return }
    setMoving(false)
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setMoving(true)))
    const done = setTimeout(() => setPlan(rollPlan(text, text)), ROLL_MS + 80)
    return () => { cancelAnimationFrame(raf); clearTimeout(done) }
  }, [text])
  return (
    <b data-live-odo={text} aria-label={text} style={{ display: 'inline-flex', fontSize: 13, color, fontVariantNumeric: 'tabular-nums' }}>
      {plan.map((d, i) => (
        <span key={i} aria-hidden style={{ position: 'relative', display: 'inline-block', overflow: 'hidden', lineHeight: 1.3, whiteSpace: 'pre' }}>
          {d.from === null ? <span>{d.char}</span> : (
            <>
              <span style={{ display: 'inline-block', transition: `transform ${ROLL_MS}ms ease`, transform: moving ? 'translateY(-110%)' : 'none' }}>{d.from === ' ' ? ' ' : d.from}</span>
              <span style={{ position: 'absolute', left: 0, top: 0, transition: `transform ${ROLL_MS}ms ease`, transform: moving ? 'translateY(0)' : 'translateY(110%)' }}>{d.char === ' ' ? '' : d.char}</span>
            </>
          )}
        </span>
      ))}
    </b>
  )
}
