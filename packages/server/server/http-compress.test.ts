import { describe, expect, test } from 'bun:test'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import { compressResponse, negotiateEncoding, isCompressibleType } from './http-compress'

const big = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `session-${i}`, tokens: i * 7 })) })
const req = (enc?: string, init: RequestInit = {}) => new Request('http://x/api/data', { headers: enc ? { 'Accept-Encoding': enc } : {}, ...init })
const json = (body = big) => new Response(body, { headers: { 'Content-Type': 'application/json', Origin: 'x' } })

describe('negotiateEncoding', () => {
  test('prefers br, falls back to gzip, honours q=0 and *', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br')
    expect(negotiateEncoding('gzip')).toBe('gzip')
    expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip')
    expect(negotiateEncoding('gzip;q=1, br;q=0.5')).toBe('gzip')
    expect(negotiateEncoding('*')).toBe('br')
    expect(negotiateEncoding('identity')).toBeNull()
    expect(negotiateEncoding(null)).toBeNull()
  })
})

describe('compressResponse', () => {
  test('gzip body decodes to the same JSON', async () => {
    const res = await compressResponse(req('gzip'), json())
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Vary')).toContain('Accept-Encoding')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    const raw = Buffer.from(await res.arrayBuffer())
    expect(Number(res.headers.get('Content-Length'))).toBe(raw.byteLength)
    expect(raw.byteLength).toBeLessThan(big.length / 3)
    expect(gunzipSync(raw).toString()).toBe(big)
  })
  test('brotli body decodes to the same JSON', async () => {
    const res = await compressResponse(req('br, gzip'), json())
    expect(res.headers.get('Content-Encoding')).toBe('br')
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(big)
  })
  test('no Accept-Encoding: untouched body, Vary still set', async () => {
    const res = await compressResponse(req(), json())
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Vary')).toContain('Accept-Encoding')
    expect(await res.text()).toBe(big)
  })
  test('a small body is not compressed', async () => {
    const res = await compressResponse(req('gzip'), json('{"ok":true}'))
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(await res.text()).toBe('{"ok":true}')
  })
  test('SSE is never compressed or buffered', async () => {
    let cancelled = false
    const stream = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('data: x\n\n')) }, cancel() { cancelled = true } })
    const sse = new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    const res = await compressResponse(req('gzip, br'), sse)
    expect(res).toBe(sse)
    expect(res.headers.get('Content-Encoding')).toBeNull()
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('data: x\n\n')
    await reader.cancel()
    expect(cancelled).toBe(true)
  })
  test('already-encoded, ranged, HEAD, 304 and binary responses are left alone', async () => {
    const enc = new Response(big, { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })
    expect(await compressResponse(req('gzip'), enc)).toBe(enc)
    const j = json()
    expect(await compressResponse(req('gzip', { headers: { 'Accept-Encoding': 'gzip', Range: 'bytes=0-9' } }), j)).toBe(j)
    const h = json()
    expect(await compressResponse(new Request('http://x/', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } }), h)).toBe(h)
    const nm = new Response(null, { status: 304 })
    expect(await compressResponse(req('gzip'), nm)).toBe(nm)
    const png = new Response(big, { headers: { 'Content-Type': 'image/png' } })
    expect(await compressResponse(req('gzip'), png)).toBe(png)
  })
  test('hashed (immutable) assets are compressed once and reused', async () => {
    const js = () => new Response(big, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=31536000, immutable' } })
    const r = () => new Request('http://x/assets/index-abc123.js', { headers: { 'Accept-Encoding': 'gzip' } })
    const a = await compressResponse(r(), js())
    const b = await compressResponse(r(), js())
    expect(Buffer.from(await a.arrayBuffer()).equals(Buffer.from(await b.arrayBuffer()))).toBe(true)
  })
  test('a strong ETag becomes weak on the transformed body', async () => {
    const res = await compressResponse(req('gzip'), new Response(big, { headers: { 'Content-Type': 'text/html', ETag: '"abc"' } }))
    expect(res.headers.get('ETag')).toBe('W/"abc"')
  })
})

test('isCompressibleType is a closed list', () => {
  expect(isCompressibleType('application/json; charset=utf-8')).toBe(true)
  expect(isCompressibleType('text/event-stream')).toBe(false)
  expect(isCompressibleType('application/x-ndjson')).toBe(false)
  expect(isCompressibleType(null)).toBe(false)
})
