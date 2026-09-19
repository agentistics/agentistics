import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEditorTreeRoute } from './editor-web'
import { securityHeaders } from '../security-headers'
import type { StartHost } from '../cli-start'

// Same reason repo-probe.test.ts / editor-fs.test.ts strip these: a pre-commit hook running from a
// linked worktree exports GIT_DIR / GIT_INDEX_FILE pointing at the OUTER checkout, and `-C`/`cwd`
// do not override GIT_DIR for repository discovery.
const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_PREFIX
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

let root = ''
let repo = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentistics-editor-web-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
  git(repo, 'add', 'a.ts')
  git(repo, 'commit', '-q', '-m', 'init')
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

// `StartHost` (via `ControlHost`) carries many members no route here calls — the same posture
// `editor-fs.test.ts` and `shell-web.test.ts` already take for a host that is never driven beyond
// what `resolveSessionDirectory` reads (`host.sessions`). `ControlSessions` requires `sessions`,
// `attention` and `rang`; the mock supplies exactly those three and nothing more.
const noHost = {} as StartHost
const hostWith = (id: string, cwd: string): StartHost => ({
  ...noHost,
  sessions: async () => ({
    sessions: [{ id, conversationId: `${id}-conv`, cwd } as never],
    attention: 0,
    rang: [],
  }),
})

async function call(req: Request, host: StartHost, lang: 'en' | 'pt' = 'en') {
  const url = new URL(req.url)
  const res = await handleEditorTreeRoute(req, url, host, lang)
  expect(res).not.toBeNull()
  return { status: res!.status, body: await res!.json() }
}

