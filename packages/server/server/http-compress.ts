/**
 * http-compress.ts — gzip / brotli for the responses that are worth it.
 *
 * A phone reaching this machine through a Tailscale relay on mobile data measured `/api/data` at
 * 5,37 MB of uncompressed JSON and the JS bundle at ~590 KB, also uncompressed — the boot screen
 * stayed up for minutes. Text compresses ~10x, so this is the cheapest fix there is.
 *
 * Rules, each of which keeps something from breaking:
 *  - Only a CLOSED list of text types is compressed. A stream (`text/event-stream`, ndjson, a
 *    terminal feed) is never buffered: buffering an SSE response to compress it would hang it.
 *  - The client decides (`Accept-Encoding`, honouring `q=0`), and `Vary: Accept-Encoding` is always
 *    added to a response that COULD have been compressed, so a shared cache never serves the wrong one.
 *  - Content-hashed static assets (`immutable`) are compressed ONCE per process and kept; everything
 *    else is compressed per response. Brotli is quality 4 per response (faster than gzip 6 and
 *    smaller on JSON) and quality 9 for the cached assets, where the cost is paid once.
 */
import { brotliCompress, gzip, constants } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const brotliAsync = promisify(brotliCompress)

export type Encoding = 'br' | 'gzip'

/** Below this the headers outweigh the saving. */
export const MIN_COMPRESS_BYTES = 1024

const COMPRESSIBLE = /^(application\/(json|javascript|manifest\+json|xml)|text\/(html|css|plain|javascript|xml)|image\/svg\+xml)\b/i

export function isCompressibleType(contentType: string | null): boolean {
  return !!contentType && COMPRESSIBLE.test(contentType.trim())
}

/** The best encoding the client accepts, or null. Honours `q=0` ("not acceptable") and `*`. */
export function negotiateEncoding(acceptEncoding: string | null): Encoding | null {
  if (!acceptEncoding) return null
  const q = new Map<string, number>()
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    let weight = 1
    for (const p of params) {
      const m = /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)
      if (m) weight = Number(m[1])
    }
    q.set(name.trim(), Number.isFinite(weight) ? weight : 0)
  }
  const star = q.get('*')
  const w = (n: string) => q.get(n) ?? star ?? 0
  if (w('br') > 0 && w('br') >= w('gzip')) return 'br'
  if (w('gzip') > 0) return 'gzip'
  return null
}

const cache = new Map<string, Uint8Array>()
const CACHE_MAX = 64

async function encode(body: Uint8Array, enc: Encoding, quality: number): Promise<Uint8Array> {
  if (enc === 'br') {
    return brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength } })
  }
  return gzipAsync(body, { level: quality >= 9 ? 9 : 6 })
}

function withVary(headers: Headers): void {
  const vary = headers.get('Vary')
  if (!vary) headers.set('Vary', 'Accept-Encoding')
  else if (!/accept-encoding|\*/i.test(vary)) headers.set('Vary', `${vary}, Accept-Encoding`)
}

/**
 * Compress `res` for `req` when that is safe and worthwhile; otherwise return it untouched (apart
 * from `Vary` on a response that could have varied). Never throws: a failure to compress returns the
 * original, uncompressed answer.
 */
export async function compressResponse(req: Request, res: Response): Promise<Response> {
  try {
    if (req.method === 'HEAD' || res.status < 200 || res.status === 204 || res.status === 304 || !res.body) return res
    const type = res.headers.get('Content-Type')
    if (!isCompressibleType(type)) return res
    if (res.headers.has('Content-Encoding') || req.headers.has('Range') || res.status === 206) return res
    const enc = negotiateEncoding(req.headers.get('Accept-Encoding'))
    const declared = Number(res.headers.get('Content-Length'))
    if (Number.isFinite(declared) && declared > 0 && declared < MIN_COMPRESS_BYTES) return res

    const headers = new Headers(res.headers)
    withVary(headers)
    if (!enc) return new Response(res.body, { status: res.status, statusText: res.statusText, headers })

    const immutable = /\bimmutable\b/i.test(res.headers.get('Cache-Control') ?? '')
    const key = immutable ? `${enc}:${new URL(req.url).pathname}` : ''
    let out = key ? cache.get(key) : undefined
    if (!out) {
      const raw = new Uint8Array(await res.arrayBuffer())
      if (raw.byteLength < MIN_COMPRESS_BYTES) return new Response(raw as BodyInit, { status: res.status, statusText: res.statusText, headers })
      out = await encode(raw, enc, immutable ? 9 : 4)
      if (key) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
        cache.set(key, out)
      }
    }
    headers.set('Content-Encoding', enc)
    headers.set('Content-Length', String(out.byteLength))
    const etag = headers.get('ETag')
    if (etag && !etag.startsWith('W/')) headers.set('ETag', `W/${etag}`)
    return new Response(out as BodyInit, { status: res.status, statusText: res.statusText, headers })
  } catch (err) {
    console.warn('[compress] skipped:', String(err))
    return res
  }
}
