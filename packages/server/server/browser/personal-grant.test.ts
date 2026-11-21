/**
 * S10 r3 — the owner's proof for the person's OWN browser. The socket can never prove "this is the person"
 * (a detached child with a clean environment, a `--network host` container and `systemd-run` all look like
 * them), so the person's UI holds a short-lived grant the vault proof minted, and every personal door asks
 * for it. These pin the store and the one decision every door shares.
 */
import { describe, expect, test } from 'bun:test'
import {
  PERSONAL_GRANT_TTL_MS, PersonalGrants, personalDoorRefusal, personalGrantFromProtocols, PERSONAL_GRANT_PROTOCOL,
} from './personal-grant'

import type { CallerVerdict } from './browser-caller'

const S = 'http:local'

describe('PersonalGrants', () => {
  test('a minted grant is random, valid for its session and expires within 12 h', () => {
    const g = new PersonalGrants()
    const a = g.mint(S, 1_000)
    const b = g.mint(S, 1_000)
    expect(a.token).not.toBe(b.token)
    expect(a.token.length).toBeGreaterThanOrEqual(40)
    expect(a.expiresAt - 1_000).toBeLessThanOrEqual(12 * 3_600_000)
    expect(PERSONAL_GRANT_TTL_MS).toBeLessThanOrEqual(12 * 3_600_000)
    expect(g.check(a.token, S, 2_000)).toBe(true)
    expect(g.check(a.token, S, a.expiresAt)).toBe(false)
    expect(g.check(a.token, S, a.expiresAt - 1)).toBe(true)
  })

  test('unknown, empty, other-session and non-string tokens are refused', () => {
    const g = new PersonalGrants()
    const a = g.mint(S, 0)
    expect(g.check('nope', S, 1)).toBe(false)
    expect(g.check('', S, 1)).toBe(false)
    expect(g.check(null, S, 1)).toBe(false)
    expect(g.check(undefined, S, 1)).toBe(false)
    expect(g.check(a.token, 'http:other', 1)).toBe(false)
    expect(g.check(`${a.token}x`, S, 1)).toBe(false)
  })

  test('revoke kills one grant; revokeAll kills them all', () => {
    const g = new PersonalGrants()
    const a = g.mint(S, 0)
    const b = g.mint(S, 0)
    g.revoke(a.token)
    expect(g.check(a.token, S, 1)).toBe(false)
    expect(g.check(b.token, S, 1)).toBe(true)
    g.revokeAll()
    expect(g.check(b.token, S, 1)).toBe(false)
  })

  test('the store never keeps the token itself (only a digest), and prunes the expired', () => {
    const g = new PersonalGrants()
    const a = g.mint(S, 0)
    expect(JSON.stringify([...g.__debugKeys()])).not.toContain(a.token)
    g.mint(S, PERSONAL_GRANT_TTL_MS + 5)
    expect(g.size()).toBe(1)
  })

  test('a flood of mints is bounded', () => {
    const g = new PersonalGrants()
    for (let i = 0; i < 500; i++) g.mint(S, 0)
    expect(g.size()).toBeLessThanOrEqual(64)
  })
})

describe('personalDoorRefusal — the one decision every personal door shares', () => {
  const person: CallerVerdict = { kind: 'person', via: 'process', pid: 1 }
  const session: CallerVerdict = { kind: 'session', pid: 2, managedId: 'm1' }
  test('no grant is refused with a code and a sentence in both languages, whatever the socket says', () => {
    const en = personalDoorRefusal({ grantOk: false, caller: person, lang: 'en' })!
    const pt = personalDoorRefusal({ grantOk: false, caller: person, lang: 'pt' })!
    expect(en.status).toBe(403)
    expect(en.error).toBe('personal_proof_required')
    expect(en.sentence).toMatch(/vault/i)
    expect(pt.sentence).toMatch(/Cofre/)
    expect(en.action).toEqual({ kind: 'open-vault', path: '/vault' })
  })
  test('a grant with a person (or an unidentifiable) socket proceeds', () => {
    expect(personalDoorRefusal({ grantOk: true, caller: person, lang: 'en' })).toBeNull()
  })
  test('the socket stays as an EXTRA refusal: a known session holding a grant is still refused', () => {
    const r = personalDoorRefusal({ grantOk: true, caller: session, lang: 'en' })!
    expect(r.error).toBe('session_cannot_drive_personal')
  })
  test('an unidentified caller with a grant is refused fail-closed only when asked to', () => {
    const unk: CallerVerdict = { kind: 'unknown', reason: 'no-peer' }
    // The grant is the proof; an unidentifiable socket (no /proc) must not lock the person out of their own browser.
    expect(personalDoorRefusal({ grantOk: true, caller: unk, lang: 'en' })).toBeNull()
  })
})

describe('personalGrantFromProtocols — the input WS carries the grant as a sub-protocol, never in the URL', () => {
  test('reads the token that follows the marker', () => {
    expect(personalGrantFromProtocols(`${PERSONAL_GRANT_PROTOCOL}, abc_DEF-1234567890xyz`)).toBe('abc_DEF-1234567890xyz')
  })
  test('absent marker, missing token or odd characters read as none', () => {
    expect(personalGrantFromProtocols(null)).toBeNull()
    expect(personalGrantFromProtocols('other')).toBeNull()
    expect(personalGrantFromProtocols(PERSONAL_GRANT_PROTOCOL)).toBeNull()
    expect(personalGrantFromProtocols(`${PERSONAL_GRANT_PROTOCOL}, a b`)).toBeNull()
    expect(personalGrantFromProtocols(`${PERSONAL_GRANT_PROTOCOL}, ${'a'.repeat(300)}`)).toBeNull()
  })
})
