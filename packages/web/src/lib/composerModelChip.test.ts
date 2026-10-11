import { describe, expect, test } from 'bun:test'
import { MODEL_CHIP_MIN_VIEWPORT, modelChipLabel, modelChipShown } from './composerModelChip'

const base = { isMobile: true, viewportWidth: 390, answeringNow: false, canSwitch: true }

describe('modelChipShown', () => {
  test('a 390px phone shows the model in the composer', () => {
    expect(modelChipShown(base)).toBe(true)
  })
  test('under 360px it goes back into "More" only', () => {
    expect(MODEL_CHIP_MIN_VIEWPORT).toBe(360)
    expect(modelChipShown({ ...base, viewportWidth: 359 })).toBe(false)
    expect(modelChipShown({ ...base, viewportWidth: 360 })).toBe(true)
  })
  test('never on desktop, never while answering a question, never with nothing to switch to', () => {
    expect(modelChipShown({ ...base, isMobile: false, viewportWidth: 1400 })).toBe(false)
    expect(modelChipShown({ ...base, answeringNow: true })).toBe(false)
    expect(modelChipShown({ ...base, canSwitch: false })).toBe(false)
  })
})

describe('modelChipLabel', () => {
  test('the short name, or the word when nothing named one', () => {
    expect(modelChipLabel('Opus 5.5', false)).toBe('Opus')
    expect(modelChipLabel('gpt-5.4-codex', false)).toBe('gpt-5.4-codex')
    expect(modelChipLabel(undefined, true)).toBe('Modelo')
  })
})
