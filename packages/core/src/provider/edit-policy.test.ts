import { describe, expect, it } from 'bun:test'
import { ANTHROPIC_EDIT_POLICY, mayReplace, type EditPolicy } from './edit-policy'

describe('ANTHROPIC_EDIT_POLICY — declared, UNVERIFIED (B1 spec §4.6)', () => {
  it('is declared-unverified, not measured — B1 has not exercised the policy', () => {
    expect(ANTHROPIC_EDIT_POLICY.status).toBe('declared-unverified')
  })

  it('declares the four kinds exactly as B1 spec §4.6 states them', () => {
    expect(ANTHROPIC_EDIT_POLICY.kinds).toEqual({
      'tool-result': 'unverified',
      'tool-input': 'unverified',
      reasoning: 'immutable',
      'assistant-text': 'immutable',
    })
  })

  it('names the provider and carries a non-empty source citation', () => {
    expect(ANTHROPIC_EDIT_POLICY.provider).toBe('anthropic')
    expect(ANTHROPIC_EDIT_POLICY.source.length).toBeGreaterThan(0)
  })

  it('is frozen, including the nested kinds record', () => {
    expect(Object.isFrozen(ANTHROPIC_EDIT_POLICY)).toBe(true)
    expect(Object.isFrozen(ANTHROPIC_EDIT_POLICY.kinds)).toBe(true)
  })
})

describe('mayReplace — true only for replaceable', () => {
  it('is false for an immutable kind (reasoning)', () => {
    expect(mayReplace(ANTHROPIC_EDIT_POLICY, 'reasoning')).toBe(false)
  })

  it('is false for an immutable kind (assistant-text)', () => {
    expect(mayReplace(ANTHROPIC_EDIT_POLICY, 'assistant-text')).toBe(false)
  })

  it('is false for an unverified kind — nobody measured it, so it is not editable', () => {
    expect(mayReplace(ANTHROPIC_EDIT_POLICY, 'tool-result')).toBe(false)
    expect(mayReplace(ANTHROPIC_EDIT_POLICY, 'tool-input')).toBe(false)
  })

  it('is true for a hand-built replaceable kind', () => {
    const policy: EditPolicy = {
      provider: 'anthropic',
      kinds: {
        'tool-result': 'replaceable',
        'tool-input': 'unverified',
        reasoning: 'immutable',
        'assistant-text': 'immutable',
      },
      status: 'declared-unverified',
      source: 'test fixture',
    }
    expect(mayReplace(policy, 'tool-result')).toBe(true)
  })
})

describe('EditPolicy — measured requires verifiedAt at the type level', () => {
  it('a measured policy WITH verifiedAt type-checks and carries the date', () => {
    const policy: EditPolicy = {
      provider: 'anthropic',
      kinds: {
        'tool-result': 'replaceable',
        'tool-input': 'replaceable',
        reasoning: 'immutable',
        'assistant-text': 'immutable',
      },
      status: 'measured',
      verifiedAt: '2026-09-25T00:00:00.000Z',
      source: 'a live measurement',
    }
    expect(policy.status).toBe('measured')
  })

  it('a measured policy WITHOUT verifiedAt fails to type-check', () => {
    // @ts-expect-error — status: 'measured' requires verifiedAt; the discriminated union in
    // edit-policy.ts must reject this literal. Removing this directive must make `tsc` fail.
    const policy: EditPolicy = {
      provider: 'anthropic',
      kinds: {
        'tool-result': 'replaceable',
        'tool-input': 'replaceable',
        reasoning: 'immutable',
        'assistant-text': 'immutable',
      },
      status: 'measured',
      source: 'a live measurement',
    }
    expect(policy.status).toBe('measured')
  })
})
