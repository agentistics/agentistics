import { describe, expect, test } from 'bun:test'
import { handleShellRoute, resolveShellTarget } from './shell-web'
import type { StartHost } from '../cli-start'

/** The routes under test need no host; the ones that do are covered by their own scope checks. */
const HOST = {} as StartHost

async function call(method: string, path: string): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handleShellRoute(new Request(url, { method }), url, HOST, 'en')
}

describe('GET /api/shell/stream', () => {
  test('a request with no id is a bad request, not an empty stream', async () => {
    const res = await call('GET', '/api/shell/stream')
    expect(res?.status).toBe(400)
  })

  test('an id that is not an open shell is a clean 404', async () => {
    // SCOPE. The id is resolved against `shells.json` and nothing else — an id from the session
    // registry is exactly as unknown here as one nobody ever minted.
    const res = await call('GET', '/api/shell/stream?id=00000000-0000-4000-8000-000000000000')
    expect(res?.status).toBe(404)
  })

  test('a path that is not ours falls through, so index.ts can keep routing', async () => {
    expect(await call('GET', '/api/shell/nope')).toBeNull()
  })
})

describe('resolveShellTarget — the directory always comes from a record, never the caller', () => {
  const rows = [{ id: 'agentop-1', conversationId: 'c-1', cwd: '/repo' }]
  const SID = 'ses_' + 'a'.repeat(32)
  test('a fleet row by its id or its conversation', async () => {
    expect(await resolveShellTarget(rows, 'c-1')).toEqual({ sessionId: 'agentop-1', cwd: '/repo' })
  })
  test('a NATIVE session (UI.UNIFY): the engine\'s recorded directory', async () => {
    expect(await resolveShellTarget(rows, SID, async id => (id === SID ? '/work' : null))).toEqual({ sessionId: SID, cwd: '/work' })
  })
  test('unknown everywhere is null — refused as unknown, never a shell somewhere', async () => {
    expect(await resolveShellTarget(rows, SID)).toBeNull()
    expect(await resolveShellTarget(rows, SID, async () => null)).toBeNull()
  })
})
