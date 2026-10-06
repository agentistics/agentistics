import { describe, expect, it } from 'bun:test'
import {
  ACTION_KINDS, ACTION_KINDS_ORDER, PROOF_CHOICES, STRICTEST_AUTH_POLICY, choiceFor, choicesFor, parseAuthPolicy, proofsFor,
  type ActionKind, type ProofChoice,
} from './action-policy'

const CRITICAL: ActionKind[] = ['delete-secret', 'delete-device', 'wipe', 'settings', 'recovery']

describe('the per-action authentication policy (owner decision 2026-10-06)', () => {
  it('the defaults are today\'s behaviour', () => {
    expect(choiceFor(null, 'reveal')).toBe('gesture')
    expect(choiceFor(null, 'use')).toBe('gesture')
    expect(choiceFor(null, 'edit')).toBe('gesture')
    for (const k of CRITICAL) expect(choiceFor(undefined, k)).toBe('both')
  })

  it('every critical kind is critical and none of them offers "none"', () => {
    for (const k of CRITICAL) {
      expect(ACTION_KINDS[k].critical).toBe(true)
      expect(choicesFor(k)).not.toContain('none')
    }
    expect(choicesFor('edit')).not.toContain('none') // editing is not a read
    expect(choicesFor('reveal')).toContain('none')
    expect(choicesFor('use')).toContain('none')
  })

  it('parses every kind × every choice: accepted exactly when the kind offers it', () => {
    for (const k of ACTION_KINDS_ORDER) {
      for (const c of PROOF_CHOICES) {
        const p = parseAuthPolicy({ [k]: c })
        if (choicesFor(k).includes(c)) {
          expect(p).toEqual({ v: 1, choices: { [k]: c } })
          expect(choiceFor(p, k)).toBe(c)
        } else {
          expect(p).toBeNull()
          expect(ACTION_KINDS[k].read).toBe(false)
          expect(c).toBe('none')
        }
      }
    }
  })

  it('a critical "none" refuses the WHOLE policy, not just that row', () => {
    expect(parseAuthPolicy({ reveal: 'none', wipe: 'none' })).toBeNull()
    expect(parseAuthPolicy({ choices: { settings: 'none' } })).toBeNull()
  })

  it('refuses junk: unknown kinds, unknown choices, non-objects', () => {
    expect(parseAuthPolicy(null)).toBeNull()
    expect(parseAuthPolicy('both')).toBeNull()
    expect(parseAuthPolicy([])).toBeNull()
    expect(parseAuthPolicy({ open: 'code' })).toBeNull()
    expect(parseAuthPolicy({ reveal: 'maybe' })).toBeNull()
    expect(parseAuthPolicy({ reveal: 1 })).toBeNull()
    expect(parseAuthPolicy({})).toEqual({ v: 1, choices: {} })
    expect(parseAuthPolicy({ choices: { edit: 'code' } })).toEqual({ v: 1, choices: { edit: 'code' } })
  })

  it('a stored "none" on a non-read kind (a hand edit) reads as the default, never as nothing', () => {
    for (const k of [...CRITICAL, 'edit' as const]) {
      expect(choiceFor({ v: 1, choices: { [k]: 'none' } }, k)).toBe(ACTION_KINDS[k].default)
    }
  })

  it('the strictest policy (an unopenable record) is both everywhere', () => {
    for (const k of ACTION_KINDS_ORDER) expect(choiceFor(STRICTEST_AUTH_POLICY, k)).toBe('both')
  })

  describe('proofsFor — what a choice asks on a given vault', () => {
    const full = { hasAuthenticator: true, hasPresence: true }
    it('a vault with both proofs asks exactly the choice', () => {
      const want: Record<ProofChoice, { code: boolean; gesture: boolean }> = {
        code: { code: true, gesture: false },
        gesture: { code: false, gesture: true },
        both: { code: true, gesture: true },
        none: { code: false, gesture: false },
      }
      for (const c of PROOF_CHOICES) expect(proofsFor(c, full)).toEqual(want[c])
    })
    it('a chosen proof the vault cannot ask is replaced by the other, never by nothing', () => {
      expect(proofsFor('code', { hasAuthenticator: false, hasPresence: true })).toEqual({ code: false, gesture: true })
      expect(proofsFor('gesture', { hasAuthenticator: true, hasPresence: false })).toEqual({ code: true, gesture: false })
      expect(proofsFor('both', { hasAuthenticator: true, hasPresence: false })).toEqual({ code: true, gesture: false })
      expect(proofsFor('both', { hasAuthenticator: false, hasPresence: true })).toEqual({ code: false, gesture: true })
    })
    it('a vault with neither proof asks nothing (as before: nothing to ask yet)', () => {
      for (const c of PROOF_CHOICES) expect(proofsFor(c, { hasAuthenticator: false, hasPresence: false })).toEqual({ code: false, gesture: false })
    })
    it('every critical kind × every allowed choice asks at least one proof wherever one exists', () => {
      const vaults = [full, { hasAuthenticator: true, hasPresence: false }, { hasAuthenticator: false, hasPresence: true }]
      for (const k of CRITICAL) for (const c of choicesFor(k)) for (const v of vaults) {
        const p = proofsFor(choiceFor(parseAuthPolicy({ [k]: c }), k), v)
        expect(p.code || p.gesture).toBe(true)
      }
    })
  })
})