describe('handleEditorTreeRoute', () => {
  test('an unexpected exception is a 500 with a code and a ref, never the raw message', async () => {
    const throwing = { ...noHost, sessions: async () => { throw new Error('EACCES: /home/secret/path/leak') } } as StartHost
    const { status, body } = await call(new Request('http://x/api/fleet/tree?id=s1&path='), throwing)
    expect(status).toBe(500)
    expect(body.error).toBe('internal_error')
    expect(typeof body.ref).toBe('string')
    expect(JSON.stringify(body)).not.toContain('/home/secret')
  })

  test('PATCH moving a folder into its own child is a 409 into-itself, with a sentence', async () => {
    const mk = new Request('http://x/api/fleet/tree/entry', { method: 'POST', body: JSON.stringify({ id: 's1', path: 'movedir', kind: 'dir' }) })
    await call(mk, hostWith('s1', repo))
    const mv = await call(new Request('http://x/api/fleet/tree/entry', {
      method: 'PATCH', body: JSON.stringify({ id: 's1', from: 'movedir', to: 'movedir/inner' }),
    }), hostWith('s1', repo), 'pt')
    expect(mv.status).toBe(409)
    expect(mv.body).toMatchObject({ ok: false, reason: 'into-itself' })
    expect(String(mv.body.message)).toContain('pasta')
  })

  test('an unknown route under the prefix falls through as null, so index.ts can keep looking', async () => {
    const req = new Request('http://x/api/fleet/tree/not-a-real-subroute')
    const res = await handleEditorTreeRoute(req, new URL(req.url), noHost, 'en')
    expect(res).toBeNull()
  })

  test('GET /api/fleet/tree with an unknown session id refuses with a sentence', async () => {
    const req = new Request('http://x/api/fleet/tree?id=nope&path=')
    const { body } = await call(req, noHost)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('unknown-session')
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })

  test('GET /api/fleet/tree lists the root', async () => {
    const req = new Request('http://x/api/fleet/tree?id=s1&path=')
    const { body } = await call(req, hostWith('s1', repo))
    // `movedir` is the empty directory the earlier "into-itself" test created and then failed to
    // move — it is still sitting on disk, untracked and empty, and correctly appears as a `dir`
    // row here: an empty, non-ignored directory is exactly what this route must list.
    expect(body).toEqual({
      ok: true,
      children: [{ name: 'movedir', kind: 'dir' }, { name: 'a.ts', kind: 'file' }],
    })
  })

  test('GET /api/fleet/tree/file reads a file', async () => {
    const req = new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts')
    const { body } = await call(req, hostWith('s1', repo))
    expect(body.ok).toBe(true)
    expect(body.content).toBe('export const a = 1\n')
    expect(typeof body.mtimeMs).toBe('number')
  })

  test('PUT /api/fleet/tree/file writes, then a stale write is refused as a conflict', async () => {
    const read = await call(new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts'), hostWith('s1', repo))
    const put1 = await call(new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts', {
      method: 'PUT', body: JSON.stringify({ content: 'export const a = 2\n', mtimeMs: read.body.mtimeMs }),
    }), hostWith('s1', repo))
    expect(put1.body.ok).toBe(true)

    const put2 = await call(new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts', {
      method: 'PUT', body: JSON.stringify({ content: 'export const a = 3\n', mtimeMs: read.body.mtimeMs }),
    }), hostWith('s1', repo))
    expect(put2.status).toBe(409)
    expect(put2.body).toMatchObject({ ok: false, reason: 'conflict', content: 'export const a = 2\n' })
  })

  test('a non-UTF-8 file: GET and PUT are both 415 with a sentence in each language, and the bytes survive', async () => {
    const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    const target = join(repo, 'latin1.txt')
    writeFileSync(target, LATIN1)
    try {
      for (const lang of ['en', 'pt'] as const) {
        const get = await call(new Request(`http://x/api/fleet/tree/file?id=s1&path=latin1.txt&lang=${lang}`), hostWith('s1', repo), lang)
        expect(get.status).toBe(415)
        expect(get.body).toMatchObject({ ok: false, reason: 'not-utf8' })
        expect(get.body.content).toBeUndefined()
        expect(get.body.message).toContain(lang === 'pt' ? 'não é texto UTF-8' : 'not UTF-8 text')
      }
      const put = await call(new Request('http://x/api/fleet/tree/file?id=s1&path=latin1.txt', {
        method: 'PUT', body: JSON.stringify({ content: LATIN1.toString('utf8'), mtimeMs: statSync(target).mtimeMs }),
      }), hostWith('s1', repo))
      expect(put.status).toBe(415)
      expect(put.body).toMatchObject({ ok: false, reason: 'not-utf8' })
      expect([...readFileSync(target)]).toEqual([...LATIN1])
    } finally {
      rmSync(target, { force: true })
    }
  })

  test('POST /api/fleet/tree/entry creates a file, GET /api/fleet/tree/search finds it by name', async () => {
    const post = await call(new Request('http://x/api/fleet/tree/entry', {
      method: 'POST', body: JSON.stringify({ id: 's1', path: 'brand-new.md', kind: 'file' }),
    }), hostWith('s1', repo))
    expect(post.body).toEqual({ ok: true })

    const search = await call(new Request('http://x/api/fleet/tree/search?id=s1&q=brand-new'), hostWith('s1', repo))
    expect(search.body.hits).toContainEqual({ kind: 'name', path: 'brand-new.md' })
  })

  test('PATCH /api/fleet/tree/entry renames', async () => {
    const patch = await call(new Request('http://x/api/fleet/tree/entry', {
      method: 'PATCH', body: JSON.stringify({ id: 's1', from: 'brand-new.md', to: 'renamed.md' }),
    }), hostWith('s1', repo))
    expect(patch.body).toEqual({ ok: true })
  })

  test('DELETE /api/fleet/tree/entry deletes', async () => {
    const del = await call(new Request('http://x/api/fleet/tree/entry?id=s1&path=renamed.md', {
      method: 'DELETE',
    }), hostWith('s1', repo))
    expect(del.body).toEqual({ ok: true })
  })

  test('a well-formed request with a missing required parameter is a 400, never a 500', async () => {
    const req = new Request('http://x/api/fleet/tree?path=x')
    const { status, body } = await call(req, hostWith('s1', repo))
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  describe('containment/not-found refusals are 404 on every route, state conflicts are 409', () => {
    test('POST /api/fleet/tree/entry with an escaping path is 404, not 409', async () => {
      const req = new Request('http://x/api/fleet/tree/entry', {
        method: 'POST', body: JSON.stringify({ id: 's1', path: '../escape.txt', kind: 'file' }),
      })
      const { status, body } = await call(req, hostWith('s1', repo))
      expect(status).toBe(404)
      expect(body).toMatchObject({ ok: false, reason: 'escaped' })
    })

    test('POST /api/fleet/tree/entry over an existing path is 409 (a real state conflict)', async () => {
      const req = new Request('http://x/api/fleet/tree/entry', {
        method: 'POST', body: JSON.stringify({ id: 's1', path: 'a.ts', kind: 'file' }),
      })
      const { status, body } = await call(req, hostWith('s1', repo))
      expect(status).toBe(409)
      expect(body).toMatchObject({ ok: false, reason: 'already-exists' })
    })

    test('PATCH /api/fleet/tree/entry renaming from an escaping path is 404, not 409', async () => {
      const req = new Request('http://x/api/fleet/tree/entry', {
        method: 'PATCH', body: JSON.stringify({ id: 's1', from: '../escape.txt', to: 'x.ts' }),
      })
      const { status, body } = await call(req, hostWith('s1', repo))
      expect(status).toBe(404)
      expect(body).toMatchObject({ ok: false, reason: 'escaped' })
    })

    test('PATCH /api/fleet/tree/entry onto an existing destination is 409 (a real state conflict)', async () => {
      const req = new Request('http://x/api/fleet/tree/entry', {
        method: 'PATCH', body: JSON.stringify({ id: 's1', from: 'a.ts', to: 'a.ts' }),
      })
      const { status, body } = await call(req, hostWith('s1', repo))
      expect(status).toBe(409)
      expect(body).toMatchObject({ ok: false, reason: 'already-exists' })
    })

    test('DELETE /api/fleet/tree/entry with an escaping path is 404, not 409', async () => {
      const req = new Request('http://x/api/fleet/tree/entry?id=s1&path=../escape.txt', { method: 'DELETE' })
      const { status, body } = await call(req, hostWith('s1', repo))
      expect(status).toBe(404)
      expect(body).toMatchObject({ ok: false, reason: 'escaped' })
    })

    test('DELETE /api/fleet/tree/entry?path=.&recursive=1 is refused as the session folder itself, and deletes nothing', async () => {
      const keep = new Request('http://x/api/fleet/tree/entry', {
        method: 'POST', body: JSON.stringify({ id: 's1', path: 'root-survivor.txt', kind: 'file' }),
      })
      await call(keep, hostWith('s1', repo))
      for (const path of ['', '.']) {
        const del = await call(
          new Request(`http://x/api/fleet/tree/entry?id=s1&path=${encodeURIComponent(path)}&recursive=1`, { method: 'DELETE' }),
          hostWith('s1', repo),
        )
        expect(del.status).toBe(409)
        expect(del.body).toMatchObject({ ok: false, reason: 'is-root' })
      }
      const list = await call(new Request('http://x/api/fleet/tree?id=s1&path='), hostWith('s1', repo))
      expect(JSON.stringify(list.body)).toContain('root-survivor.txt')
    })

    test('PATCH /api/fleet/tree/entry moving a folder into itself is 409, with a sentence in each language', async () => {
      const mk = await call(new Request('http://x/api/fleet/tree/entry', {
        method: 'POST', body: JSON.stringify({ id: 's1', path: 'into-self-web', kind: 'dir' }),
      }), hostWith('s1', repo))
      expect(mk.body.ok).toBe(true)

      for (const lang of ['en', 'pt'] as const) {
        const req = new Request(`http://x/api/fleet/tree/entry?lang=${lang}`, {
          method: 'PATCH',
          body: JSON.stringify({ id: 's1', from: 'into-self-web', to: 'into-self-web/into-self-web' }),
        })
        const { status, body } = await call(req, hostWith('s1', repo), lang)
        expect(status).toBe(409)
        expect(body).toMatchObject({ ok: false, reason: 'into-itself' })
        expect(body.message).toContain(lang === 'pt' ? 'não pode ser movida' : 'cannot be moved')
      }
    })

    test('DELETE /api/fleet/tree/entry on a non-empty folder without ?recursive=1 is 409 (a real state conflict)', async () => {
      const dirReq = new Request('http://x/api/fleet/tree/entry', {
        method: 'POST', body: JSON.stringify({ id: 's1', path: 'nonempty', kind: 'dir' }),
      })
      await call(dirReq, hostWith('s1', repo))
      const fileReq = new Request('http://x/api/fleet/tree/entry', {
        method: 'POST', body: JSON.stringify({ id: 's1', path: 'nonempty/inside.txt', kind: 'file' }),
      })
      await call(fileReq, hostWith('s1', repo))

      const del = await call(
        new Request('http://x/api/fleet/tree/entry?id=s1&path=nonempty', { method: 'DELETE' }),
        hostWith('s1', repo),
      )
      expect(del.status).toBe(409)
      expect(del.body).toMatchObject({ ok: false, reason: 'not-empty' })
    })
  })

  test('a missing required parameter is localized, like every other refusal in this module', async () => {
    const req = new Request('http://x/api/fleet/tree?path=x')
    const res = await handleEditorTreeRoute(req, new URL(req.url), hostWith('s1', repo), 'pt')
    expect(res).not.toBeNull()
    const body = await res!.json()
    expect(res!.status).toBe(400)
    expect(body.message).not.toBe('id is required')
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })
})

