/**
 * capture.test.ts — `createCapturingFetch` + `writeCapture` against a stub `fetch` and a tmp
 * directory. No network, no real home dir (spec §9).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCounters, createCapturingFetch, resetCaptureCounters, writeCapture } from './capture.ts'

// A value shaped like a real key header, built at runtime — this test asserts it appears NOWHERE
// in what the capturing fetch records, so the sentinel must never itself be a literal that greps
// as a genuine secret in this file's history.
const KEY_SENTINEL = 'sk-ant-' + 'sentinel-' + 'z'.repeat(40)

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-provider-capture-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

function stubFetch(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch
}

describe('createCapturingFetch', () => {
  test('forwards input/init to inner untouched and returns the same response', async () => {
    let seenInput: unknown
    let seenInit: unknown
    const inner = (async (input: unknown, init?: unknown) => {
      seenInput = input
      seenInit = init
      return new Response('{"id":"msg_1"}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const capturing = createCapturingFetch(inner)
    const init = { method: 'POST', headers: { [`x-api-key`]: KEY_SENTINEL }, body: '{"prompt":"hi"}' }
    const response = await capturing.fetch('https://api.anthropic.com/v1/messages', init)

    expect(seenInput).toBe('https://api.anthropic.com/v1/messages')
    expect(seenInit).toBe(init)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"id":"msg_1"}')
  })

  test('records status, allowlisted headers and the body of every call — request headers never appear', async () => {
    const inner = stubFetch(200, '{"id":"msg_1","model":"claude-opus-5"}', {
      'request-id': 'req_1',
      'anthropic-organization-id': 'org_1',
      'set-cookie': 'session=abc',
    })
    const capturing = createCapturingFetch(inner)

    await capturing.fetch('https://api.anthropic.com/v1/messages', {
      headers: { [`x-api-key`]: KEY_SENTINEL, [`authorization`]: `Bearer ${KEY_SENTINEL}` },
    })

    const exchanges = capturing.exchanges()
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]?.status).toBe(200)
    expect(exchanges[0]?.body).toBe('{"id":"msg_1","model":"claude-opus-5"}')
    expect(exchanges[0]?.headers).toMatchObject({ 'request-id': 'req_1' })
    expect(Object.keys(exchanges[0]?.headers ?? {}).sort()).not.toContain('anthropic-organization-id')
    expect(Object.keys(exchanges[0]?.headers ?? {}).sort()).not.toContain('set-cookie')
    const serialized = JSON.stringify(exchanges)
    expect(serialized).not.toContain(KEY_SENTINEL)
    expect(serialized).not.toContain('org_1')
    expect(serialized).not.toContain('session=abc')
  })

  test('requestSent flips true the moment inner is called, before any response is known', async () => {
    let resolveInner: (r: Response) => void = () => {}
    const inner = (() =>
      new Promise<Response>(resolve => {
        resolveInner = resolve
      })) as unknown as typeof fetch
    const capturing = createCapturingFetch(inner)

    expect(capturing.requestSent()).toBe(false)
    const pending = capturing.fetch('https://api.anthropic.com/v1/messages')
    expect(capturing.requestSent()).toBe(true)
    resolveInner(new Response('{}', { status: 200 }))
    await pending
  })

  test('requestCount increments per call and exchanges() returns a fresh array each time', async () => {
    const inner = stubFetch(200, '{"id":"msg_1"}')
    const capturing = createCapturingFetch(inner)
    await capturing.fetch('https://api.anthropic.com/v1/messages')
    await capturing.fetch('https://api.anthropic.com/v1/messages')
    expect(capturing.requestCount()).toBe(2)
    expect(capturing.exchanges()).toHaveLength(2)
    const a = capturing.exchanges()
    const b = capturing.exchanges()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  test('a rejection from inner propagates unchanged — the wrapper never swallows or reclassifies it', async () => {
    const boom = new Error('network down')
    const inner = (async () => {
      throw boom
    }) as unknown as typeof fetch
    const capturing = createCapturingFetch(inner)
    await expect(capturing.fetch('https://api.anthropic.com/v1/messages')).rejects.toBe(boom)
    expect(capturing.requestSent()).toBe(true)
    expect(capturing.exchanges()).toHaveLength(0)
  })
})

describe('writeCapture', () => {
  afterEach(() => resetCaptureCounters())

  test('writes a 0600 file at the sha256 path under a 0700 shard directory', async () => {
    await withTempDir(async dir => {
      const ref = await writeCapture({ status: 200, headers: { 'request-id': 'req_1' }, body: '{"id":"msg_1"}' }, { dir })
      expect(ref).toBeDefined()
      if (!ref) throw new Error('expected a CaptureRef')

      const shardDir = join(dir, ref.sha256.slice(0, 2))
      const finalPath = join(shardDir, ref.sha256)
      expect(await modeOf(shardDir)).toBe(0o700)
      expect(await modeOf(finalPath)).toBe(0o600)

      const written = JSON.parse(await readFile(finalPath, 'utf8'))
      expect(written).toEqual({ status: 200, headers: { 'request-id': 'req_1' }, body: '{"id":"msg_1"}' })
      expect(ref.bytes).toBe(Buffer.byteLength(JSON.stringify(written), 'utf8'))
    })
  })

  test('a second identical write reuses the existing file rather than writing it twice', async () => {
    await withTempDir(async dir => {
      const exchange = { status: 200, headers: {}, body: '{"id":"msg_1"}' }
      const first = await writeCapture(exchange, { dir })
      const second = await writeCapture(exchange, { dir })
      expect(first).toEqual(second)
      if (!first) throw new Error('expected a CaptureRef')

      const shardDir = join(dir, first.sha256.slice(0, 2))
      const entries = await readdir(shardDir)
      // exactly the one final file — no leftover temp files from either write
      expect(entries).toEqual([first.sha256])
    })
  })

  test('a different exchange hashes to a different path', async () => {
    await withTempDir(async dir => {
      const a = await writeCapture({ status: 200, headers: {}, body: '{"id":"msg_1"}' }, { dir })
      const b = await writeCapture({ status: 200, headers: {}, body: '{"id":"msg_2"}' }, { dir })
      expect(a?.sha256).not.toBe(b?.sha256)
    })
  })

  test('failure (unwritable dir) → undefined, and the counter increments — never a throw', async () => {
    await withTempDir(async dir => {
      const blocked = join(dir, 'blocked')
      await mkdir(blocked, { mode: 0o500 })
      const before = captureCounters.capture_failed
      const ref = await writeCapture({ status: 200, headers: {}, body: '{"id":"msg_1"}' }, { dir: blocked })
      expect(ref).toBeUndefined()
      expect(captureCounters.capture_failed).toBe(before + 1)
    })
  })

  test('resetCaptureCounters zeroes the counter for the next test', () => {
    captureCounters.capture_failed = 5
    resetCaptureCounters()
    expect(captureCounters.capture_failed).toBe(0)
  })
})
