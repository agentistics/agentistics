/**
 * ENTREGA.GARANTIDA S0d.3 (QA F3) — the `/api/tasks*` principal screen runs for EVERY content-type. `attack-r2.ts`
 * T1/T3/T4: `actor: "flow:entrega"` and a forged session passed with `text/plain`, no header or `Application/Json`.
 */
import { describe, expect, test } from 'bun:test'
import { reservedNameAs, screenTaskRequest, freeTextAuthorAs as authorAs } from './principal-http'

const verify = async (id: unknown, token: unknown) => (id === 'leader' && token === 'good' ? 'leader' : null)
const req = (body: string, contentType: string | null, path = '/api/tasks/t-1', method = 'POST') =>
  screenTaskRequest({ path, method, contentType, text: async () => body }, verify)

describe('the screen ignores the content-type header', () => {
  for (const ct of ['application/json', 'text/plain', null, 'Application/Json', 'APPLICATION/JSON; charset=utf-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    test(`reserved actor and forged session are refused with content-type ${ct ?? '(none)'}`, async () => {
      expect(await req(JSON.stringify({ status: 'done', actor: 'flow:entrega' }), ct)).toMatchObject({ status: 400, body: { error: 'reserved_actor' } })
      expect(await req(JSON.stringify({ status: 'done', actor: '  OWNER ' }), ct)).toMatchObject({ status: 400, body: { error: 'reserved_actor' } })
      expect(await req(JSON.stringify({ status: 'done', session: { id: 'leader', token: 'bad' } }), ct)).toMatchObject({ status: 403, body: { error: 'unverified_sender' } })
      expect(await req(JSON.stringify({ status: 'done', session: { id: 'leader', token: 'good' } }), ct)).toBeNull()
    })
  }
  test('every write method is screened (PUT, PATCH, DELETE with a body); reads are not', async () => {
    const bad = JSON.stringify({ actor: 'dono' })
    for (const m of ['PUT', 'PATCH', 'DELETE', 'post']) expect(await req(bad, 'text/plain', '/api/tasks/t-1', m)).toMatchObject({ status: 400 })
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(await req(bad, 'text/plain', '/api/tasks/t-1', m)).toBeNull()
    expect(await req(bad, 'text/plain', '/api/tasks', 'POST')).toMatchObject({ status: 400 })
    expect(await req(bad, 'text/plain', '/api/deliveries/x', 'POST')).toBeNull() // not this screen's route
  })
  test('a non-empty body that is not JSON is refused 415; an empty body passes to the handler', async () => {
    expect(await req('actor=flow:entrega', 'application/x-www-form-urlencoded')).toMatchObject({ status: 415, body: { error: 'json_required' } })
    expect(await req('', null)).toBeNull()
    expect(await req('   ', 'text/plain')).toBeNull()
  })
  test('index.ts wires the request-level screen, not a content-type-gated one', async () => {
    const src = await Bun.file(new URL('../index.ts', import.meta.url)).text()
    expect(src).toContain('screenTaskRequest(')
    const at = src.indexOf('screenTaskRequest(')
    expect(src.slice(at - 600, at)).not.toMatch(/content-type'\)[^\n]*includes\('application\/json'\)/)
  })
  test('only the multipart file upload is exempt (its handler reads the form, never an actor or a session)', async () => {
    const form = '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhi\r\n--x--'
    expect(await req(form, 'multipart/form-data; boundary=x', '/api/tasks/t-1/files')).toBeNull()
    expect(await req(form, 'Multipart/Form-Data; boundary=x', '/api/tasks/t-1/files')).toBeNull()
    expect(await req(form, 'multipart/form-data; boundary=x', '/api/tasks/t-1/comments')).toMatchObject({ status: 415 })
    expect(await req(JSON.stringify({ actor: 'flow:x' }), 'text/plain', '/api/tasks/t-1/files')).toMatchObject({ status: 400 })
  })
})

