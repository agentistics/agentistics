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

/** Where the host may draw a surface's button. */
export const SURFACE_PLACEMENTS = ['session-header', 'nay-dock', 'app-bar'] as const
export type SurfacePlacement = (typeof SURFACE_PLACEMENTS)[number]

/** The only path a surface module (and every engine asset) may live under — same origin, host-served. */
export const ENGINE_ASSET_PREFIX = '/api/engine/x/'

export interface EngineSurface {
  /** Stable, `[a-z][a-z0-9-]{0,39}`, unique within the manifest. */
  id: string
  placement: SurfacePlacement
  /** The button's text. */
  label: { pt: string; en: string }
  /** A same-origin path under `ENGINE_ASSET_PREFIX`, ending `.js` or `.mjs`. */
  module: string
  /** An environment variable name (`[A-Z][A-Z0-9_]*`): the surface is offered only while it is `1`. */
  experimental?: string
}

/**
 * How the host frames a mounted surface: `full` is a modal overlay over the page, `side` a panel docked
 * to the edge that leaves the page usable. The surface switches between them without being unmounted.
 */
export type SurfaceLayout = 'full' | 'side'

/** What the host passes a surface's `mount`. */
export interface SurfaceMountContext {
  /** The session the surface was opened from; `null` where there is none (e.g. `app-bar`). */
  sessionId: string | null
  lang: 'pt' | 'en'
  reducedMotion: boolean
  /** The layout it opened in (always `full`). */
  layout: SurfaceLayout
  /** Switches the host frame between `full` and `side`; the module stays mounted. */
  setLayout(layout: SurfaceLayout): void
  /**
   * Asks the host to close the surface (which then calls `unmount`). A mounted surface stays mounted
   * while the person navigates between screens; only this, the close button or Esc (in `full`) ends it.
   */
  close(): void
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
  | 'bad-module'
  | 'bad-flag'

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
    if (!surfaceModuleOk(s.module)) out.push({ id, reason: 'bad-module' })
    if (s.experimental !== undefined && !(typeof s.experimental === 'string' && FLAG.test(s.experimental))) {
      out.push({ id, reason: 'bad-flag' })
    }
  }
  return out
}

/** The socket an upgraded route talks through. The host owns the real one. */
export interface EngineSocket {
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
