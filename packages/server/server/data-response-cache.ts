/**
 * data-response-cache.ts — one build of `/api/data` is encoded ONCE per encoding, for every client.
 *
 * A dashboard refetches `/api/data` on every `change`, and each response used to be compressed per
 * request: 5 MB of JSON through brotli is ~150 ms of CPU, so ten tabs (six here, seven from another
 * notebook in the owner's case) each refetching at every change kept the server near 134 % of a core
 * with only a couple of builds in the window. Now:
 *  - the encoded bytes are keyed by (build, the live fields, encoding) and shared by every client;
 *  - the ETag names exactly that key, so a client whose copy is current gets a `304` and no body;
 *  - the build is identified by object identity (`versionOf`), never by hashing 5 MB.
 *
 * The live fields (open sessions, presence) are part of the key because they differ per moment, not per
 * build; when they have not moved, neither has the response.
 */
import { brotliCompress, gzip, constants } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { Encoding } from './http-compress'

const gz = promisify(gzip)
const br = promisify(brotliCompress)

const versions = new WeakMap<object, number>()
let nextVersion = 1
/** A stable small id for one build object. */
export function versionOf(build: object): number {
  let v = versions.get(build)
  if (v === undefined) { v = nextVersion++; versions.set(build, v) }
  return v
}

export interface EncodedData { bytes: Uint8Array; etag: string; encoding: Encoding | null }

const cache = new Map<string, Promise<Uint8Array>>()
const MAX_ENTRIES = 12

/** Strong-enough validator: the build, a hash of the live fields, the variant. */
export function etagFor(version: number, liveJson: string, encoding: Encoding | null, slim: boolean): string {
  const h = createHash('sha1').update(liveJson).digest('base64url').slice(0, 10)
  return `W/"d${version}-${h}-${slim ? 's' : 'f'}-${encoding ?? 'id'}"`
}

/** Does the request's If-None-Match name this validator? */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false
  return header.split(',').some(t => t.trim() === etag || t.trim() === '*')
}

/**
 * The encoded body for (build, live, encoding): computed on first ask, shared by every concurrent and
 * later asker (the Promise is cached, so two clients arriving together compress once).
 */
export function encodedBody(
  version: number, liveJson: string, encoding: Encoding | null, slim: boolean, body: () => string,
): { etag: string; bytes: Promise<Uint8Array> } {
  const etag = etagFor(version, liveJson, encoding, slim)
  let p = cache.get(etag)
  if (!p) {
    p = (async () => {
      const raw = Buffer.from(body())
      if (encoding === 'br') return br(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength } })
      if (encoding === 'gzip') return gz(raw, { level: 6 })
      return raw
    })()
    p.catch(() => cache.delete(etag))
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
    cache.set(etag, p)
  }
  return { etag, bytes: p }
}

/** Tests only. */
export function forgetDataResponses(): void { cache.clear() }
