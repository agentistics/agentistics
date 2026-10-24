import { describe, expect, it } from 'bun:test'
import { modeMenuFor, modeMenuPlacement } from './modeMenu'

describe('modeMenu', () => {
  it('lists only modes measured for each harness', () => {
    expect(modeMenuFor('claude').map(mode => mode.id)).toEqual([
      'manual', 'accept-edits', 'plan', 'bypass', 'auto',
    ])
    expect(modeMenuFor('codex')).toEqual([])
    expect(modeMenuFor(undefined)).toEqual([])
  })

  it('MODE.NOQ — claude offers "no questions" (bypass permissions), in its measured cycle place', () => {
    const bypass = modeMenuFor('claude').find(mode => mode.id === 'bypass')
    expect(bypass?.canonical).toBe('no-questions')
    // claude 2.1.310 with --allow-dangerously-skip-permissions: plan -> bypass -> auto
    const ids = modeMenuFor('claude').map(mode => mode.id)
    expect(ids.indexOf('bypass')).toBe(ids.indexOf('plan') + 1)
    // only one entry carries the warning-bearing canonical
    expect(modeMenuFor('claude').filter(mode => mode.canonical === 'no-questions')).toHaveLength(1)
  })

  it('clamps a menu to both viewport margins and flips it up when needed', () => {
    expect(modeMenuPlacement({ left: 370, bottom: 100 }, 390, 800)).toEqual({
      left: 192, top: 104, width: 190,
    })
    expect(modeMenuPlacement({ left: 20, bottom: 760 }, 390, 800)).toEqual({
      left: 20, top: 572, width: 190,
    })
    expect(modeMenuPlacement({ left: 0, bottom: 40 }, 100, 100, 190, 220)).toEqual({
      left: 8, top: 8, width: 84,
    })
  })
})
