/**
 * surfaces.ts — UI surfaces an engine announces, and the sockets its routes may upgrade (1.15).
 *
 * A surface is a script the engine serves from its own route under `/api/engine/x/`. The host draws a
 * generic button, loads the module on demand and mounts it into an overlay the host owns. Nothing
 * here is specific to any one feature: an id, a placement, a label, a module path.
 *
 * Everything in this file is PURE. The host judges a manifest with `surfaceRefusals` at load, the same
 * way it judges routes: a surface it cannot place safely is refused, never half-drawn.
 */

/**
 * Where the host may draw a surface's button. 1.18 adds `composer` (an icon button in the shared composer)
 * and `rail` (an icon entry in the app's navigation, beside the pages, that opens the surface AS a page).
 */
export const SURFACE_PLACEMENTS = ['session-header', 'nay-dock', 'app-bar', 'composer', 'rail'] as const
export type SurfacePlacement = (typeof SURFACE_PLACEMENTS)[number]

/** Generic icon names understood by the host; engines never choose a library glyph directly. */
export const SURFACE_ICONS = ['phone', 'phone-off', 'sparkles', 'panel'] as const
export type SurfaceIcon = (typeof SURFACE_ICONS)[number]

export const SURFACE_ACTIVE_TONES = ['accent', 'danger'] as const
export type SurfaceActiveTone = (typeof SURFACE_ACTIVE_TONES)[number]

/** The only path a surface module (and every engine asset) may live under — same origin, host-served. */
export const ENGINE_ASSET_PREFIX = '/api/engine/x/'

export interface EngineSurface {
  /** Stable, `[a-z][a-z0-9-]{0,39}`, unique within the manifest. */
  id: string
  placement: SurfacePlacement
  /** The button's text. */
  label: { pt: string; en: string }
  /**
   * Host-mapped icon; REQUIRED for the `composer` and `rail` placements (icon-only entries). The label
   * remains the accessible name and tooltip.
   */
  icon?: SurfaceIcon
  /**
   * 1.18, optional, `composer` placement: while this surface is open (any layout) the host's button
   * shows this icon (from the same closed set), the `activeLabel` and the
   * `activeTone` fill; clicking it closes the surface. Same spot and size as the idle button.
   */
  activeIcon?: SurfaceIcon
  /** The accessible name and tooltip while active; falls back to `label`. */
  activeLabel?: { pt: string; en: string }
  /** The filled style while active (default `accent`); `danger` is the destructive red. */
  activeTone?: SurfaceActiveTone
  /** A same-origin path under `ENGINE_ASSET_PREFIX`, ending `.js` or `.mjs`. */
  module: string
  /** An environment variable name (`[A-Z][A-Z0-9_]*`): the surface is offered only while it is `1`. */
  experimental?: string
  /**
   * 1.18, optional: the layout the surface opens in (default `full`; `page` for `rail`). `inline` is only
   * valid for the `composer` placement, `page` only for `rail` (which accepts no other layout).
   */
  layout?: SurfaceLayout
  /**
   * 1.18, optional: when `true` the host draws NO padding, title bar or close button around the surface
   * in `full` and `side`; the surface draws its own chrome and ends itself with `ctx.close()`.
   */
  frameless?: boolean
}

/**
 * How the host frames a mounted surface: `full` is a modal overlay over the page, `side` a panel docked
 * to the edge that leaves the page usable, and (1.18) `inline` mounts it directly above the session
 * composer, inside the session view, leaving the conversation and the composer usable. `inline` exists
 * only for a surface of the `composer` placement; elsewhere the host ignores it. (1.18) `page` mounts it
 * as a page of the app, in the main area, with no host frame, on its own route (`/x/<id>`); it exists
 * only for (and is the only layout of) the `rail` placement. The surface switches between layouts
 * without being unmounted (the host re-parents the same element).
 */
export type SurfaceLayout = 'full' | 'side' | 'inline' | 'page'
export const SURFACE_LAYOUTS = ['full', 'side', 'inline', 'page'] as const

/**
 * 1.18: what a surface asks the host to show in the app's top bar, on every screen, while it is set
 * (`ctx.setIndicator`). The host draws a pill with the icon, the label and, given `since`, a live
 * `mm:ss` timer; clicking it brings the surface back (a `rail` page: its route; a session surface: the
 * session that owns it, in the layout it had). With `endLabel` the pill carries a secondary button
 * that calls the callback registered with `ctx.onIndicatorEnd`.
 */
export interface SurfaceIndicator {
  /** 1–40 characters each, after trimming. */
  label: { pt: string; en: string }
  /** Epoch milliseconds; the host shows the time elapsed since then, counting up. */
  since?: number
  /** `accent` by default; `danger` is the destructive red. */
  tone?: SurfaceActiveTone
  icon?: SurfaceIcon
  /** The secondary button's text (1–40 characters each); absent means no secondary button. */
  endLabel?: { pt: string; en: string }
}

