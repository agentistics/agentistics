/**
 * NayUpdateCard.tsx — "a new version is here — Install now / Remind me later", said by the Nay
 * window, Notion-style: it never blocks the page.
 *
 * Three placements, one card:
 *  - `dock`   — inside the open Nay window, under its header (the chat the person is already in);
 *  - `float`  — spoken by the Nay button while the window is closed, placed with the same
 *               `cardPlacement` the session cards use (beside the button, or its corner when the
 *               button is hidden);
 *  - `corner` — the same, for a page where the Nay dock is not offered at all (chat switched off).
 *
 * Every rule is `updateToast.ts`: when it shows, how long it stays (`promptTimeoutMs`, paused
 * while the pointer or the keyboard is on it, with a regressive bar), and what leaving does
 * (`promptExit`: everything but "install" leaves the news in the bell; "remind me later" also
 * snoozes per person). "Install now" is the one `startUpgrade`.
 *
 * Owner rule: no command, no terminal hint. In the UI, updating is the button only.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { brandAsset } from '../../lib/brand'
import { ut } from '../../lib/updateI18n'
import { promptTimeoutMs, type PromptExit, type VersionAnswer } from '../../lib/updateToast'
import { cardPlacement, cardWidth } from '../../lib/nayNotify'
import { getFabLive, subscribeFabLive } from '../../lib/nayFabLive'
import { FAB_SIZE } from '../../lib/nayFab'

export type UpdateCardPlacement = 'dock' | 'float' | 'corner'

export interface NayUpdateCardProps {
  lang: Lang
  isMobile: boolean
  info: Pick<VersionAnswer, 'current' | 'latest' | 'critical'>
  placement: UpdateCardPlacement
  onExit: (exit: PromptExit) => void
  zIndex?: number
}

function bottomInset(isMobile: boolean): number {
  if (!isMobile) return 0
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-nav-h'))
  return Number.isFinite(v) ? v : 0
}

export function NayUpdateCard({ lang, isMobile, info, placement, onExit, zIndex = 1200 }: NayUpdateCardProps) {
  const critical = info.critical === true
  const total = promptTimeoutMs(critical)
  const ref = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [engaged, setEngaged] = useState(false)
  const remaining = useRef(total)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const floating = placement !== 'dock'

  // It leaves by itself — into the bell — unless somebody is using it. Hover/focus pauses the bar
  // and the clock; leaving resumes from where they stopped.
  useEffect(() => {
    const bar = barRef.current
    if (bar) bar.style.transform = `scaleX(${remaining.current / total})`
    if (engaged) return
    const from = remaining.current
    const started = performance.now()
    const anim = bar?.animate?.([{ transform: `scaleX(${from / total})` }, { transform: 'scaleX(0)' }], { duration: from, easing: 'linear', fill: 'forwards' })
    const t = window.setTimeout(() => onExit('timeout'), from)
    return () => {
      window.clearTimeout(t)
      remaining.current = Math.max(0, from - (performance.now() - started))
      anim?.cancel()
      if (bar) bar.style.transform = `scaleX(${remaining.current / total})`
    }
  }, [engaged, total, onExit])

  // Floating: placed beside the Nay button (or its corner), measured once the card has a size.
  useLayoutEffect(() => {
    if (!floating) return
    const place = () => {
      const card = ref.current
      if (!card) return
      // The button's LIVE position first (it is placed by a transform that settles after mount, so
      // a DOM read on the first frame can still see it at the origin); the DOM rect otherwise.
      const fabEl = placement === 'float' ? document.querySelector<HTMLElement>('[data-nay-fab]') : null
      const r = fabEl?.getBoundingClientRect()
      const l = fabEl && r && r.width > 0 ? getFabLive() : null
      const fab = l ? { x: l.x, y: l.y, w: FAB_SIZE, h: FAB_SIZE } : r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
      const p = cardPlacement({
        fab,
        vpW: window.innerWidth, vpH: window.innerHeight,
        cardW: card.offsetWidth, cardH: card.offsetHeight, bottomInset: bottomInset(isMobile),
      })
      setPos({ left: p.left, top: p.top })
    }
    place()
    // Again once layout has settled, and whenever the button moves (dragged, or changing sides).
    const settle = window.setTimeout(place, 350)
    const unsub = placement === 'float' ? subscribeFabLive(place) : () => {}
    window.addEventListener('resize', place)
    return () => { window.clearTimeout(settle); unsub(); window.removeEventListener('resize', place) }
  }, [floating, placement, isMobile])

  const width = floating ? cardWidth(typeof window === 'undefined' ? 400 : window.innerWidth, isMobile) : undefined

  return (
    <div
      ref={ref}
      role="region"
      aria-label={ut(lang, 'prompt.title')}
      data-testid="nay-update-card"
      data-placement={placement}
      className="ag-upd-card"
      onPointerEnter={() => setEngaged(true)}
      onPointerLeave={() => setEngaged(false)}
      onFocus={() => setEngaged(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEngaged(false) }}
      style={{
        ...(floating
          ? {
              position: 'fixed', zIndex, width, left: pos?.left ?? -9999, top: pos?.top ?? -9999,
              boxShadow: '0 16px 40px rgba(0,0,0,0.38), 0 2px 8px rgba(0,0,0,0.2)', borderRadius: 14,
            }
          : { position: 'relative', margin: isMobile ? '8px 10px 2px' : '8px 10px 2px', borderRadius: 12, flexShrink: 0 }),
        background: 'var(--bg-surface)',
        border: `1px solid ${critical ? 'color-mix(in srgb, var(--accent-red) 45%, var(--border))' : 'color-mix(in srgb, var(--anthropic-orange) 40%, var(--border))'}`,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', gap: 10, padding: '12px 12px 10px 12px' }}>
        <img src={brandAsset('/minimalistLogo.png')} alt="" style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--anthropic-orange)' }}>
              {ut(lang, 'prompt.eyebrow')}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999, fontVariantNumeric: 'tabular-nums',
              background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)',
            }}>
              {ut(lang, 'prompt.from_to', { from: info.current, to: info.latest })}
            </span>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', marginTop: 4, lineHeight: 1.35 }}>
            {ut(lang, 'prompt.title')}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
            {ut(lang, 'prompt.body')}
          </p>
          {critical && (
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-red)', margin: '6px 0 0', lineHeight: 1.45 }}>
              {ut(lang, 'prompt.critical')}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label={ut(lang, 'prompt.close')}
          onClick={() => onExit('close')}
          className="ag-tap-icon"
          style={{
            alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)',
            width: 28, height: 28, margin: '-4px -4px 0 0', position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, flexShrink: 0,
          }}
        >
          <X size={15} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px 52px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => onExit('install')} style={{
          // @touch-intentional — the popup's primary action: a full button, painted at finger size on a phone.
          display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: isMobile ? 44 : 32, padding: '0 14px', borderRadius: 8,
          border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700,
          background: 'var(--anthropic-orange)', color: '#fff',
        }}>
          <ArrowUpCircle size={14} /> {ut(lang, 'prompt.install')}
        </button>
        <button type="button" onClick={() => onExit('later')} style={{
          // @touch-intentional — the popup's second action, a full button beside the first.
          minHeight: isMobile ? 44 : 32, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 12.5, fontWeight: 600, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        }}>
          {ut(lang, 'prompt.later')}
        </button>
      </div>
      {/* The time left before it moves to the bell — no number, a bar along the foot. */}
      <div aria-hidden style={{ height: 2, background: 'var(--border)' }}>
        <div ref={barRef} style={{ height: '100%', background: 'var(--anthropic-orange)', transformOrigin: 'left center' }} />
      </div>
    </div>
  )
}
