/**
 * nayNotifyAnim.ts — how the Nay button "speaks" a card, and its shock when a session replies.
 *
 * The four entrances the owner picked from (the design artifact of 2026-09-29, `launch` the
 * default), written with the Web Animations API on the real card and on short-lived elements in a
 * fixed layer that ignores the pointer — so an effect can never catch a click meant for the page.
 *
 * Every entrance starts from the BUTTON: the card's transform origin is the button's centre
 * (`CardPlacement.originX/Y`), which is what makes each one read as the button talking rather than a
 * toast appearing next to it. `prefers-reduced-motion` turns all of them into a short fade and the
 * shock into a colour change, and the button still says which card is new.
 *
 * Nothing here decides anything; `nayNotify.ts` places the card, this module only moves it.
 */

import type { CardPlacement, NayAnimation } from './nayNotify'

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

type Running = { cancel(): void }

function fxLayer(): HTMLElement {
  let el = document.getElementById('ag-nay-fx')
  if (!el) {
    el = document.createElement('div')
    el.id = 'ag-nay-fx'
    el.setAttribute('aria-hidden', 'true')
    Object.assign(el.style, { position: 'fixed', inset: '0', zIndex: '302', pointerEvents: 'none' })
    document.body.appendChild(el)
  }
  return el
}

function temp(style: Partial<CSSStyleDeclaration>): HTMLElement {
  const el = document.createElement('div')
  Object.assign(el.style, { position: 'absolute', ...style })
  fxLayer().appendChild(el)
  return el
}

function after(a: Animation, fn: () => void): void {
  a.finished.then(fn, fn)
}

/** Children marked `data-rise` come up in a short cascade after the card has arrived. */
function rise(card: HTMLElement, delay: number, out: Running[]): void {
  card.querySelectorAll<HTMLElement>('[data-rise]').forEach((el, i) => {
    out.push(el.animate(
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 260, delay: delay + i * 55, easing: 'ease-out', fill: 'backwards' },
    ))
  })
}

/**
 * Bring the card in. `card` is already in its final place; `fab` is the button's body, or null
 * when the button is not on screen (the card then simply fades up where the button would be).
 * Returns a cancel for a card that is replaced mid-entrance.
 */
