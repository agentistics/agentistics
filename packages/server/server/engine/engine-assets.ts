/**
 * engine/engine-assets.ts — the Content-Type the host stamps on an engine's static asset.
 *
 * The engine route under `/api/engine/x/` serves its own files; the host does not trust the header it
 * set. A script must be served as JavaScript or the browser refuses the module, and a type the page's
 * CSP does not allow (WebAssembly: `script-src 'self'` carries no `wasm-unsafe-eval`) is not served at
 * all rather than served and failing in the console. The CSP itself is untouched.
 */
import { ENGINE_ASSET_PREFIX } from '@agentistics/engine-api'

const TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
}

/** Extensions the host refuses to serve because the CSP would block them. */
const REFUSED = new Set(['wasm'])

export type AssetVerdict = { kind: 'refuse' } | { kind: 'type'; contentType: string } | { kind: 'passthrough' }

/** PURE. What to do with the response an engine produced for `pathname`. */
export function assetVerdict(pathname: string): AssetVerdict {
  if (!pathname.startsWith(ENGINE_ASSET_PREFIX)) return { kind: 'passthrough' }
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  if (dot < 0) return { kind: 'passthrough' }
  const ext = last.slice(dot + 1).toLowerCase()
  if (REFUSED.has(ext)) return { kind: 'refuse' }
  const contentType = TYPES[ext]
  return contentType ? { kind: 'type', contentType } : { kind: 'passthrough' }
}

/** The response with the verdict applied; a success only — an error body keeps what the engine said. */
export function applyAssetVerdict(pathname: string, res: Response): Response {
  const v = assetVerdict(pathname)
  if (v.kind === 'refuse') {
    return new Response(JSON.stringify({ error: 'asset_type_not_allowed' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
  if (v.kind !== 'type' || !res.ok) return res
  const headers = new Headers(res.headers)
  headers.set('Content-Type', v.contentType)
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
