/**
 * static-cache.ts — PURE. How long a browser may keep each file the server embeds.
 *
 * Three kinds of file, and the difference is whether the URL changes when the content does:
 *
 * - THE SHELL (`index.html`, the service worker, the manifest): the URL never changes and the
 *   content does, so it must never be cached — it carries the hashed asset URLs.
 * - CONTENT-ADDRESSED files (`/assets/*`, whose file names carry a hash of their content, and the
 *   `/fonts/*` files, which are versioned by name): safe to keep for a year, because a different
 *   content is a different URL.
 * - EVERYTHING ELSE (icons, favicons, logos, marks): the URL is the same whatever the artwork, so a
 *   year-long lifetime pins the browser to whichever version it saw first. That is exactly how a
 *   rebranded logo went on showing the old one, and how an installed PWA kept an icon that had
 *   already been corrected. These are revalidated on every use (`no-cache` + an ETag makes that a
 *   304, not a download).
 */

const SHELL = new Set(['/sw.js', '/manifest.webmanifest', '/registerSW.js', '/index.html'])

export type CacheKind = 'shell' | 'immutable' | 'revalidate'

export function cacheKind(pathname: string): CacheKind {
  if (SHELL.has(pathname)) return 'shell'
  if (pathname.startsWith('/assets/') || pathname.startsWith('/fonts/')) return 'immutable'
  return 'revalidate'
}

export function staticCacheControl(pathname: string): string {
  switch (cacheKind(pathname)) {
    case 'shell': return 'no-cache, no-store, must-revalidate'
    case 'immutable': return 'public, max-age=31536000, immutable'
    case 'revalidate': return 'no-cache'
  }
}

/** A strong ETag for a body. Cheap (a non-cryptographic hash): its only job is "did this change". */
export function etagOf(body: string | Uint8Array): string {
  return `"${Bun.hash(body).toString(36)}"`
}

/** Does an `If-None-Match` header name this ETag? (`*` and a comma-separated list both count.) */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  return ifNoneMatch.split(',').some(t => {
    const v = t.trim().replace(/^W\//, '')
    return v === '*' || v === etag
  })
}