/**
 * The BYTES route. It is tested through `handleEditorTreeRoute` rather than through a pure plan,
 * because everything it is judged on is the RESPONSE — the anti-sniffing headers, the status of each
 * refusal, and the range it answers — and none of that survives being factored into a plan object.
 */
describe('GET /api/fleet/tree/media', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  const media = async (host: StartHost, query: string, init?: RequestInit) => {
    const req = new Request(`http://x/api/fleet/tree/media?${query}`, init)
    const res = await handleEditorTreeRoute(req, new URL(req.url), host, 'en')
    expect(res).not.toBeNull()
    return res!
  }

  test('serves an image with the declared type and the headers this route OWNS', async () => {
    writeFileSync(join(repo, 'shot.png'), PNG)
    const res = await media(hostWith('s1', repo), 'id=s1&path=shot.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="shot.png"')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
  })

  test('nosniff arrives — asserted where it is actually applied, not where it is written', () => {
    // WITHOUT IT THE CLOSED TABLE IS DECORATION: the declared type is only honest if the browser is
    // forbidden from guessing another. The route does not set it, on purpose — `handleRequest` does,
    // for every `/api/` response, and it SETS rather than appends, so a copy inside the route would
    // be a header that never ships while reading like a guarantee. Measured on a running server:
    // this route's own `default-src 'none'; sandbox` came back as the wrapper's policy every time.
    // So the assertion applies the wrapper the way `handleRequest` does, and asks the result.
    const applied = securityHeaders({ tls: false, dev: false, isApi: true, embed: true })
    expect(applied['X-Content-Type-Options']).toBe('nosniff')
    expect(applied['Content-Security-Policy']).toContain("object-src 'none'")
  })

  test('a RANGE is answered as a 206 slice — what makes a video seekable', async () => {
    writeFileSync(join(repo, 'clip.mp4'), PNG)
    const res = await media(
      hostWith('s1', repo), 'id=s1&path=clip.mp4', { headers: { Range: 'bytes=4-7' } },
    )
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe(`bytes 4-7/${PNG.length}`)
    expect(res.headers.get('Content-Type')).toBe('video/mp4')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG.subarray(4, 8))
  })

  test('a range past the end is 416 and no body, never the whole file', async () => {
    writeFileSync(join(repo, 'clip2.mp4'), PNG)
    const res = await media(
      hostWith('s1', repo), 'id=s1&path=clip2.mp4', { headers: { Range: 'bytes=9999-' } },
    )
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe(`bytes */${PNG.length}`)
  })

  test('a file off the closed table is 415 with a sentence, never octet-stream', async () => {
    writeFileSync(join(repo, 'blob.bin'), PNG)
    const res = await media(hostWith('s1', repo), 'id=s1&path=blob.bin')
    expect(res.status).toBe(415)
    const body = await res.json() as { ok: boolean; reason: string; message: string }
    expect(body).toMatchObject({ ok: false, reason: 'not-media' })
    expect(body.message.length).toBeGreaterThan(0)
  })

  test('an SVG is refused here — it can carry script, and it opens as text instead', async () => {
    writeFileSync(join(repo, 'd.svg'), '<svg onload="x()"></svg>')
    const res = await media(hostWith('s1', repo), 'id=s1&path=d.svg')
    expect(res.status).toBe(415)
    expect(res.headers.get('Content-Type')).toBe('application/json')
  })

  test('BOTH containment checks bind this route, not one of them', async () => {
    // The lexical half.
    const escaped = await media(hostWith('s1', repo), `id=s1&path=${encodeURIComponent('../outside.png')}`)
    expect(escaped.status).toBe(404)
    expect(await escaped.json()).toMatchObject({ reason: 'escaped' })
    // The symlink half: a path that is lexically INSIDE the tree and resolves outside it. The
    // lexical check passes it; only the `realpath` recheck catches it.
    writeFileSync(join(root, 'secret.png'), PNG)
    const link = join(repo, 'link.png')
    if (!existsSync(link)) symlinkSync(join(root, 'secret.png'), link)
    const linked = await media(hostWith('s1', repo), 'id=s1&path=link.png')
    expect(linked.status).toBe(404)
    expect(await linked.json()).toMatchObject({ reason: 'not-found' })
  })

  test('an unknown session never reaches the disk', async () => {
    const res = await media(noHost, 'id=nope&path=shot.png')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ reason: 'unknown-session' })
  })

  test('a missing path is a bad request, in the reader\'s language', async () => {
    const res = await media(hostWith('s1', repo), 'id=s1')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'bad_request' })
  })
})
