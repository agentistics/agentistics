/**
 * engineSurfaces — the buttons an engine announced (`GET /api/engine` → `surfaces`), and how the host
 * loads one. Everything that decides is PURE and tested; the one impure step is `import()`.
 *
 * The server already refuses a surface it cannot place and drops an experimental one whose flag is
 * off. The web re-checks the one thing that must never be taken on trust — the module path — before
 * it ever reaches `import()`: same-origin, under `/api/engine/x/`, no dot-segments. A community build
 * answers no `surfaces`, so there is no button at all.
 */
export type SurfacePlacement = 'session-header' | 'nay-dock' | 'app-bar' | 'composer' | 'rail'
export type SurfaceIcon = 'phone' | 'phone-off' | 'sparkles' | 'panel'
export type SurfaceActiveTone = 'accent' | 'danger'
const ICONS: readonly string[] = ['phone', 'phone-off', 'sparkles', 'panel']
export type SurfaceLayout = 'full' | 'side' | 'inline' | 'page'

export interface EngineSurfaceInfo {
  id: string
  placement: SurfacePlacement
  label: { pt: string; en: string }
  icon?: SurfaceIcon
  /** While open (composer placement): icon, label and fill of the pressed button. */
  activeIcon?: SurfaceIcon
  activeLabel?: { pt: string; en: string }
  activeTone?: SurfaceActiveTone
  module: string
  /** The layout it opens in (default `full`); `inline` only for `composer`; `rail` is always `page`. */
  layout?: SurfaceLayout
  /** No host padding, title bar or close button in `full` / `side`; the surface draws its own. */
  frameless?: boolean
}

/** A pill in the top bar on every screen while it is set (`ctx.setIndicator`). */
export interface SurfaceIndicator {
  label: { pt: string; en: string }
  /** Epoch ms: the pill shows a live `mm:ss` since then. */
  since?: number
  tone?: SurfaceActiveTone
  icon?: SurfaceIcon
  /** The secondary button's text; it calls the `ctx.onIndicatorEnd` callback. */
  endLabel?: { pt: string; en: string }
}

export interface SurfaceMountContext {
  sessionId: string | null
  lang: 'pt' | 'en'
  reducedMotion: boolean
  layout: SurfaceLayout
  setLayout(layout: SurfaceLayout): void
  close(): void
  keepAlive(on: boolean): void
  setIndicator(indicator: SurfaceIndicator | null): void
  onIndicatorEnd(fn: () => void): () => void
  /** 1.18, optional. Navigates the app to `/sessions/<id>` without a reload; `false` for an invalid id or when it cannot. */
  openSession?(sessionId: string): boolean
}

/** PURE. A session id `openSession` accepts: a short string with no `/`, `\\`, `?`, `#`, whitespace or control characters. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && id !== '.' && id !== '..' && !/[\/\\?#\s\u0000-\u001f\u007f]/.test(id)
}

const INDICATOR_MAX = 40

/** PURE. Why an indicator is refused (the contract's `surfaceIndicatorRefusals`); empty means it may be shown. */
export function surfaceIndicatorRefusals(ind: unknown): string[] {
  if (!ind || typeof ind !== 'object' || Array.isArray(ind)) return ['bad-indicator']
  const i = ind as Record<string, unknown>
  const out: string[] = []
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= INDICATOR_MAX
  const pair = (v: unknown) => !!v && typeof v === 'object' && text((v as { pt?: unknown }).pt) && text((v as { en?: unknown }).en)
  if (!pair(i.label)) out.push('bad-label')
  if (i.since !== undefined && !(typeof i.since === 'number' && Number.isFinite(i.since) && i.since >= 0)) out.push('bad-since')
  if (i.tone !== undefined && i.tone !== 'accent' && i.tone !== 'danger') out.push('bad-tone')
  if (i.icon !== undefined && !(typeof i.icon === 'string' && ICONS.includes(i.icon))) out.push('bad-icon')
  if (i.endLabel !== undefined && !pair(i.endLabel)) out.push('bad-end-label')
  return out
}

/** PURE. A trimmed copy of an accepted indicator holding only the known fields (never the caller's object). */
export function asSurfaceIndicator(ind: SurfaceIndicator): SurfaceIndicator {
  return {
    label: { pt: ind.label.pt.trim(), en: ind.label.en.trim() },
    ...(ind.since !== undefined ? { since: ind.since } : {}), ...(ind.tone ? { tone: ind.tone } : {}),
    ...(ind.icon ? { icon: ind.icon } : {}), ...(ind.endLabel ? { endLabel: { pt: ind.endLabel.pt.trim(), en: ind.endLabel.en.trim() } } : {}),
  }
}

/** PURE. The pill's timer: whole minutes and seconds elapsed since `since` (`mm:ss`, minutes unbounded). */
export function formatIndicatorElapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** The route a `rail` surface's page lives on. */
export function surfacePagePath(id: string): string { return `/x/${id}` }

