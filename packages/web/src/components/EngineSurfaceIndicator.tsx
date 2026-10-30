import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useIsMobile } from '../hooks/useIsMobile'
import { endEngineSurfaceIndicator, resumeEngineSurface, useMountedEngineSurfaces, type OpenSurface } from '../lib/engineSurfaceHost'
import { formatIndicatorElapsed, surfacePagePath } from '../lib/engineSurfaces'
import { surfaceGlyph } from './EngineSurfaceButtons'

/**
 * The top-bar pills of the engine surfaces that set an indicator (`ctx.setIndicator`), drawn beside the
 * other header pills on every screen while the surface is mounted — on screen or kept alive off it.
 * Clicking one brings its surface back: a `rail` page by navigating to its route, a session surface by
 * opening the session that owns it, in the layout it had. On a phone the pill is compact (icon and timer,
 * the label kept as its accessible name) so it never crowds the bar or covers the navigation.
 */
export function EngineSurfaceIndicators({ lang, tickMs = 1000 }: { lang: 'pt' | 'en'; tickMs?: number }) {
  const list = useMountedEngineSurfaces().filter(s => s.indicator)
  if (list.length === 0) return null
  return <>{list.map(s => <Pill key={s.nonce} open={s} lang={lang} tickMs={tickMs} />)}</>
}

function Pill({ open, lang, tickMs }: { open: OpenSurface; lang: 'pt' | 'en'; tickMs: number }) {
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const ind = open.indicator!
  const since = ind.since
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(t)
  }, [since, tickMs])
  const label = ind.label[lang]
  const elapsed = since !== undefined ? formatIndicatorElapsed(since, now) : null
  const Glyph = surfaceGlyph(ind.icon)
  const fill = ind.tone === 'danger' ? 'var(--accent-red)' : 'var(--anthropic-orange)'
  const back = () => {
    if (open.surface.placement === 'rail') { navigate(surfacePagePath(open.surface.id)); return }
    if (open.sessionId) navigate(`/sessions/${encodeURIComponent(open.sessionId)}`)
    resumeEngineSurface(open.nonce)
  }
  const height = mobile ? 30 : 28
  return (
    <span data-engine-indicator={open.surface.id} data-tone={ind.tone ?? 'accent'}
      style={{ display: 'inline-flex', alignItems: 'center', flexShrink: mobile ? 1 : 0, minWidth: 0, maxWidth: mobile ? '100%' : 280, height, borderRadius: height / 2, background: fill, color: '#fff', overflow: 'hidden' }}>
      <button type="button" onClick={back}
        aria-label={elapsed ? `${label}, ${elapsed}` : label} title={label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, height: '100%', padding: mobile ? '0 10px' : '0 12px',
          border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
          ...(mobile ? { minHeight: 30 } : {}),
        }}>
        {Glyph && <Glyph size={13} aria-hidden />}
        {!mobile && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>}
        {elapsed && <span data-engine-indicator-time aria-hidden style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.9 }}>{elapsed}</span>}
      </button>
      {ind.endLabel && (
        <button type="button" onClick={() => endEngineSurfaceIndicator(open.nonce)} data-engine-indicator-end
          aria-label={ind.endLabel[lang]} title={ind.endLabel[lang]}
          style={{
            height: '100%', padding: '0 10px', border: 'none', borderLeft: '1px solid rgba(255,255,255,0.35)',
            background: 'rgba(0,0,0,0.15)', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
          {ind.endLabel[lang]}
        </button>
      )}
    </span>
  )
}
