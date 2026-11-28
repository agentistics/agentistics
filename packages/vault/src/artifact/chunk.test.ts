import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  BackupStreamError, CHUNK_BYTES, SEALED_CHUNK_MAX_BYTES, chunkCount, newObjectKey,
  openChunk, openChunks, sealChunk, sealChunks,
} from './chunk'
import vectors from './vectors.json'

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const c of it) out.push(c)
  return out
}
async function sealAll(dek: Uint8Array, objectId: string, plain: Uint8Array, chunkSize: number, pieces = [plain]): Promise<Uint8Array[]> {
  return collect((async function* () {
    for await (const c of sealChunks(pieces, { dek, objectId, size: plain.length, chunkSize })) yield c.data
  })())
}
async function openAll(dek: Uint8Array, objectId: string, total: number, sealed: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(Buffer.concat(await collect(openChunks(sealed, { dek, objectId, total }))))
}
async function failureOf(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) {
    if (e instanceof BackupStreamError) return e.code
    throw e
  }
  return 'no error'
}

const dek = newObjectKey()
const plain = new Uint8Array(randomBytes(100))
const SIZE = 16

describe('chunk seal', () => {
  it('uses 4 MiB chunks', () => { expect(CHUNK_BYTES).toBe(4 * 1024 * 1024) })

  it('counts chunks, an empty object being one empty chunk', () => {
    expect([chunkCount(0), chunkCount(1), chunkCount(CHUNK_BYTES), chunkCount(CHUNK_BYTES + 1)]).toEqual([1, 1, 1, 2])
    expect(chunkCount(100, 16)).toBe(7)
    expect(() => chunkCount(-1)).toThrow()
    expect(() => chunkCount(1.5)).toThrow()
  })

  it('mints fresh 256-bit object keys', () => {
    const a = newObjectKey(), b = newObjectKey()
    expect(a.length).toBe(32)
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it('matches the compatibility vectors', async () => {
    const v = vectors.chunk
    const sealed = await sealAll(hex(v.dek), v.objectId, hex(v.plaintext), v.chunkSize)
    expect(sealed.map(toHex)).toEqual(v.chunks)
    expect(toHex(sealChunk({ dek: hex(v.dek), objectId: v.objectId, index: 0, total: 1, plaintext: new Uint8Array(0) }))).toBe(v.emptyObjectChunk)
    expect(toHex(await openAll(hex(v.dek), v.objectId, v.chunks.length, v.chunks.map(hex)))).toBe(v.plaintext)
  })

  it('round-trips at the real chunk size', async () => {
    const big = new Uint8Array(randomBytes(CHUNK_BYTES * 2 + 5))
    const out: Uint8Array[] = []
    for await (const c of sealChunks([big], { dek, objectId: 'o', size: big.length })) out.push(c.data)
    expect(out.map(c => c.length)).toEqual([CHUNK_BYTES + 16, CHUNK_BYTES + 16, 21])
    expect(Buffer.from(await openAll(dek, 'o', 3, out)).equals(Buffer.from(big))).toBe(true)
  })

  it('re-chunks arbitrary input pieces (async source) into the same output', async () => {
    const pieces = [plain.subarray(0, 3), plain.subarray(3, 3), plain.subarray(3, 50), plain.subarray(50)]
    const whole = await sealAll(dek, 'o', plain, SIZE)
    const split = await sealAll(dek, 'o', plain, SIZE, pieces)
    expect(split.map(toHex)).toEqual(whole.map(toHex))
    const async_ = (async function* () { yield* pieces })()
    const fromAsync: string[] = []
    for await (const c of sealChunks(async_, { dek, objectId: 'o', size: plain.length, chunkSize: SIZE })) fromAsync.push(toHex(c.data))
    expect(fromAsync).toEqual(whole.map(toHex))
  })

  it('numbers the chunks it yields', async () => {
    const seen: [number, number][] = []
    for await (const c of sealChunks([plain], { dek, objectId: 'o', size: plain.length, chunkSize: SIZE })) seen.push([c.index, c.total])
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6].map(i => [i, 7]))
  })

  it('does not alias the source buffer (a reused read buffer is safe)', async () => {
    const buf = new Uint8Array(SIZE)
    const source = (function* () { for (let i = 0; i < 3; i++) { buf.fill(i + 1); yield buf } })()
    const sealed: Uint8Array[] = []
    for await (const c of sealChunks(source, { dek, objectId: 'o', size: SIZE * 3, chunkSize: SIZE })) sealed.push(c.data)
    expect([...await openAll(dek, 'o', 3, sealed)]).toEqual([...new Array(16).fill(1), ...new Array(16).fill(2), ...new Array(16).fill(3)])
  })

  it('handles an empty object and an exact multiple of the chunk size', async () => {
    const empty = await sealAll(dek, 'o', new Uint8Array(0), SIZE, [])
    expect(empty.length).toBe(1)
    expect((await openAll(dek, 'o', 1, empty)).length).toBe(0)
    const exact = plain.subarray(0, SIZE * 2)
    const sealed = await sealAll(dek, 'o', exact, SIZE)
    expect(sealed.length).toBe(2)
    expect(toHex(await openAll(dek, 'o', 2, sealed))).toBe(toHex(exact))
  })

  it('refuses a source shorter or longer than the declared size', async () => {
    const run = (size: number) => failureOf((async () => { for await (const _ of sealChunks([plain], { dek, objectId: 'o', size, chunkSize: SIZE })) { /* drain */ } })())
    expect(await run(plain.length + 1)).toBe('size-mismatch')
    expect(await run(plain.length - 1)).toBe('size-mismatch')
    expect(await run(SIZE)).toBe('size-mismatch')
    expect(await run(0)).toBe('size-mismatch')
  })

  it('never yields the final chunk of a source that turns out too long', async () => {
    const got: number[] = []
    const pieces = [plain.subarray(0, SIZE), plain.subarray(SIZE, SIZE * 2), plain.subarray(SIZE * 2)]
    await failureOf((async () => { for await (const c of sealChunks(pieces, { dek, objectId: 'o', size: SIZE * 2, chunkSize: SIZE })) got.push(c.index) })())
    expect(got).toEqual([0])
  })

  it('refuses bad arguments', () => {
    const base = { dek, objectId: 'o', index: 0, total: 1, plaintext: plain }
    expect(() => sealChunk({ ...base, dek: new Uint8Array(31) })).toThrow()
    expect(() => sealChunk({ ...base, objectId: '' })).toThrow()
    expect(() => sealChunk({ ...base, index: 1 })).toThrow()
    expect(() => sealChunk({ ...base, index: -1 })).toThrow()
    expect(() => sealChunk({ ...base, index: 0.5, total: 2 })).toThrow()
    expect(() => sealChunk({ ...base, total: 0 })).toThrow()
    expect(() => sealChunk({ ...base, plaintext: new Uint8Array(CHUNK_BYTES + 1) })).toThrow()
  })
})

