import { expect, test, describe } from 'bun:test'
import { parseSessionArgs } from './cli-parse'
import { leadsCommand } from './cli-leads'

describe('agentop session leads (parse)', () => {
  test('list, declare and undeclare', () => {
    expect(parseSessionArgs(['leads'])).toEqual({ kind: 'leads', add: [], remove: [] })
    expect(parseSessionArgs(['leads', 'abc', '--add', 't-1', '--add', 't-2', '--remove', 't-3', '--json'])).toEqual({ kind: 'leads', ref: 'abc', add: ['t-1', 't-2'], remove: ['t-3'], json: true })
  })
  test('malformed arguments are a usage error', () => {
    expect(parseSessionArgs(['leads', '--add'])).toMatchObject({ kind: 'error' })
    expect(parseSessionArgs(['leads', 'a', 'b'])).toMatchObject({ kind: 'error' })
    expect(parseSessionArgs(['leads', '--bogus'])).toMatchObject({ kind: 'error' })
  })
})

describe('agentop session leads (REST, same refusals)', () => {
  const run = async (cmd: Parameters<typeof leadsCommand>[0], reply: unknown, status = 200, env: Record<string, string> = {}) => {
    const calls: { url: string; init?: RequestInit }[] = []
    const out: string[] = []; const errs: string[] = []
    const code = await leadsCommand(cmd, {
      port: 1, env, readKey: () => 'ab'.repeat(32),
      fetch: (async (url: string, init?: RequestInit) => { calls.push({ url, ...(init ? { init } : {}) }); return new Response(JSON.stringify(reply), { status }) }) as never,
      log: s => out.push(s), err: s => errs.push(s),
    })
    return { code, calls, out, errs }
  }
  test('declare posts to the route and prints the server message', async () => {
    const r = await run({ ref: 'L', add: ['t-9'], remove: [] }, { ok: true, id: 'L', leads: ['t-9'], message: 'Leads: t-9.' })
    expect(r.code).toBe(0)
    expect(r.calls[0]!.url).toContain('/api/session-leads')
    expect(JSON.parse(String(r.calls[0]!.init!.body))).toMatchObject({ ref: 'L', add: ['t-9'] })
    expect(r.out[0]).toContain('Leads: t-9.')
  })
  test("the server's refusal is shown verbatim and exits 1 (the CLI holds no rule)", async () => {
    const r = await run({ add: ['t-9'], remove: [] }, { ok: false, code: 'other_project', message: 'That task belongs to another repository.' }, 400)
    expect(r.code).toBe(1)
    expect(r.errs[0]).toContain('other_project')
  })
  test('inside a managed session the request carries that session proof (it can only change its OWN leads)', async () => {
    const r = await run({ add: ['t-9'], remove: [] }, { ok: true, message: 'x' }, 200, { AGENTOP_MANAGED_ID: 'sess1' })
    const body = JSON.parse(String(r.calls[0]!.init!.body))
    expect(body.session.id).toBe('sess1')
    expect(body.session.token).toMatch(/^[0-9a-f]{64}$/)
  })
  test('a managed session with no readable key sends session:null, so the server refuses instead of treating it as the person', async () => {
    const out = await leadsCommand({ add: ['t'], remove: [] }, {
      port: 1, env: { AGENTOP_MANAGED_ID: 'sess1' }, readKey: () => { throw new Error('no key') }, log() {}, err() {},
      fetch: (async (_u: string, init?: RequestInit) => { expect(JSON.parse(String(init!.body)).session).toBeNull(); return new Response('{"ok":false,"code":"unverified_sender","message":"x"}', { status: 403 }) }) as never,
    })
    expect(out).toBe(1)
  })
  test('listing with no arguments reads every leader', async () => {
    const r = await run({ add: [], remove: [] }, { ok: true, leaders: [{ id: 'L', title: 'Motor', state: 'working', leads: ['t-1', 't-2'] }] })
    expect(r.calls[0]!.init?.method).toBeUndefined()
    expect(r.out[0]).toBe('L\tworking\tMotor\tt-1,t-2')
  })
})
