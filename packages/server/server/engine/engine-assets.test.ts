import { describe, expect, it } from 'bun:test'
import { applyAssetVerdict, assetVerdict } from './engine-assets'

describe('engine asset types', () => {
  it('types scripts and styles whatever the engine said', () => {
    const res = applyAssetVerdict('/api/engine/x/a/m.mjs', new Response('1', { headers: { 'Content-Type': 'application/octet-stream' } }))
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(assetVerdict('/api/engine/x/a.js')).toEqual({ kind: 'type', contentType: 'text/javascript; charset=utf-8' })
    expect(assetVerdict('/api/engine/x/a.CSS')).toEqual({ kind: 'type', contentType: 'text/css; charset=utf-8' })
  })
  it('does not serve wasm — the CSP does not allow it', async () => {
    const res = applyAssetVerdict('/api/engine/x/a.wasm', new Response('x'))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('asset_type_not_allowed')
  })
  it('leaves errors, unknown types and other paths alone', () => {
    expect(applyAssetVerdict('/api/engine/x/a.js', new Response('no', { status: 500 })).status).toBe(500)
    expect(assetVerdict('/api/engine/x/data.bin').kind).toBe('passthrough')
    expect(assetVerdict('/api/provider/a.wasm').kind).toBe('passthrough')
  })
})