export type SurfaceIndicatorRefusalReason = 'bad-indicator' | 'bad-label' | 'bad-since' | 'bad-tone' | 'bad-icon' | 'bad-end-label'

/** The longest indicator label (and end label) the host draws. */
export const SURFACE_INDICATOR_LABEL_MAX = 40

/** PURE. Why the host would refuse this indicator; empty means it may be shown. */
export function surfaceIndicatorRefusals(ind: unknown): SurfaceIndicatorRefusalReason[] {
  if (!ind || typeof ind !== 'object' || Array.isArray(ind)) return ['bad-indicator']
  const i = ind as Record<string, unknown>
  const out: SurfaceIndicatorRefusalReason[] = []
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= SURFACE_INDICATOR_LABEL_MAX
  const pair = (v: unknown) => !!v && typeof v === 'object' && text((v as { pt?: unknown }).pt) && text((v as { en?: unknown }).en)
  if (!pair(i.label)) out.push('bad-label')
  if (i.since !== undefined && !(typeof i.since === 'number' && Number.isFinite(i.since) && i.since >= 0)) out.push('bad-since')
  if (i.tone !== undefined && !(SURFACE_ACTIVE_TONES as readonly unknown[]).includes(i.tone)) out.push('bad-tone')
  if (i.icon !== undefined && !(SURFACE_ICONS as readonly unknown[]).includes(i.icon)) out.push('bad-icon')
  if (i.endLabel !== undefined && !pair(i.endLabel)) out.push('bad-end-label')
  return out
}

/** What the host passes a surface's `mount`. */
export interface SurfaceMountContext {
  /** The session the surface was opened from; `null` where there is none (e.g. `app-bar`). */
  sessionId: string | null
  lang: 'pt' | 'en'
  reducedMotion: boolean
  /**
   * The layout actually drawn right now (live): the declared `layout` (else `full`), except that an
   * `inline` surface reports `side` while no session composer is on screen to hold it.
   */
  layout: SurfaceLayout
  /**
   * Switches the host frame between `full`, `side` and (1.18, `composer` placement only) `inline`; the
   * module stays mounted. A `rail` surface is always `page`: the host ignores any other layout for it,
   * and `page` for any other placement.
   */
  setLayout(layout: SurfaceLayout): void
  /**
   * Ends the surface (the host then calls `unmount`), whatever `keepAlive` says. A mounted surface stays
   * mounted while the person navigates between screens; only this, the close button or Esc (in `full`)
   * ends it, and (`rail`) leaving its page.
   */
  close(): void
  /**
   * 1.18. With `true`, whatever would take the surface off screen (leaving its `rail` page, the close
   * button, Esc, the active `composer` button) does NOT unmount it: the host moves the same element,
   * still mounted, off screen, so media, sockets and state carry on, until it is brought back (its entry,
   * the indicator) or ends (`close()`, or `keepAlive(false)` while off screen, which unmounts it at once).
   * Only one surface is on screen at a time; opening another one takes a kept-alive surface off screen
   * rather than ending it.
   */
  keepAlive(on: boolean): void
  /**
   * 1.18. Shows (or, with `null`, removes) a pill in the app's top bar on every screen while the surface
   * is mounted; see `SurfaceIndicator`. An indicator `surfaceIndicatorRefusals` refuses throws an Error
   * naming the reasons and leaves the previous one in place. Unmounting removes it.
   */
  setIndicator(indicator: SurfaceIndicator | null): void
  /** 1.18. The callback the indicator's secondary button calls; returns the function that removes it. */
  onIndicatorEnd(fn: () => void): () => void
}

/** The module's contract: `import(module)` must expose `mount`, and may expose `unmount`. */
export interface SurfaceModule {
  mount(el: HTMLElement, ctx: SurfaceMountContext): void | Promise<void>
  unmount?(el: HTMLElement): void | Promise<void>
}

export type SurfaceRefusalReason =
  | 'bad-id'
  | 'duplicate-id'
  | 'bad-placement'
  | 'bad-label'
  | 'bad-icon'
  | 'bad-module'
  | 'bad-flag'
  | 'bad-layout'
  | 'bad-frameless'
  | 'bad-active'

const ID = /^[a-z][a-z0-9-]{0,39}$/
const FLAG = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * PURE. May `module` be imported by the host? It must resolve, against any origin, to a path under
 * the asset prefix with no dot-segments, no encoded separators or dots, no backslash, no query or
 * fragment, and a `.js`/`.mjs` extension.
 */