export function playEnter(kind: NayAnimation, card: HTMLElement, fab: HTMLElement | null, p: CardPlacement, reduced: boolean): () => void {
  const run: Running[] = []
  const cleanup: (() => void)[] = []
  const cancel = () => { run.forEach(a => { try { a.cancel() } catch { /* already gone */ } }); cleanup.forEach(f => f()) }
  if (reduced || typeof card.animate !== 'function') {
    run.push(card.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160 }) ?? { cancel() {} })
    return cancel
  }
  const box = card.getBoundingClientRect()
  const fr = fab?.getBoundingClientRect() ?? null
  if (!fr) {
    run.push(card.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' }))
    rise(card, 120, run)
    return cancel
  }
  const fx = fr.left + fr.width / 2, fy = fr.top + fr.height / 2

  if (kind === 'balloon') {
    run.push(fab!.animate([{ scale: '1' }, { scale: '.88', offset: 0.35 }, { scale: '1.12', offset: 0.62 }, { scale: '1' }], { duration: 440, easing: 'ease-out' }))
    run.push(card.animate(
      [{ transform: 'scale(.12)', opacity: 0 }, { transform: 'scale(1.04)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 480, delay: 170, easing: 'cubic-bezier(.2,.9,.3,1.15)', fill: 'backwards' },
    ))
    rise(card, 360, run)
    return cancel
  }

  if (kind === 'unfurl') {
    const m = temp({
      left: `${fr.left}px`, top: `${fr.top}px`, width: `${fr.width}px`, height: `${fr.height}px`,
      border: '1.5px solid var(--anthropic-orange)', background: 'var(--bg-surface)', borderRadius: '16px',
      boxShadow: '0 14px 36px rgba(0,0,0,.34)',
    })
    cleanup.push(() => m.remove())
    run.push(fab!.animate([{ scale: '1' }, { scale: '.92' }, { scale: '1' }], { duration: 500 }))
    const grow = m.animate([
      { left: `${fr.left}px`, top: `${fr.top}px`, width: `${fr.width}px`, height: `${fr.height}px`, borderRadius: '16px' },
      { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: '14px' },
    ], { duration: 420, easing: 'cubic-bezier(.3,.7,.1,1)', fill: 'forwards' })
    run.push(grow)
    run.push(card.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' }))
    rise(card, 420, run)
    after(grow, () => after(m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }), () => m.remove()))
    return cancel
  }

  if (kind === 'voice') {
    const ang = Math.atan2(box.top + box.height / 2 - fy, box.left + box.width / 2 - fx)
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '-90 -90 180 180')
    Object.assign(svg.style, {
      position: 'absolute', left: `${fx - 90}px`, top: `${fy - 90}px`, width: '180px', height: '180px',
      overflow: 'visible', transform: `rotate(${ang}rad)`,
    })
    for (const r of [38, 52, 66]) {
      const a = 0.55, path = document.createElementNS(ns, 'path')
      path.setAttribute('d', `M ${r * Math.cos(-a)} ${r * Math.sin(-a)} A ${r} ${r} 0 0 1 ${r * Math.cos(a)} ${r * Math.sin(a)}`)
      Object.assign(path.style, { fill: 'none', stroke: 'var(--anthropic-orange-light)', strokeWidth: '2.5', strokeLinecap: 'round', opacity: '0' })
      svg.appendChild(path)
    }
    fxLayer().appendChild(svg)
    cleanup.push(() => svg.remove())
    const waves = Array.from(svg.querySelectorAll('path')).map((path, i) =>
      path.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 520, delay: i * 110, iterations: 2 }))
    run.push(...waves)
    after(waves[waves.length - 1]!, () => svg.remove())
    run.push(fab!.animate([
      { scale: '1 1' }, { scale: '1.06 .9' }, { scale: '.96 1.05' }, { scale: '1.06 .9' }, { scale: '.98 1.03' }, { scale: '1.06 .92' }, { scale: '1 1' },
    ], { duration: 620, easing: 'ease-in-out' }))
    const dx = -Math.cos(ang) * 28, dy = -Math.sin(ang) * 28
    run.push(card.animate(
      [{ opacity: 0, transform: `translate(${dx}px,${dy}px) scale(.96)` }, { opacity: 1, transform: 'none' }],
      { duration: 360, delay: 300, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
    ))
    // The line the button "says" is typed out. The full text is in the DOM from the start (the
    // screen reader hears it whole); only its visible length is animated.
    const say = card.querySelector<HTMLElement>('[data-say]')
    if (say) {
      const full = say.textContent ?? ''
      let i = 0
      say.style.clipPath = 'inset(0 100% 0 0)'
      const step = () => {
        i++
        say.style.clipPath = `inset(0 ${100 - (i / Math.max(1, full.length)) * 100}% 0 0)`
        if (i < full.length) t = window.setTimeout(step, 22)
      }
      let t = window.setTimeout(step, 420)
      cleanup.push(() => { window.clearTimeout(t); say.style.clipPath = '' })
      window.setTimeout(() => { say.style.clipPath = '' }, 420 + full.length * 22 + 60)
    }
    rise(card, 560, run)
    return cancel
  }

  // launch — the default: the button recoils and throws a spark in an arc; where it lands, the
  // card opens in a circle.
  const tx = box.left + Math.max(24, Math.min(box.width - 24, p.originX))
  const ty = p.tailSide === 'bottom' ? box.bottom - 24 : box.top + 24
  const lift = p.tailSide === 'bottom' ? 80 : -80
  const mx = (fx + tx) / 2, my = (fy + ty) / 2 - lift
  const cxp = Math.abs(tx - fx) < 40 ? mx - (fx > window.innerWidth / 2 ? 90 : -90) : mx
  const dot = temp({
    left: '0', top: '0', width: '14px', height: '14px', marginLeft: '-7px', marginTop: '-7px', borderRadius: '50%',
    background: 'var(--anthropic-orange-light)', boxShadow: '0 0 14px var(--anthropic-orange)',
  })
  cleanup.push(() => dot.remove())
  const kf: Keyframe[] = []
  for (let k = 0; k <= 16; k++) {
    const t = k / 16, u = 1 - t
    const x = u * u * fx + 2 * u * t * cxp + t * t * tx
    const y = u * u * fy + 2 * u * t * my + t * t * ty
    kf.push({ transform: `translate(${x}px,${y}px) scale(${1 - 0.3 * Math.sin(Math.PI * t)})` })
  }
  const ux = tx - fx, uy = ty - fy, len = Math.hypot(ux, uy) || 1
  run.push(fab!.animate([
    { translate: '0 0', scale: '1' }, { translate: `${-ux / len * 7}px ${-uy / len * 7}px`, scale: '.93', offset: 0.3 }, { translate: '0 0', scale: '1' },
  ], { duration: 360, easing: 'ease-out' }))
  const fly = dot.animate(kf, { duration: 430, easing: 'cubic-bezier(.45,0,.35,1)', fill: 'forwards' })
  run.push(fly)
  after(fly, () => dot.remove())
  const ring = temp({
    left: `${tx - 28}px`, top: `${ty - 28}px`, width: '56px', height: '56px', borderRadius: '50%',
    border: '2px solid var(--anthropic-orange)', opacity: '0',
  })
  cleanup.push(() => ring.remove())
  const burst = ring.animate([{ opacity: 0.8, transform: 'scale(.2)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 420, delay: 410, easing: 'ease-out' })
  run.push(burst)
  after(burst, () => ring.remove())
  const cx = tx - box.left, cy = ty - box.top, r = Math.hypot(box.width, box.height)
  run.push(card.animate(
    [{ clipPath: `circle(0px at ${cx}px ${cy}px)` }, { clipPath: `circle(${r}px at ${cx}px ${cy}px)` }],
    { duration: 460, delay: 400, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
  ))
  rise(card, 520, run)
  return cancel
}

/** The card goes back INTO the button. Resolves when it is gone, so the caller can unmount it. */
export function playExit(card: HTMLElement, fab: HTMLElement | null, reduced: boolean): Promise<void> {
  if (typeof card.animate !== 'function') return Promise.resolve()
  if (reduced) return card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).finished.then(() => {}, () => {})
  fab?.animate([{ scale: '1' }, { scale: '1.1', offset: 0.7 }, { scale: '1' }], { duration: 300, delay: 120 })
  return card.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.1)', opacity: 0 }], {
    duration: 230, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards',
  }).finished.then(() => {}, () => {})
}

/**
 * The shock the owner chose for "a session replied": the button squashes and two rings leave it.
 * Reduced motion keeps only a brief tint, so the reply is still announced without movement.
 */
export function playShock(fab: HTMLElement, reduced: boolean): void {
  if (typeof fab.animate !== 'function') return
  if (reduced) {
    fab.animate([{ background: 'var(--anthropic-orange-dim)' }, { background: 'var(--bg-surface)' }], { duration: 600 })
    return
  }
  const r = fab.getBoundingClientRect()
  fab.animate([
    { scale: '1 1' }, { scale: '1.2 .84', offset: 0.18 }, { scale: '.9 1.1', offset: 0.42 }, { scale: '1.04 .97', offset: 0.7 }, { scale: '1 1' },
  ], { duration: 620, easing: 'ease-out' })
  for (const delay of [0, 140]) {
    const ring = temp({
      left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: '16px',
      border: '2px solid var(--anthropic-orange)', opacity: '0',
    })
    after(ring.animate([{ opacity: 0.75, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(2.6)' }], {
      duration: 700, delay, easing: 'cubic-bezier(.2,.7,.3,1)',
    }), () => ring.remove())
  }
}
