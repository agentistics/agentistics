import { describe, expect, it } from 'bun:test'
import { modeCycles, modeMenuFor, modeMenuPlacement } from './modeMenu'

describe('modeMenu', () => {
  it('lists only modes measured for each harness', () => {
    expect(modeMenuFor('claude').map(mode => mode.id)).toEqual([
      'manual', 'accept-edits', 'plan', 'auto',
    ])
    expect(modeMenuFor('codex')).toEqual([])
    expect(modeMenuFor(undefined)).toEqual([])
  })

  it('calculates forward cycles, including wraparound', () => {
    const modes = modeMenuFor('claude')
    expect(modeCycles('manual', 'plan', modes)).toBe(2)
    expect(modeCycles('auto', 'manual', modes)).toBe(1)
    expect(modeCycles('plan', 'plan', modes)).toBe(0)
    expect(modeCycles('unknown', 'plan', modes)).toBe(0)
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
