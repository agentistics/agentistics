import type { EngineBook, EngineBookContext } from '@agentistics/engine-api'
import { buildFlowOpEnv } from './book-flow-env'

export const BOOK_ABSENT_MESSAGE = 'book not available in this build'

export interface BookRouteDeps {
  /** The engine's `book` capability, when this build has one. */
  book: EngineBook | undefined
  /** Resolves the actor from the session proof only (`book-actor.ts`). */
  context: (bodyOverride?: { session?: unknown } | null) => Promise<EngineBookContext>
  /** The server environment; only the names the flow transport consumes are copied from it. */
  env: Record<string, string | undefined>
  json: (body: unknown, status?: number) => Response
}

/**
 * PURE. The flow-op transport's exit code → HTTP status (§10.1): 0 answers 200 (the op's own `ok:false` is a
 * result, not a crash), 2 is the caller's fault (unknown op / bad input) → 400, 3 is "the book is not reachable"
 * → 503, and anything else (1, an internal error) → 500.
 */
export function flowOpStatus(exitCode: number): number {
  if (exitCode === 0) return 200
  if (exitCode === 2) return 400
  if (exitCode === 3) return 503
  return 500
}

/**
 * `/api/book/*` and `/api/flow/op/*`. Returns null when the path is not one of these, so the caller
 * keeps routing. Request bodies never supply an environment map: accepting one would let a caller
 * smuggle process configuration into a server-side operation.
 */
export async function handleBookRoutes(req: Request, url: URL, deps: BookRouteDeps): Promise<Response | null> {
  const { book, json } = deps
  if (url.pathname === '/api/flow/op' || url.pathname.startsWith('/api/flow/op/')) {
    if (!book) return json({ error: BOOK_ABSENT_MESSAGE, sentence: BOOK_ABSENT_MESSAGE }, 501)
    if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    const name = decodeURIComponent(url.pathname.slice('/api/flow/op/'.length))
    if (url.pathname === '/api/flow/op' || !name) return json({ ok: false, error: 'op-name-required' }, 400)
    const body = await req.json().catch(() => ({})) as { stdin?: unknown; env?: unknown; session?: unknown }
    // `abrir-sucessor` included (slice 2): the engine spawns through the host's `EngineBookHost`, and only for a
    // write the runtime admits (an active reservation's runId and a verified leader of it).
    const context = await deps.context(body)
    const result = await book.invokeFlowOpTransport(name, {
      stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
      env: buildFlowOpEnv(deps.env),
      context,
    })
    return new Response(result.stdout, { status: flowOpStatus(result.exitCode), headers: { 'Content-Type': 'application/json' } })
  }
  if (url.pathname === '/api/book' || url.pathname.startsWith('/api/book/')) {
    // `/api/book/takeover` and `/api/book/passagem` included: the engine answers them (501 itself on a host
    // without `EngineBookHost`). The actor is read from a clone, so the engine still receives the body and
    // re-checks the takeover proof with the host's verifier.
    if (!book) return json({ error: BOOK_ABSENT_MESSAGE, sentence: BOOK_ABSENT_MESSAGE }, 501)
    return book.handleHttp(req, await deps.context())
  }
  return null
}
