import { afterEach, describe, expect, test } from 'bun:test'
import {
  createRepoEntry, deleteRepoEntry, fetchTree, isWriteConflict, readRepoFile,
  renameRepoEntry, searchRepo, writeRepoFile,
} from './repoApi'

const originalFetch = globalThis.fetch

type Seen = { url: string; init: RequestInit | undefined }

/** Stubs `fetch` with a fixed JSON answer and records what it was called with. */
function stubJson(body: unknown, status = 200): Seen {
  const seen: Seen = { url: '', init: undefined }
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    seen.url = url
    seen.init = init
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }))
  }) as never
  return seen
}

/** Stubs `fetch` with a raw, non-JSON text body — a response that fails the contract before JSON
 *  parsing even starts (a proxy's HTML error page, say). */
function stubRaw(text: string, status = 200): Seen {
  const seen: Seen = { url: '', init: undefined }
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    seen.url = url
    seen.init = init
    return Promise.resolve(new Response(text, { status }))
  }) as never
  return seen
}

function stubThrow(err: unknown): void {
  globalThis.fetch = (() => Promise.reject(err)) as never
}

function timeoutError(): Error {
  const err = new Error('The operation timed out.')
  err.name = 'TimeoutError'
  return err
}

describe('repoApi — the requests it composes', () => {
  afterEach(() => { globalThis.fetch = originalFetch })

  test('fetchTree GETs /api/fleet/tree with id, path and lang, each encoded', async () => {
    const seen = stubJson({ ok: true, children: [{ name: 'a.ts', kind: 'file' }] })
    const out = await fetchTree('s 1', 'a b/c', 'pt')
    expect(seen.url).toBe('/api/fleet/tree?id=s%201&path=a%20b%2Fc&lang=pt')
    expect(out).toEqual({ ok: true, children: [{ name: 'a.ts', kind: 'file' }] })
  })

  test('searchRepo GETs /api/fleet/tree/search and carries `truncated` through', async () => {
    const seen = stubJson({ ok: true, hits: [{ kind: 'name', path: 'a.ts' }], truncated: true })
    const out = await searchRepo('s1', 'need le', 'en')
    expect(seen.url).toBe('/api/fleet/tree/search?id=s1&q=need%20le&lang=en')
    expect(out).toEqual({ ok: true, hits: [{ kind: 'name', path: 'a.ts' }], truncated: true })
  })

  test('readRepoFile GETs the file route and returns content plus mtime', async () => {
    const seen = stubJson({ ok: true, content: 'x', mtimeMs: 1 })
    const out = await readRepoFile('s1', 'a.ts', 'en')
    expect(seen.url).toBe('/api/fleet/tree/file?id=s1&path=a.ts&lang=en')
    expect(out).toEqual({ ok: true, content: 'x', mtimeMs: 1 })
  })

  test('readRepoFile carries the binary answer through instead of an empty file', async () => {
    stubJson({ ok: true, binary: true, name: 'logo.png', size: 4096 })
    const out = await readRepoFile('s1', 'logo.png', 'en')
    expect(out).toEqual({ ok: true, binary: true, name: 'logo.png', size: 4096 })
  })

  test('writeRepoFile PUTs content and the expected mtime as JSON', async () => {
    const seen = stubJson({ ok: true, mtimeMs: 2 })
    const out = await writeRepoFile('s1', 'a.ts', 'new content', 1, 'en')
    expect(seen.url).toBe('/api/fleet/tree/file?id=s1&path=a.ts&lang=en')
    expect(seen.init?.method).toBe('PUT')
    expect(JSON.parse(String(seen.init?.body))).toEqual({ content: 'new content', mtimeMs: 1 })
    expect(out).toEqual({ ok: true, mtimeMs: 2 })
  })

  test('createRepoEntry POSTs id, path and kind, with lang on the URL', async () => {
    const seen = stubJson({ ok: true })
    const out = await createRepoEntry('s1', 'new.txt', 'file', 'pt')
    expect(seen.url).toBe('/api/fleet/tree/entry?lang=pt')
    expect(seen.init?.method).toBe('POST')
    expect(JSON.parse(String(seen.init?.body))).toEqual({ id: 's1', path: 'new.txt', kind: 'file' })
    expect(out).toEqual({ ok: true })
  })

  test('renameRepoEntry PATCHes id, from and to', async () => {
    const seen = stubJson({ ok: true })
    await renameRepoEntry('s1', 'a.txt', 'b.txt', 'en')
    expect(seen.url).toBe('/api/fleet/tree/entry?lang=en')
    expect(seen.init?.method).toBe('PATCH')
    expect(JSON.parse(String(seen.init?.body))).toEqual({ id: 's1', from: 'a.txt', to: 'b.txt' })
  })

  test('deleteRepoEntry DELETEs with recursive as a query flag, and omits it when not asked', async () => {
    const recursive = stubJson({ ok: true })
    await deleteRepoEntry('s1', 'dir', true, 'en')
    expect(recursive.url).toBe('/api/fleet/tree/entry?id=s1&path=dir&lang=en&recursive=1')
    expect(recursive.init?.method).toBe('DELETE')

    const plain = stubJson({ ok: true })
    await deleteRepoEntry('s1', 'dir', false, 'en')
    expect(plain.url).toBe('/api/fleet/tree/entry?id=s1&path=dir&lang=en')
  })
})