describe('chunk open refuses tampering', () => {
  const sealed = () => sealChunk({ dek, objectId: 'obj', index: 1, total: 3, plaintext: plain })
  const base = () => ({ dek, objectId: 'obj', index: 1, total: 3, sealed: sealed() })

  it('opens the untouched chunk', () => {
    const r = openChunk(base())
    expect(r.ok && toHex(r.plaintext)).toBe(toHex(plain))
  })

  const refused = { ok: false as const, code: 'tampered' as const }
  const flip = (at: number) => { const s = sealed(); s[at < 0 ? s.length + at : at]! ^= 1; return s }

  it('ciphertext, tag, length', () => {
    expect(openChunk({ ...base(), sealed: flip(0) })).toEqual(refused)
    expect(openChunk({ ...base(), sealed: flip(-1) })).toEqual(refused)
    expect(openChunk({ ...base(), sealed: sealed().subarray(1) })).toEqual(refused)
    expect(openChunk({ ...base(), sealed: sealed().subarray(0, -1) })).toEqual(refused)
    expect(openChunk({ ...base(), sealed: new Uint8Array(3) })).toEqual(refused)
    expect(openChunk({ ...base(), sealed: new Uint8Array(SEALED_CHUNK_MAX_BYTES + 1) })).toEqual(refused)
  })

  it('objectId, index, total, key', () => {
    expect(openChunk({ ...base(), objectId: 'obk' })).toEqual(refused)
    expect(openChunk({ ...base(), index: 2 })).toEqual(refused)
    expect(openChunk({ ...base(), total: 2 })).toEqual(refused)
    expect(openChunk({ ...base(), total: 4 })).toEqual(refused)
    expect(openChunk({ ...base(), dek: newObjectKey() })).toEqual(refused)
    expect(openChunk({ ...base(), index: 3 })).toEqual(refused)
    expect(openChunk({ ...base(), objectId: '' })).toEqual(refused)
    expect(openChunk({ ...base(), dek: new Uint8Array(4) })).toEqual(refused)
  })

  it('reorder, truncate, extend, duplicate, splice', async () => {
    const a = await sealAll(dek, 'a', plain, SIZE)
    const sameKeyOtherObject = await sealAll(dek, 'b', plain, SIZE)
    const n = a.length
    const run = (chunks: Uint8Array[], total = n) => failureOf(openAll(dek, 'a', total, chunks))
    expect(await run([a[1]!, a[0]!, ...a.slice(2)])).toBe('tampered')
    expect(await run(a.slice(0, -1))).toBe('truncated')
    expect(await run([])).toBe('truncated')
    expect(await run(a.slice(0, -1), n - 1)).toBe('tampered') // truncated AND total rewritten to match
    expect(await run([...a, a[n - 1]!])).toBe('extra-chunk')
    expect(await run([a[0]!, a[0]!, ...a.slice(2)])).toBe('tampered')
    expect(await run([sameKeyOtherObject[0]!, ...a.slice(1)])).toBe('tampered')
    const longer = await sealAll(dek, 'a', new Uint8Array(randomBytes(200)), SIZE)
    expect(await run([longer[0]!, ...a.slice(1)])).toBe('tampered')
  })

  it('a total that no object can have never opens as an empty object', async () => {
    for (const total of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await failureOf(openAll(dek, 'a', total, []))).toBe('tampered')
    }
  })

  it('an error carries a code and never the input', async () => {
    try { await openAll(dek, 'SECRET-OBJECT-ID', 1, [new Uint8Array(40)]); throw new Error('opened') } catch (e) {
      expect(e).toBeInstanceOf(BackupStreamError)
      expect(String((e as Error).message)).not.toContain('SECRET-OBJECT-ID')
    }
  })
})
