import type { OpenSurface } from '../lib/engineSurfaceHost'

/** Lives inside the Nay button; its click restores the first minimized surface. */
export function EngineSurfaceNayBadge({ surfaces, lang }: { surfaces: OpenSurface[]; lang: 'pt' | 'en' }) {
  if (!surfaces.length) return null
  return <span data-engine-nay-badge aria-label={surfaces.map(s => s.indicator?.label[lang] ?? s.surface.label[lang]).join(', ')}
    style={{ position: 'absolute', right: -3, top: -3, minWidth: 16, height: 16, borderRadius: 8, background: 'var(--anthropic-orange)', color: 'var(--bg-surface)', fontSize: 10, display: 'grid', placeItems: 'center', border: '2px solid var(--bg-surface)' }}>{surfaces.length}</span>
}