describe('repoApi — a refusal is carried through, never re-worded', () => {
  afterEach(() => { globalThis.fetch = originalFetch })

  test('a 404 keeps the server’s own reason code AND its already-localized sentence', async () => {
    stubJson({ ok: false, reason: 'not-found', message: 'Esse caminho não existe.' }, 404)
    const out = await fetchTree('s1', 'gone', 'pt')
    expect(out).toEqual({
      ok: false,
      failure: 'refused',
      status: 404,
      reason: 'not-found',
      message: 'Esse caminho não existe.',
    })
  })

  test('a 400 bad_request is a refusal like any other', async () => {
    stubJson({ ok: false, reason: 'bad_request', message: 'id is required' }, 400)
    const out = await searchRepo('', 'q', 'en')
    expect(out).toEqual({
      ok: false, failure: 'refused', status: 400, reason: 'bad_request', message: 'id is required',
    })
  })

  test('the closed gate’s own `{error: "editor_disabled"}` body becomes a refusal with that reason and NO invented sentence', async () => {
    stubJson({ error: 'editor_disabled' }, 403)
    const out = await readRepoFile('s1', 'a.ts', 'pt')
    expect(out).toEqual({ ok: false, failure: 'refused', status: 403, reason: 'editor_disabled' })
    expect(out).not.toHaveProperty('message')
  })

  test('a write conflict is distinguishable and carries the CURRENT disk content and mtime', async () => {
    stubJson(
      { ok: false, reason: 'conflict', content: 'on disk now', mtimeMs: 9, message: 'changed' },
      409,
    )
    const out = await writeRepoFile('s1', 'a.ts', 'my edit', 1, 'en')
    expect(out).toEqual({
      ok: false,
      failure: 'refused',
      status: 409,
      reason: 'conflict',
      content: 'on disk now',
      mtimeMs: 9,
      message: 'changed',
    })
    expect(isWriteConflict(out)).toBe(true)
  })

  test('isWriteConflict is false for every other failure, including one that is merely 409', async () => {
    stubJson({ ok: false, reason: 'already-exists', message: 'Something is already there.' }, 409)
    const already = await writeRepoFile('s1', 'a.ts', 'x', 1, 'en')
    expect(isWriteConflict(already)).toBe(false)

    stubThrow(new TypeError('Failed to fetch'))
    const dead = await writeRepoFile('s1', 'a.ts', 'x', 1, 'en')
    expect(isWriteConflict(dead)).toBe(false)
  })

  test('a conflict body missing its content is NOT reported as a conflict the UI could act on', async () => {
    stubJson({ ok: false, reason: 'conflict', message: 'changed' }, 409)
    const out = await writeRepoFile('s1', 'a.ts', 'x', 1, 'en')
    expect(out.ok).toBe(false)
    expect(isWriteConflict(out)).toBe(false)
  })

  test('isWriteConflict checks `status` too, not only `reason` and the shape', () => {
    // A hand-built value with everything a real conflict carries EXCEPT the 409 — the guard's own
    // declared type says `status: 409`, and the check must actually read it rather than trust the
    // type annotation to have been honoured by whoever built the value.
    const wrongStatus = {
      ok: false as const,
      failure: 'refused' as const,
      status: 200,
      reason: 'conflict' as const,
      content: 'on disk now',
      mtimeMs: 9,
    }
    expect(isWriteConflict(wrongStatus)).toBe(false)
  })
})

describe('repoApi — a call that never got an answer is its own outcome', () => {
  afterEach(() => { globalThis.fetch = originalFetch })

  test('a dead server is `unreachable`, never an empty successful tree', async () => {
    stubThrow(new TypeError('Failed to fetch'))
    const out = await fetchTree('s1', '', 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'network' })
    expect(out).not.toHaveProperty('children')
  })

  test('a timeout is kept apart from a dead server', async () => {
    stubThrow(timeoutError())
    const out = await searchRepo('s1', 'q', 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'timeout' })
  })

  test('a body that is not JSON at all is `malformed`, never a confident empty result', async () => {
    stubRaw('<!doctype html><title>nope</title>', 200)
    const out = await searchRepo('s1', 'q', 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'malformed' })
    expect(out).not.toHaveProperty('hits')
  })

  test('a 200 whose body does not honour the contract is `malformed`, not an empty directory', async () => {
    stubJson({ ok: true }, 200)
    const out = await fetchTree('s1', '', 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'malformed' })
  })

  test('a search hit missing its own fields is `malformed`, not a hit list with a hole in it', async () => {
    // fetchTree validates every child; searchRepo used to validate only `Array.isArray(hits)`,
    // so a hit shaped wrong anywhere in the array reached the caller as if it were real.
    stubJson({ ok: true, hits: [{ kind: 'name' }], truncated: false })
    const out = await searchRepo('s1', 'q', 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'malformed' })
  })

  test('a content hit missing its line or text is `malformed` too', async () => {
    stubJson({ ok: true, hits: [{ kind: 'content', path: 'a.ts', line: 1 }], truncated: false })
    const out = await searchRepo('s1', 'q', 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'malformed' })
  })

  test('an `ok: false` with no reason code at all is `malformed` — there is nothing to report', async () => {
    stubJson({ ok: false }, 500)
    const out = await deleteRepoEntry('s1', 'a', false, 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'malformed' })
  })

  test('a successful read whose content is not a string is refused rather than rendered as an empty file', async () => {
    stubJson({ ok: true, content: null, mtimeMs: 3 })
    const out = await readRepoFile('s1', 'a.ts', 'en')
    expect(out).toEqual({ ok: false, failure: 'unreachable', cause: 'malformed' })
  })
})
