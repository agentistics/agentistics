/**
 * logo-art.ts — PURE: the brand icon, rendered in half-blocks (`▀` `▄` `█`) from the REAL SVG
 * (HM-01, D-TUI-11). Brand rule: the logo's geometry is never redrawn or altered — only SCALED (and
 * coloured by the caller). So this reads the SVG's own path data and samples it on a grid; nothing
 * here knows what the logo looks like.
 *
 * Supported SVG (exactly what `packages/web/branding/logo-no-background.svg` uses): `<path d="…">`
 * with the absolute and relative straight-line commands `M m L l H h V v Z z`, either `fill` (even-odd
 * point-in-polygon) or `stroke` + `stroke-width` (distance to the segments ≤ half the width). A path
 * with any other command is REFUSED (thrown at build of the art, caught by the test) rather than
 * approximated — an approximated curve would be a redrawn logo.
 *
 * One terminal cell is two pixels tall (a half block each), so a `cols × rows` art samples a
 * `cols × 2·rows` pixel grid over the viewBox; each pixel is 4×4 supersampled and lit at ≥ 40 %.
 */

type Pt = readonly [number, number]

interface Shape {
  /** Closed rings (fill) or open/closed polylines (stroke). */
  polys: Pt[][]
  closed: boolean[]
  fill: boolean
  strokeHalf: number
}

function parsePath(d: string): { polys: Pt[][]; closed: boolean[] } {
  const polys: Pt[][] = []
  const closed: boolean[] = []
  let cur: Pt[] = []
  let x = 0, y = 0, sx = 0, sy = 0
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
  let i = 0
  let cmd = ''
  const num = () => Number(tokens[i++])
  const isNum = (t: string | undefined) => t !== undefined && /^-?\d*\.?\d+/.test(t)
  const flush = (close: boolean) => { if (cur.length > 0) { polys.push(cur); closed.push(close) } cur = [] }
  while (i < tokens.length) {
    if (!isNum(tokens[i])) cmd = tokens[i++]!
    switch (cmd) {
      case 'M': case 'm': {
        flush(false)
        const nx = num(), ny = num()
        x = cmd === 'm' ? x + nx : nx; y = cmd === 'm' ? y + ny : ny
        sx = x; sy = y; cur.push([x, y])
        cmd = cmd === 'm' ? 'l' : 'L' // implicit lineto after a moveto
        break
      }
      case 'L': case 'l': { const nx = num(), ny = num(); x = cmd === 'l' ? x + nx : nx; y = cmd === 'l' ? y + ny : ny; cur.push([x, y]); break }
      case 'H': case 'h': { const nx = num(); x = cmd === 'h' ? x + nx : nx; cur.push([x, y]); break }
      case 'V': case 'v': { const ny = num(); y = cmd === 'v' ? y + ny : ny; cur.push([x, y]); break }
      case 'Z': case 'z': { cur.push([sx, sy]); x = sx; y = sy; flush(true); break }
      default: throw new Error(`logo-art: unsupported SVG path command "${cmd}" — the logo is scaled, never approximated`)
    }
  }
  flush(false)
  return { polys, closed }
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? m[1]! : null
}

export function parseLogoSvg(svg: string): { viewBox: [number, number, number, number]; shapes: Shape[] } {
  const vb = (attr(svg, 'viewBox') ?? '0 0 1 1').split(/[\s,]+/).map(Number) as [number, number, number, number]
  const shapes: Shape[] = []
  for (const m of svg.matchAll(/<path\b[^>]*>/g)) {
    const tag = m[0]
    const d = attr(tag, 'd')
    if (!d) continue
    const { polys, closed } = parsePath(d)
    const fill = attr(tag, 'fill')
    const stroke = attr(tag, 'stroke')
    const width = Number(attr(tag, 'stroke-width') ?? '1')
    const isFill = fill !== null && fill !== 'none'
    shapes.push({ polys, closed, fill: isFill, strokeHalf: !isFill && stroke && stroke !== 'none' ? width / 2 : 0 })
  }
  return { viewBox: vb, shapes }
}

function inside(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len))
  const cx = a[0] + t * dx, cy = a[1] + t * dy
  return Math.hypot(p[0] - cx, p[1] - cy)
}

function lit(p: Pt, shapes: readonly Shape[]): boolean {
  for (const s of shapes) {
    if (s.fill) {
      let hit = false
      for (const poly of s.polys) if (inside(p, poly)) hit = !hit // even-odd across rings
      if (hit) return true
    } else if (s.strokeHalf > 0) {
      for (const poly of s.polys) for (let k = 1; k < poly.length; k++) if (segDist(p, poly[k - 1]!, poly[k]!) <= s.strokeHalf) return true
    }
  }
  return false
}

const SS = 4

/** The icon as `rows` lines of exactly `cols` cells (spaces where it is dark). */
export function logoArt(svg: string, cols: number, rows: number): string[] {
  const { viewBox: [vx, vy, vw, vh], shapes } = parseLogoSvg(svg)
  const ph = rows * 2
  const px = (c: number, r: number): boolean => {
    let on = 0
    for (let a = 0; a < SS; a++) for (let b = 0; b < SS; b++) {
      const x = vx + ((c + (a + 0.5) / SS) / cols) * vw
      const y = vy + ((r + (b + 0.5) / SS) / ph) * vh
      if (lit([x, y], shapes)) on++
    }
    return on / (SS * SS) >= 0.4
  }
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      const top = px(c, 2 * r), bottom = px(c, 2 * r + 1)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    out.push(line)
  }
  return out
}

