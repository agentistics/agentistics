/**
 * eg-integ r5 (closes QA r4 R2' / R5) — the `/api/tasks*` write wiring driven through the REAL server.
 *
 * `index.ts` is booted in a child process (its own HOME + AGENTISTICS_DIR, `local` profile, engine off) and spoken to over
 * HTTP, so the call sites in `index.ts` itself (`principalDepsOf`, `openKnown`, `opened.denied`, the inline
 * `consumeGrant` lambdas) are what is under test, not the factory in `request-deps.ts`. One server runs the real LEGACY
 * mode (absent preference), another the real REQUIRED mode (`delivery.ownerProof: 'required'`); nothing is stubbed,
 * including `consumeDeliveryGrant` (a grant from a non-loopback peer is refused by the real gate).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { sessionToken } from '../sessions/session-identity'

const SERVER_INDEX = join(import.meta.dir, '..', 'index.ts')
const KEY = Buffer.alloc(32, 7)
const PROOF = { id: 'w1', token: sessionToken(KEY, 'w1') }

interface Booted { port: number; dir: string; root: string; proc: Subprocess }

async function boot(mode: 'legacy' | 'required'): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), `eg-r5-${mode}-`))
  const home = join(root, 'home')
  const dir = join(home, '.agentistics')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ archiveMode: 'off', ...(mode === 'required' ? { delivery: { ownerProof: 'required' } } : {}) }))
  writeFileSync(join(dir, 'session-identity.key'), KEY.toString('hex'), { mode: 0o600 })
  const port = 20000 + Math.floor(Math.random() * 20000)
  const proc = Bun.spawn([process.execPath, SERVER_INDEX], {
    env: { ...process.env, HOME: home, AGENTISTICS_DIR: dir, AGENTISTICS_ENGINE: '0', AGENTISTICS_EXPOSURE: 'local', SERVE_STATIC: '', PORT: String(port) },
    stdout: 'ignore', stderr: 'ignore',
  })
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { port, dir, root, proc } } catch { /* not up yet */ }
    await Bun.sleep(200)
  }
  proc.kill()
  throw new Error(`server (${mode}) did not come up`)
}

const stop = async (b: Booted | undefined) => { if (!b) return; b.proc.kill(); await b.proc.exited; rmSync(b.root, { recursive: true, force: true }) }

/** Same-origin browser headers, as the owner's web UI sends them. `extra` may add a proxy header or a grant. */
function api(b: Booted) {
  const origin = `http://127.0.0.1:${b.port}`
  return async (path: string, body: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin', ...extra },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null) as any
    return { status: res.status, json }
  }
}

const book = (b: Booted): any => JSON.parse(readFileSync(join(b.dir, 'tasks.json'), 'utf8'))
const taskOf = (b: Booted, id: string): any => ({
  ...book(b).tasks.find((t: any) => t.id === id),
  comments: (book(b).comments ?? []).filter((c: any) => c.taskId === id),
  threads: (book(b).threads ?? []).filter((t: any) => t.taskId === id),
})

let seq = 0
async function newTask(post: ReturnType<typeof api>, title = `Wiring ${Date.now()}-${++seq}`): Promise<string> {
  const created = await post('/api/tasks', { title })
  expect(created.status).toBe(200)
  return String((created.json.task ?? created.json).id)
}

describe('legacy mode, through the real index.ts', () => {
  let b: Booted
  beforeAll(async () => { b = await boot('legacy') }, 50_000)
  afterAll(() => stop(b))

  test('a comment whose author is "you" is accepted and stored under that name (principalDepsOf must stay legacy)', async () => {
    const post = api(b)
    const id = await newTask(post)
    const res = await post(`/api/tasks/${id}/comments`, { author: 'you', body: 'typed by the owner UI' })
    expect(res.status).toBe(200)
    const comments = (taskOf(b, id).comments ?? []) as Array<{ author: string; body: string }>
    expect(comments.map(c => [c.author, c.body])).toEqual([['you', 'typed by the owner UI']])
  })
})

describe('required mode, through the real index.ts', () => {
  let b: Booted
  beforeAll(async () => { b = await boot('required') }, 50_000)
  afterAll(() => stop(b))

  test('a comment authored "you" with no owner proof does NOT keep the name: it is stored as unattributed (required must not be weakened)', async () => {
    const post = api(b)
    const id = await newTask(post)
    const res = await post(`/api/tasks/${id}/comments`, { author: 'you', body: 'no proof' })
    expect(res.status).toBe(200)
    expect((taskOf(b, id).comments as any[]).map(c => c.author)).toEqual(['unattributed'])
  })

  test('a proven session that opens a thread is recorded as ITSELF, never the typed owner name (openKnown)', async () => {
    const post = api(b)
    const id = await newTask(post)
    const res = await post(`/api/tasks/${id}/threads`, { action: 'open', title: 'A topic', kind: 'topic', author: 'owner', session: PROOF })
    expect(res.status).toBe(200)
    expect(res.json.thread.openedBy).toBe('w1')
    expect((taskOf(b, id).threads ?? []).map((t: any) => t.openedBy)).toEqual(['w1'])
  })

  test('owner:true without a grant: the thread open is refused by the owner gate and nothing is stored (opened.denied)', async () => {
    const post = api(b)
    const id = await newTask(post)
    const res = await post(`/api/tasks/${id}/threads`, { action: 'open', title: 'Owner topic', kind: 'topic', author: 'you', owner: true })
    expect(res.status).toBe(403)
    expect(res.json.error).toBe('owner_proof_required')
    expect(taskOf(b, id).threads ?? []).toEqual([])
  })

  // The REAL consumeDeliveryGrant: a non-loopback peer is refused BEFORE the token is looked at, so the code is
  // `owner_proof_local_only`; a gate that treated the peer as loopback would answer `grant_invalid` for this junk token.
  // `x-forwarded-for` is what makes `loopbackRequest` false for a request that otherwise arrives on 127.0.0.1.
  const NON_LOOPBACK = { 'x-forwarded-for': '203.0.113.9', 'x-agentop-owner-grant': 'junk.grant' }

  test('a grant presented from a non-loopback peer is refused (author path: principalDepsOf → taskRequestDeps → consumeGrant)', async () => {
    const post = api(b)
    const id = await newTask(post)
    const res = await post(`/api/tasks/${id}/comments`, { author: 'you', body: 'proxied' }, NON_LOOPBACK)
    expect(res.status).toBe(403)
    expect(res.json.error).toBe('owner_proof_local_only')
    expect(taskOf(b, id).comments ?? []).toEqual([])
  })

  test('the same refusal on the owner-comment gate and on the task-write screen (the inline consumeGrant lambdas)', async () => {
    const post = api(b)
    const id = await newTask(post)
    const ownerComment = await post(`/api/tasks/${id}/comments`, { author: 'someone', body: 'as owner', owner: true }, NON_LOOPBACK)
    expect(ownerComment.status).toBe(403)
    expect(ownerComment.json.error).toBe('owner_proof_local_only')
    const rename = await post(`/api/tasks/${id}`, { title: 'Renamed', actor: 'you' }, NON_LOOPBACK)
    expect(rename.status).toBe(403)
    expect(rename.json.error).toBe('owner_proof_local_only')
    expect(taskOf(b, id).title).not.toBe('Renamed')
  })
})
