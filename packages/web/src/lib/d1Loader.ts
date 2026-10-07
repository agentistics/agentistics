/**
 * d1Loader.ts — THE loader: option "D1 · Clássico" of the owner's loaders-v5 prototype
 * (agentistics-workspace/leader/prototypes/loaders-v5.html), ported line for line.
 *
 * The comet leaves the speech tail and runs once round the shell; right behind it every block of a
 * 10×10 grid (7×7 under 40px) flickers in the harness colours and locks into orange; the decoded
 * logo flares (halo), holds, and dissolves again before the loop restarts. Prototype parameters:
 * `decodeSvg(px, {order:'ang', comets:5, sparks:true})`, `cometAnim(el, 3800, .08, .42, 'fwd')`,
 * `decodeAnim(el, {dur:3800, a0:.16, span:.34, outStart:.86, outSpan:.08})`, `halo(el, 3800, .5, .7)`.
 * D1 never calls `sparksAt`, so its eight spark circles exist and stay invisible — kept, for parity.
 *
 * WHY THIS FILE HAS NO IMPORTS. It is the single source for BOTH the React `AgentisticsLoader` and
 * the pre-React boot splash in `index.html`. The splash cannot wait for the app bundle (that is the
 * whole point of it), so `vite.config.ts` strips the types off this file plus `boot/preboot.ts` and
 * serves the pair as one tiny classic script. An import here would break that build, and
 * `prebootScript.test.ts` fails if one appears. Two copies of the animation would drift — which is
 * how the shipped loader stopped being the one the owner chose.
 *
 * The logo paths and stroke widths are the brand file's (`branding/logo-no-background.svg`), never
 * altered; `AgentisticsLoader.test.tsx` pins them.
 */

export const D1_DURATION = 3800

export const D1_PATHS = {
  shell: 'M14.5 42.75L13.9004 42.2998L8.5 38.249V14.8652L28.6504 3.23145L48.8018 14.8662V38.1328L28.6094 49.791L23.5068 47.166L22.6943 46.748L21.9502 47.2783L14.5 52.5879V42.75Z',
  earRight: 'M54 37.0665L50 39.2002V20.2002L54 22.664V37.0665Z',
  earLeft: 'M3 36.8663L7 39V20L3 22.4638V36.8663Z',
  eyeLeft: 'M16 26.5L20 19.5L24 26.5',
  eyeRight: 'M33 26.5L37 19.5L41 26.5',
} as const

/** The brand amber. A central draws its mark in its own teal; `d1Markup` takes that as `accent`. */
export const D1_ACCENT = '#FD8924'
const HARNESS = ['#D97757', '#10A37F', '#4E86F7', '#A371F7']
const E = 'cubic-bezier(.5,0,.2,1)'
const COMETS = 5

const clamp = (v: number) => Math.min(.995, Math.max(.002, v))

/** The prototype's `facePaint`: the whole logo in one paint. */
function facePaint(p: string): string {
  return `<path d="${D1_PATHS.shell}" style="fill:none;stroke:${p};stroke-width:3"/>`
    + `<path d="${D1_PATHS.earRight}" style="fill:${p}"/><path d="${D1_PATHS.earLeft}" style="fill:${p}"/>`
    + `<path d="${D1_PATHS.eyeLeft}" style="fill:none;stroke:${p};stroke-width:2"/><path d="${D1_PATHS.eyeRight}" style="fill:none;stroke:${p};stroke-width:2"/>`
}

const glow = (id: string, sd: number) =>
  `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${sd}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
const maskOf = (id: string, inner: string) =>
  `<mask id="${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="76" height="76">${inner}</mask>`

/** 0 at the speech tail, growing clockwise — the way the comet runs (the prototype's `angOf`). */
export function d1Order(cx: number, cy: number): number {
  return Math.min(1, ((Math.atan2(cy - 28, cx - 28) * 180 / Math.PI - 132 + 720) % 360) / 360)
}

/** Blocks per side: the prototype's `px >= 40 ? 10 : 7`. */
export const d1Cells = (px: number) => (px >= 40 ? 10 : 7)

/**
 * The SVG's inner markup (viewBox 0 0 56 56) for a loader drawn at `px`. `id` must be unique on the
 * page: it prefixes the filter and mask ids. Built from constants only — nothing user-supplied.
 * `still` draws the logo at rest, for reduced motion (it then only breathes). `accent` replaces the
 * amber only (a central's teal); the harness colours and the white comet are D1's own.
 */
