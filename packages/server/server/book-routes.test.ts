import { describe, expect, test } from 'bun:test'
import type { EngineBook, EngineBookContext } from '@agentistics/engine-api'
import { bookActorFromRequest } from './book-actor'
import { flowOpStatus, handleBookRoutes } from './book-routes'

interface Seen {
  http: Array<{ url: string; context: EngineBookContext }>
  flow: Array<{ name: string; input: { stdin?: string; env?: Record<string, string | undefined>; context?: EngineBookContext } }>
}

function fakeBook(exitCode = 0): { book: EngineBook; seen: Seen } {
  const seen: Seen = { http: [], flow: [] }
  const book: EngineBook = {
    handleHttp: async (req, context) => {
      seen.http.push({ url: req.url, context })
      return new Response('{"handled":true}', { status: 200 })
    },
    executeCli: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    invokeFlowOpTransport: async (name, input) => {
      seen.flow.push({ name, input })
      return { stdout: '{"ran":true}', exitCode }
    },
  }
  return { book, seen }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The same wiring index.ts uses: the actor comes from bookActorFromRequest, the proof check is injected. */
function depsFor(req: Request, book: EngineBook | undefined, env: Record<string, string | undefined> = {}) {
  return {
    book,
    json,
    env,
    context: async (bodyOverride?: { session?: unknown } | null) => ({
      actor: await bookActorFromRequest(req, {
        verify: async (id, token) => (id === 'managed-1' && token === 'valid' ? 'managed-1' : null),
        roleOf: async () => 'leader' as const,
      }, bodyOverride),
    }),
  }
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

async function run(req: Request, book: EngineBook | undefined, env?: Record<string, string | undefined>) {
  return handleBookRoutes(req, new URL(req.url), depsFor(req, book, env))
}

describe('handleBookRoutes', () => {
  test('/api/book without a session proof reaches the engine as an unverified local user', async () => {
    const { book, seen } = fakeBook()
    const res = await run(new Request('http://localhost/api/book/page/abc'), book)
    expect(res?.status).toBe(200)
    expect(seen.http).toHaveLength(1)
    expect(seen.http[0]!.url).toBe('http://localhost/api/book/page/abc')
    expect(seen.http[0]!.context.actor).toEqual({ id: 'localShell', verified: false, role: 'user' })
  })

  test('/api/book with a valid proof reaches the engine as the managed session with its stored role', async () => {
    const { book, seen } = fakeBook()
    const req = post('/api/book/correct', { session: { id: 'managed-1', token: 'valid' } })
    await run(req, book)
    expect(seen.http[0]!.context.actor).toEqual({ id: 'managed-1', verified: true, role: 'leader' })
  })

  test('a forged actor in the body is ignored and a bad proof stays unverified', async () => {
    const { book, seen } = fakeBook()
    await run(post('/api/book/correct', { actor: { id: 'owner', verified: true, role: 'owner' }, session: { id: 'managed-1', token: 'wrong' } }), book)
    expect(seen.http[0]!.context.actor).toEqual({ id: 'localShell', verified: false, role: 'user' })
  })

  test('/api/flow/op/<name> passes the proof actor and stdin, and never the body env', async () => {
    const { book, seen } = fakeBook()
    const req = post('/api/flow/op/escrever', {
      stdin: 'hello',
      env: { LD_PRELOAD: '/tmp/evil.so', taskId: 'smuggled' },
      session: { id: 'managed-1', token: 'valid' },
    })
    const res = await run(req, book, { taskId: 'from-server', SECRET: 'must-not-leak' })
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe('{"ran":true}')
    expect(seen.flow).toHaveLength(1)
    const { name, input } = seen.flow[0]!
    expect(name).toBe('escrever')
    expect(input.stdin).toBe('hello')
    expect(input.context?.actor).toEqual({ id: 'managed-1', verified: true, role: 'leader' })
    expect(input.env?.taskId).toBe('from-server')
    expect(input.env).not.toHaveProperty('LD_PRELOAD')
    expect(input.env).not.toHaveProperty('SECRET')
    expect(JSON.stringify(input.env)).not.toContain('smuggled')
  })

  test('flow op without a proof is an unverified user; exit code 3 maps to 503', async () => {
    const { book, seen } = fakeBook(3)
    const res = await run(post('/api/flow/op/x', {}), book)
    expect(res?.status).toBe(503)
    expect(seen.flow[0]!.input.context?.actor).toEqual({ id: 'localShell', verified: false, role: 'user' })
  })

  test('flow op refuses a non-POST (405) without calling the engine', async () => {
    const { book, seen } = fakeBook()
    expect((await run(new Request('http://localhost/api/flow/op/x'), book))?.status).toBe(405)
    expect(seen.flow).toHaveLength(0)
  })

  test('slice 2: abrir-sucessor reaches the engine with the proof actor (the spawn is the engine\'s, through the host)', async () => {
    const { book, seen } = fakeBook()
    const res = await run(post('/api/flow/op/abrir-sucessor', { stdin: '{}', session: { id: 'managed-1', token: 'valid' } }), book)
    expect(res?.status).toBe(200)
    expect(seen.flow.map(f => f.name)).toEqual(['abrir-sucessor'])
    expect(seen.flow[0]!.input.context?.actor).toEqual({ id: 'managed-1', verified: true, role: 'leader' })
  })

  test('R4 the transport exit code maps to HTTP: 0→200, 2→400, 1→500, 3→503', async () => {
    for (const [exit, status] of [[0, 200], [2, 400], [1, 500], [3, 503], [7, 500]] as const) {
      const { book } = fakeBook(exit)
      expect((await run(post('/api/flow/op/livro-ler', {}), book))?.status).toBe(status)
    }
    expect(flowOpStatus(2)).toBe(400)
  })

  test('R6 /api/flow/op without a name is a 400 that never reaches the engine', async () => {
    const { book, seen } = fakeBook()
    for (const path of ['/api/flow/op', '/api/flow/op/']) {
      const res = await run(post(path, {}), book)
      expect(res?.status).toBe(400)
      expect(await res?.json()).toEqual({ ok: false, error: 'op-name-required' })
    }
    expect(seen.flow).toHaveLength(0)
  })

  test('slice 2: /api/book/takeover and /api/book/passagem reach the engine with the proof actor, and the body stays readable', async () => {
    const { book, seen } = fakeBook()
    const bodies: string[] = []
    const reading: EngineBook = { ...book, handleHttp: async (req, context) => { bodies.push(await req.text()); return book.handleHttp(req, context) } }
    for (const path of ['/api/book/takeover', '/api/book/passagem']) {
      const res = await run(post(path, { taskId: 't', bookmarkHash: 'b', session: { id: 'managed-1', token: 'valid' } }), reading)
      expect(res?.status).toBe(200)
    }
    expect(seen.http.map(h => new URL(h.url).pathname)).toEqual(['/api/book/takeover', '/api/book/passagem'])
    for (const h of seen.http) expect(h.context.actor).toEqual({ id: 'managed-1', verified: true, role: 'leader' })
    // The engine re-checks the very proof, so the request it receives still carries its body.
    for (const b of bodies) expect(JSON.parse(b)).toMatchObject({ taskId: 't', session: { id: 'managed-1', token: 'valid' } })
  })

  test('without the book capability /api/book/takeover answers the build\'s 501, never 405', async () => {
    const res = await run(post('/api/book/takeover', { taskId: 't' }), undefined)
    expect(res?.status).toBe(501)
    expect(await res?.json()).toEqual({ error: 'book not available in this build', sentence: 'book not available in this build' })
  })

  test('without the book capability both routes answer 501 "book not available in this build"', async () => {
    for (const req of [new Request('http://localhost/api/book/page/x'), post('/api/flow/op/x', {})]) {
      const res = await run(req, undefined)
      expect(res?.status).toBe(501)
      const body = await res?.json() as { error: string; sentence: string }
      expect(body.error).toBe('book not available in this build')
      expect(body.sentence).toBe('book not available in this build')
    }
  })

  test('any other path is not handled (null), so routing continues', async () => {
    const { book } = fakeBook()
    expect(await run(new Request('http://localhost/api/bookshelf'), book)).toBeNull()
    expect(await run(new Request('http://localhost/api/flows'), book)).toBeNull()
  })
})
