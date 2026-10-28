/**
 * engineSurfaces — the buttons an engine announced (`GET /api/engine` → `surfaces`), and how the host
 * loads one. Everything that decides is PURE and tested; the one impure step is `import()`.
 *
 * The server already refuses a surface it cannot place and drops an experimental one whose flag is
 * off. The web re-checks the one thing that must never be taken on trust — the module path — before
 * it ever reaches `import()`: same-origin, under `/api/engine/x/`, no dot-segments. A community build
 * answers no `surfaces`, so there is no button at all.
 */
export type SurfacePlacement = 'session-header' | 'nay-dock' | 'app-bar'
export type SurfaceLayout = 'full' | 'side'

export interface EngineSurfaceInfo {
  id: string
  placement: SurfacePlacement
  label: { pt: string; en: string }
  module: string
}

export interface SurfaceMountContext {
  sessionId: string | null
  lang: 'pt' | 'en'
  reducedMotion: boolean
  layout: SurfaceLayout
  setLayout(layout: SurfaceLayout): void
  close(): void
}

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
    out.push({ id: s.id, placement, label: { pt: label.pt, en: label.en }, module: s.module })
  }
  return out
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
