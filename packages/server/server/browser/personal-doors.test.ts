/**
 * S10 r3 / F4-r2: the two `index.ts` survivors of the r2 QA — the stream check and the caller read on
 * `personal/*` — had no test that could reach them. The decisions now live in `personal-doors.ts`, and these
 * pin them AND pin (over the source) that `index.ts` really asks at every personal door.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERSONAL_GRANT_HEADER, PERSONAL_GRANT_PROTOCOL, personalGrants, __resetPersonalGrantsForTests } from './personal-grant'
import { inputDoor, requestHasPersonalGrant, streamDoor } from './personal-doors'
import type { CallerVerdict } from './browser-caller'

const S = 'http:local'
const person: CallerVerdict = { kind: 'person', via: 'process', pid: 1 }
const req = (h: Record<string, string>) => ({ headers: { get: (n: string) => h[n.toLowerCase()] ?? null } })

describe('the stream door', () => {
  test('a session owner stream is not this door\'s business', async () => {
    __resetPersonalGrantsForTests()
    expect(await streamDoor({ owner: { kind: 'session', managedId: 'a' }, req: req({}), session: S, caller: () => person, lang: 'en' })).toBeNull()
  })
  test('personal without a grant is refused, whatever the socket says', async () => {
    __resetPersonalGrantsForTests()
    const r = await streamDoor({ owner: { kind: 'personal' }, req: req({}), session: S, caller: () => person, lang: 'pt' })
    expect(r).toMatchObject({ status: 403, body: { error: 'personal_proof_required', action: { kind: 'open-vault' } } })
    expect(r!.body.sentence).toMatch(/Cofre/)
  })
  test('personal with a grant passes; with a grant but a session socket it is refused', async () => {
    __resetPersonalGrantsForTests()
    const { token } = personalGrants().mint(S)
    const r = req({ [PERSONAL_GRANT_HEADER]: token })
    expect(await streamDoor({ owner: { kind: 'personal' }, req: r, session: S, caller: () => person, lang: 'en' })).toBeNull()
    expect(await streamDoor({ owner: { kind: 'personal' }, req: r, session: S, caller: () => ({ kind: 'session', pid: 2, managedId: 'x' }), lang: 'en' })).toMatchObject({ body: { error: 'session_cannot_drive_personal' } })
  })
  test('a grant minted for another HTTP session is refused', async () => {
    __resetPersonalGrantsForTests()
    const { token } = personalGrants().mint('http:other')
    expect(await streamDoor({ owner: { kind: 'personal' }, req: req({ [PERSONAL_GRANT_HEADER]: token }), session: S, caller: () => person, lang: 'en' })).toMatchObject({ status: 403 })
  })
})

describe('the input socket door', () => {
  test('the grant rides the sub-protocol, not the URL', async () => {
    __resetPersonalGrantsForTests()
    const { token } = personalGrants().mint(S)
    const ok = req({ 'sec-websocket-protocol': `${PERSONAL_GRANT_PROTOCOL}, ${token}` })
    expect(await inputDoor({ owner: { kind: 'personal' }, req: ok, session: S, caller: () => person, lang: 'en' })).toBeNull()
    expect(await inputDoor({ owner: { kind: 'personal' }, req: req({}), session: S, caller: () => person, lang: 'en' })).toMatchObject({ status: 403, body: { error: 'personal_proof_required' } })
    expect(await inputDoor({ owner: { kind: 'session', managedId: 'a' }, req: req({}), session: S, caller: () => person, lang: 'en' })).toBeNull()
  })
})

test('requestHasPersonalGrant reads the header', () => {
  __resetPersonalGrantsForTests()
  const { token } = personalGrants().mint(S)
  expect(requestHasPersonalGrant(req({ [PERSONAL_GRANT_HEADER]: token }), S)).toBe(true)
  expect(requestHasPersonalGrant(req({}), S)).toBe(false)
})

describe('index.ts really asks at every personal door (the r2 survivors R4 and R5)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  const browserBlock = src.slice(src.indexOf("url.pathname === '/api/browser/stream'") - 400)
  test('the stream route calls streamDoor before it resolves a target', () => {
    const at = browserBlock.indexOf('streamDoor(')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(browserBlock.indexOf('browserStreamTarget(browserOpts, owner)'))
  })
  test('the input socket calls inputDoor before it upgrades, and accepts the grant sub-protocol', () => {
    const at = browserBlock.indexOf('inputDoor(')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(browserBlock.indexOf('server.upgrade(req, { data: { browserInput'))
    expect(browserBlock).toContain('INPUT_ACCEPT_PROTOCOL')
  })
  test('the route deps carry the grant check and the caller is read for personal/* and the status', () => {
    expect(browserBlock).toMatch(/personalGrant:\s*\(\)\s*=>\s*requestHasPersonalGrant\(/)
    expect(browserBlock).toMatch(/routeNeedsCaller\(url\.pathname\)/)
  })
  test('the early vault door also covers the personal-browser proof (a known session may not even ask)', () => {
    expect(src).toMatch(/\/api\/vault\/personal-browser/)
  })
})