export function d1Markup(px: number, id: string, still = false, accent: string = D1_ACCENT): string {
  const O = accent
  if (still) return facePaint(O)
  const n = d1Cells(px), s = 56 / n
  let gate = '', flick = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const k = d1Order((x + .5) * s, (y + .5) * s)
    const r = (kind: string, fill: string) => `<rect data-d1="${kind}" data-k="${k.toFixed(3)}" x="${x * s}" y="${y * s}" width="${s + .06}" height="${s + .06}" fill="${fill}" opacity="0"/>`
    gate += r('px', '#fff')
    flick += r('fk', HARNESS[(x * 7 + y * 3) % HARNESS.length]!)
  }
  const f = `${id}f`, h = `${id}h`, g = `${id}g`, m = `${id}m`
  let tails = ''
  for (let k = 0; k < COMETS; k++) tails += `<path data-d1="tail" d="${D1_PATHS.shell}" fill="none" stroke="${k === 0 ? '#fff6ec' : '#fff3e3'}" stroke-width="3" stroke-linecap="round" filter="url(#${f})" opacity="0"/>`
  const sparks = px >= 40 ? '<circle data-d1="spark" r=".8" fill="#ffd9b3" opacity="0"/>'.repeat(8) : ''
  return `<defs>${glow(f, 1.3)}${glow(h, 3.2)}${maskOf(g, gate)}${maskOf(m, facePaint('#fff'))}</defs>`
    + `<g opacity=".1">${facePaint(O)}</g><g mask="url(#${g})">${facePaint(O)}</g><g mask="url(#${m})">${flick}</g>`
    + `<path data-d1="halo" d="${D1_PATHS.shell}" style="fill:none;stroke:${O};stroke-width:3" filter="url(#${h})" opacity="0"/>`
    + tails + sparks
}

/** The prototype's `flickKF`: `m` alternating on/off flashes in the `w` before `a`. */
function flickKeyframes(a: number, w: number, m: number): Keyframe[] {
  const kf: Keyframe[] = [{ opacity: 0 }, { offset: clamp(a - w), opacity: 0 }]
  for (let j = 0; j < m; j++) {
    const t0 = a - w + j * w / m, v = j % 2 ? 0 : 1
    kf.push({ offset: clamp(t0 + .002), opacity: v }, { offset: clamp(t0 + w / m - .002), opacity: v })
  }
  kf.push({ offset: clamp(a), opacity: 0 }, { opacity: 0 })
  return kf
}

/**
 * Starts D1 on an SVG holding `d1Markup`. `startTime` (document-timeline ms) phase-locks every
 * animation to one origin — the boot splash uses it so a reload mid-boot continues the loop rather
 * than restarting it. Absent, the loop starts now, at frame 0.
 */
export function animateD1(svg: SVGSVGElement, startTime?: number): Animation[] {
  const dur = D1_DURATION, out: Animation[] = []
  const loop = (el: Element, kf: Keyframe[], o: KeyframeAnimationOptions = {}) => {
    const a = el.animate(kf, { duration: dur, iterations: Infinity, ...o })
    if (startTime !== undefined) a.startTime = startTime
    out.push(a)
  }
  const q = (kind: string) => Array.from(svg.querySelectorAll<SVGGraphicsElement>(`[data-d1="${kind}"]`))

  // cometAnim(el, dur, .08, .42, 'fwd')
  const tails = q('tail') as SVGPathElement[]
  const lead = tails[0]
  if (lead) {
    const L = lead.getTotalLength(), hd = L * .035, S = .08, T = .42
    tails.forEach((t, k) => {
      const lag = k * L * .03, op = 1 - k * .19
      t.style.strokeDasharray = `${hd} ${3 * L}`
      const s0 = hd + lag, s1 = hd + lag - L
      loop(t, [
        { strokeDashoffset: s0, opacity: 0 },
        { offset: S, strokeDashoffset: s0, opacity: op, easing: E },
        { offset: T, strokeDashoffset: s1, opacity: op },
        { offset: T + .04, strokeDashoffset: s1, opacity: 0 },
        { strokeDashoffset: s1, opacity: 0 },
      ])
    })
  }

  // decodeAnim(el, {dur, a0:.16, span:.34, outStart:.86, outSpan:.08}) — w .09, m 4, jit .03
  const px = q('px'), fk = q('fk')
  fk.forEach((r, j) => {
    const k = Number(r.dataset.k)
    const a = clamp(.16 + k * .34 + Math.random() * .03)
    const b = clamp(.86 + k * .08 + Math.random() * .02)
    if (px[j]) loop(px[j], [{ opacity: 0 }, { offset: a, opacity: 0 }, { offset: clamp(a + .004), opacity: 1 }, { offset: b, opacity: 1 }, { offset: clamp(b + .004), opacity: 0 }, { opacity: 0 }])
    loop(r, flickKeyframes(a, .09, 4))
  })

  // halo(el, dur, .5, .7)
  const h = q('halo')[0]
  if (h) loop(h, [{ opacity: 0 }, { offset: .5, opacity: 0 }, { offset: .53, opacity: .7 }, { offset: .72, opacity: 0 }, { opacity: 0 }])
  return out
}

/** Reduced motion: the logo at rest, breathing — the prototype's `.rm` pulse (3 s, .55 ↔ 1). */
export function breatheD1(svg: SVGSVGElement): Animation[] {
  return [svg.animate([{ opacity: .55 }, { opacity: 1 }, { opacity: .55 }], { duration: 3000, iterations: Infinity, easing: 'ease-in-out' })]
}