export interface SurfaceModule {
  mount(el: HTMLElement, ctx: SurfaceMountContext): void | Promise<void>
  unmount?(el: HTMLElement): void | Promise<void>
}

const PREFIX = '/api/engine/x/'

/** PURE. May this path be handed to `import()`? */
export function surfaceModulePathOk(p: unknown): p is string {
  if (typeof p !== 'string' || !p.startsWith(PREFIX) || p.length > 256 || /[\\?#%\s]/.test(p) || p.includes('//')) return false
  const rest = p.slice(PREFIX.length)
  if (rest.split('/').some(s => s === '' || s === '.' || s === '..')) return false
  return /\.m?js$/.test(rest)
}

/** PURE. The surfaces of `placement` in a `/api/engine` answer; anything malformed is left out. */
export function surfacesFrom(status: unknown, placement: SurfacePlacement): EngineSurfaceInfo[] {
  const list = (status as { surfaces?: unknown } | null)?.surfaces
  if (!Array.isArray(list)) return []
  const out: EngineSurfaceInfo[] = []
  for (const s of list as Record<string, unknown>[]) {
    const label = s?.label as { pt?: unknown; en?: unknown } | undefined
    if (s?.placement !== placement || typeof s.id !== 'string' || !surfaceModulePathOk(s.module)) continue
    if (typeof label?.pt !== 'string' || typeof label?.en !== 'string') continue
    const icon = typeof s.icon === 'string' && ICONS.includes(s.icon) ? s.icon as SurfaceIcon : undefined
    // A rail entry is icon-only: without an icon there is nothing to draw.
    if (placement === 'rail' && !icon) continue
    const activeIcon = typeof s.activeIcon === 'string' && ICONS.includes(s.activeIcon) ? s.activeIcon as SurfaceIcon : undefined
    const al = s.activeLabel as { pt?: unknown; en?: unknown } | undefined
    const activeLabel = typeof al?.pt === 'string' && typeof al?.en === 'string' ? { pt: al.pt, en: al.en } : undefined
    const activeTone = s.activeTone === 'danger' || s.activeTone === 'accent' ? s.activeTone : undefined
    const layout = placement === 'rail' ? 'page'
      : s.layout === 'full' || s.layout === 'side' || (s.layout === 'inline' && placement === 'composer') ? s.layout : undefined
    out.push({
      id: s.id, placement, label: { pt: label.pt, en: label.en }, module: s.module,
      ...(icon ? { icon } : {}), ...(activeIcon ? { activeIcon } : {}), ...(activeLabel ? { activeLabel } : {}),
      ...(activeTone ? { activeTone } : {}), ...(layout ? { layout } : {}), ...(s.frameless === true ? { frameless: true } : {}),
    })
  }
  return out
}

/**
 * PURE. Is a mounted surface still announced by this `/api/engine` answer (same id, same placement)?
 * `null` when the answer is no answer at all (a failed read): nothing can be concluded from it.
 */
export function stillAnnounced(status: unknown): ((s: Pick<EngineSurfaceInfo, 'id' | 'placement'>) => boolean) | null {
  if (!status || typeof status !== 'object') return null
  const placements: SurfacePlacement[] = ['session-header', 'nay-dock', 'app-bar', 'composer', 'rail']
  const keys = new Set(placements.flatMap(p => surfacesFrom(status, p).map(s => `${p}:${s.id}`)))
  return s => keys.has(`${s.placement}:${s.id}`)
}

/** PURE. A loaded module that cannot be mounted is refused with a reason, never half-used. */
export function asSurfaceModule(m: unknown): SurfaceModule | null {
  const mount = (m as { mount?: unknown } | null)?.mount
  if (typeof mount !== 'function') return null
  const unmount = (m as { unmount?: unknown }).unmount
  return {
    mount: mount as SurfaceModule['mount'],
    ...(typeof unmount === 'function' ? { unmount: unmount as NonNullable<SurfaceModule['unmount']> } : {}),
  }
}

export interface SurfaceHandle { unmount(): Promise<void> }

/**
 * Loads `info.module` and mounts it into `el`. Throws a sentence-bearing Error when the path is not
 * allowed or the module has no `mount`. `load` is injectable for tests.
 */
export async function mountSurface(
  info: Pick<EngineSurfaceInfo, 'module'>,
  el: HTMLElement,
  ctx: SurfaceMountContext,
  load: (path: string) => Promise<unknown> = path => import(/* @vite-ignore */ path),
): Promise<SurfaceHandle> {
  if (!surfaceModulePathOk(info.module)) throw new Error('surface-module-refused')
  const mod = asSurfaceModule(await load(info.module))
  if (!mod) throw new Error('surface-module-invalid')
  await mod.mount(el, ctx)
  let done = false
  return {
    async unmount() {
      if (done) return
      done = true
      try { await mod.unmount?.(el) } finally { el.replaceChildren() }
    },
  }
}
