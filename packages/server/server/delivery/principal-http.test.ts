/**
 * ENTREGA.GARANTIDA S0d.3 (QA F3) — the `/api/tasks*` principal screen runs for EVERY content-type. `attack-r2.ts`
 * T1/T3/T4: `actor: "flow:entrega"` and a forged session passed with `text/plain`, no header or `Application/Json`.
 */
import { describe, expect, test } from 'bun:test'
import { screenTaskRequest } from './principal-http'

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
