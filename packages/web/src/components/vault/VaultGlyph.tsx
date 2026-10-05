import { useId, type SVGProps } from 'react'

/**
 * The vault's icon — the ONLY drawing of it, and the only place a surface should get it from (header
 * button, Nay tab, FAB pop, quick sheet, page, settings, empty states). Owner-approved 2026-10-05, style
 * "C Sólido": a solid safe — a rounded body with the dial CUT OUT of it (a mask, so the page behind shows
 * through), the dial ring and spokes drawn back inside, a handle notch on the right and two feet. At 16 px
 * the silhouette alone says "safe"; at 48 it carries the spokes.
 *
 * `currentColor` everywhere: the surface decides the colour, exactly like a lucide icon, which is what it
 * replaces. The mask id is per instance (`useId`), because two glyphs on one page sharing an id would
 * share the FIRST one's mask.
 */
export function VaultGlyph({ size = 16, ...rest }: { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'viewBox'>) {
  const id = `vg${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-vault-glyph {...rest}>
      <defs>
        <mask id={id}>
          <rect width="24" height="24" fill="#fff" />
          <circle cx="11" cy="11" r="5.2" fill="#000" />
          <path d="M18.2 8.2h1.6v5.6h-1.6z" fill="#000" />
        </mask>
      </defs>
      <rect x="2" y="2" width="20" height="18" rx="3" fill="currentColor" mask={`url(#${id})`} />
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="11" cy="11" r="3.4" />
        <path d="M11 7.6v-1.4M11 14.4v1.4M7.6 11H6.2M14.4 11h1.4" />
      </g>
      <circle cx="11" cy="11" r="1" fill="currentColor" />
      <rect x="4.5" y="20" width="3" height="2.5" rx=".6" fill="currentColor" />
      <rect x="16.5" y="20" width="3" height="2.5" rx=".6" fill="currentColor" />
    </svg>
  )
}