// S0d security re-QA N3: reserved names in fields the actor screen did not look at — a claim's `by`, an upload's `author`.
describe('N3 a reserved name outside `actor` is the REAL principal, never a claim', () => {
  const owner = { kind: 'owner', via: 'legacy-browser' } as const
  const session = { kind: 'session', id: 's-worker', via: 'token' } as const
  const nobody = { kind: 'unattributed' } as const
  test('an ordinary name passes unchanged, whoever asks', () => {
    for (const p of [owner, session, nobody]) expect(reservedNameAs('worker-7', p, 'refuse')).toEqual({ ok: true, value: 'worker-7' })
  })
  test('the proven owner may name itself; nobody may name the engine', () => {
    for (const v of ['owner', 'you', ' Dono ']) expect(reservedNameAs(v, owner, 'refuse')).toEqual({ ok: true, value: v })
    expect(reservedNameAs('flow:entrega', owner, 'refuse')).toMatchObject({ ok: false, status: 400, body: { error: 'reserved_actor' } })
    expect(reservedNameAs('flow:entrega', owner, 'record')).toMatchObject({ ok: false, status: 400 })
  })
  test('a proven session claiming the owner is recorded as ITSELF', () => {
    expect(reservedNameAs('owner', session, 'refuse')).toEqual({ ok: true, value: 's-worker' })
    expect(reservedNameAs('you', session, 'record')).toEqual({ ok: true, value: 's-worker' })
  })
  test('no proof: a claim is refused; an upload is recorded as unattributed', () => {
    expect(reservedNameAs('owner', nobody, 'refuse')).toMatchObject({ ok: false, status: 403, body: { error: 'reserved_actor' } })
    expect(reservedNameAs('owner', nobody, 'record')).toEqual({ ok: true, value: 'unattributed' })
  })
  test('index.ts applies it to the claim\'s `by` (take AND release) and the upload\'s `author`', async () => {
    const src = await Bun.file(new URL('../index.ts', import.meta.url)).text()
    const claim = src.slice(src.indexOf("if (verb === 'claim') {"), src.indexOf("if (verb === 'move') {"))
    expect(claim).toMatch(/reservedNameAs\(body\.by, [^)]*'refuse'\)/)
    expect(claim).not.toMatch(/by: String\(body\.by/)
    const files = src.slice(src.indexOf("if (verb === 'files') {"), src.indexOf("const body = await req.json()", src.indexOf("if (verb === 'files') {")))
    expect(files).toMatch(/reservedNameAs\(form\?\.get\('author'\), [^)]*'record'\)/)
  })
})

// QA eg-integ W3: comment and thread authors are free text, but a reserved name in them is the real principal too.
describe('W3 a reserved comment / thread author is the REAL principal (required mode); legacy is untouched', () => {
  const owner = { kind: 'owner', via: 'vault-credential', grantId: 'g' } as const
  const legacyOwner = { kind: 'owner', via: 'legacy-browser' } as const
  const session = { kind: 'session', id: 's-worker', via: 'token' } as const
  const nobody = { kind: 'unattributed' } as const
  test('required: no proof → unattributed; session → itself; owner → keeps the name; ordinary names pass', () => {
    expect(authorAs('owner', nobody, 'required')).toEqual({ ok: true, value: 'unattributed' })
    expect(authorAs('Dono', session, 'required')).toEqual({ ok: true, value: 's-worker' })
    expect(authorAs('you', owner, 'required')).toEqual({ ok: true, value: 'you' })
    expect(authorAs('worker-7', nobody, 'required')).toEqual({ ok: true, value: 'worker-7' })
    expect(authorAs('flow:entrega', owner, 'required')).toMatchObject({ ok: false, status: 400 })
  })
  test('legacy (how every current user runs): every door keeps exactly what it sent — web UI (browser owner), MCP/CLI (session / unattributed)', () => {
    for (const p of [legacyOwner, session, nobody]) for (const v of ['owner', 'you', 'dono', 'worker-7', 'unknown']) {
      expect(authorAs(v, p, 'legacy')).toEqual({ ok: true, value: v })
    }
  })
  test('index.ts routes the comment author and the thread opener/sender through it', async () => {
    const src = await Bun.file(new URL('../index.ts', import.meta.url)).text()
    const comments = src.slice(src.indexOf("if (verb === 'comments') {"), src.indexOf("if (verb === 'threads') {"))
    expect(comments).toMatch(/author: (commentAuthor|authorField)\b/)
    expect(comments).not.toMatch(/author: String\(body\.author/)
    const threads = src.slice(src.indexOf("if (verb === 'threads') {"), src.indexOf("if (verb === 'sessions') {"))
    expect(threads).toMatch(/openedBy: (threadAuthor|authorField)\b/)
    expect(threads).not.toMatch(/openedBy: String\(body\.author/)
    expect(threads).not.toMatch(/author: String\(body\.author/)
  })
})