export function surfaceModuleOk(module: unknown): module is string {
  if (typeof module !== 'string' || !module.startsWith(ENGINE_ASSET_PREFIX)) return false
  if (module.length > 256 || /[\\?#%\s]/.test(module) || module.includes('//')) return false
  let u: URL
  try { u = new URL(module, 'http://same-origin.invalid') } catch { return false }
  if (u.origin !== 'http://same-origin.invalid' || u.pathname !== module) return false
  const rest = module.slice(ENGINE_ASSET_PREFIX.length)
  if (rest.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) return false
  return /\.m?js$/.test(rest)
}

/** PURE. The refusals for a manifest's surfaces; empty means every one may be offered. */
export function surfaceRefusals(
  surfaces: readonly EngineSurface[] | undefined,
): { id: string; reason: SurfaceRefusalReason }[] {
  const out: { id: string; reason: SurfaceRefusalReason }[] = []
  const seen = new Set<string>()
  for (const s of surfaces ?? []) {
    const id = typeof s?.id === 'string' ? s.id : ''
    if (!ID.test(id)) { out.push({ id, reason: 'bad-id' }); continue }
    if (seen.has(id)) { out.push({ id, reason: 'duplicate-id' }); continue }
    seen.add(id)
    if (!(SURFACE_PLACEMENTS as readonly string[]).includes(s.placement)) out.push({ id, reason: 'bad-placement' })
    const l = s.label as { pt?: unknown; en?: unknown } | undefined
    const labelOk = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 60
    if (!l || !labelOk(l.pt) || !labelOk(l.en)) out.push({ id, reason: 'bad-label' })
    if (s.icon !== undefined && !(SURFACE_ICONS as readonly string[]).includes(s.icon)) out.push({ id, reason: 'bad-icon' })
    if ((s.placement === 'composer' || s.placement === 'rail') && s.icon === undefined) out.push({ id, reason: 'bad-icon' })
    if (!surfaceModuleOk(s.module)) out.push({ id, reason: 'bad-module' })
    if (s.experimental !== undefined && !(typeof s.experimental === 'string' && FLAG.test(s.experimental))) {
      out.push({ id, reason: 'bad-flag' })
    }
    if (s.layout !== undefined && !((SURFACE_LAYOUTS as readonly string[]).includes(s.layout)
      && (s.layout !== 'inline' || s.placement === 'composer')
      && ((s.layout === 'page') === (s.placement === 'rail')))) out.push({ id, reason: 'bad-layout' })
    const al = s.activeLabel as { pt?: unknown; en?: unknown } | undefined
    if ((s.activeIcon !== undefined && !(SURFACE_ICONS as readonly string[]).includes(s.activeIcon))
      || (s.activeTone !== undefined && !(SURFACE_ACTIVE_TONES as readonly string[]).includes(s.activeTone))
      || (s.activeLabel !== undefined && !(al && labelOk(al.pt) && labelOk(al.en)))) out.push({ id, reason: 'bad-active' })
    if (s.frameless !== undefined && typeof s.frameless !== 'boolean') out.push({ id, reason: 'bad-frameless' })
  }
  return out
}

import type { StructuredSessionHandle } from './structured'

/** The socket an upgraded route talks through. The host owns the real one. */
export interface EngineSocket {
  /**
   * 1.17, optional: a handle on the session this socket's handshake declared — judged by the host (the
   * session existed and was live when it accepted the socket), bound to THIS socket and dead once it
   * closes. `null` when the socket declared no session or the session has ended. The only way a surface
   * reaches the session it was opened from; absent on a host older than 1.17.
   */
  structured?(): StructuredSessionHandle | null
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

/** Returned by `EngineRoute.upgrade` to accept a WebSocket. */
export interface EngineSocketHandlers {
  /** The session this connection is about. Declared → the host closes the socket when that session ends. */
  sessionId?: string
  /** May only NARROW the host's frame cap (`ENGINE_SOCKET_LIMITS.maxFrameBytes`). */
  maxFrameBytes?: number
  open?(socket: EngineSocket): void
  message(socket: EngineSocket, data: string | Uint8Array): void
  close?(code: number, reason: string): void
}

/** The host's ceilings for engine sockets. An engine may ask for less, never more. */
export const ENGINE_SOCKET_LIMITS = {
  maxFrameBytes: 64 * 1024,
  /** Simultaneous connections per route prefix. */
  perRoute: 16,
  /** Simultaneous connections per declared session. */
  perSession: 4,
} as const

/** PURE. The frame cap for a connection: the host's, narrowed by the engine's ask. */
export function frameCap(asked: number | undefined): number {
  if (typeof asked !== 'number' || !Number.isFinite(asked) || asked < 1) return ENGINE_SOCKET_LIMITS.maxFrameBytes
  return Math.min(Math.floor(asked), ENGINE_SOCKET_LIMITS.maxFrameBytes)
}
