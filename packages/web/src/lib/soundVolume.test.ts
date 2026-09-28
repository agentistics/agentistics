import { describe, expect, it } from 'bun:test'
import { chatSoundActive, clampVolume } from './soundVolume'

describe('clampVolume', () => {
  it('passes a valid in-range value through unchanged', () => {
    expect(clampVolume(0.42, 0.8)).toBe(0.42)
  })

  it('clamps above 1 down to 1', () => {
    expect(clampVolume(1.5, 0.8)).toBe(1)
  })

  it('clamps below 0 up to 0 — a silenced slider must actually be silent', () => {
    expect(clampVolume(-0.3, 0.8)).toBe(0)
  })

  it('falls back when the value is missing', () => {
    expect(clampVolume(undefined, 0.8)).toBe(0.8)
  })

  it('falls back on NaN rather than propagating it into the audio graph', () => {
    expect(clampVolume(NaN, 0.8)).toBe(0.8)
  })

  it('falls back on Infinity the same way', () => {
    expect(clampVolume(Infinity, 0.8)).toBe(0.8)
    expect(clampVolume(-Infinity, 0.8)).toBe(0.8)
  })

  it('0 is a real value, not a missing one', () => {
    expect(clampVolume(0, 0.8)).toBe(0)
  })
})

describe('chatSoundActive', () => {
  it('plays only when both the global sound switch and the chat switch are on', () => {
    expect(chatSoundActive({ globalSoundEnabled: true, chatSoundEnabled: true })).toBe(true)
  })

  it('the global switch narrows — turning it off silences chat even if chat wants sound', () => {
    expect(chatSoundActive({ globalSoundEnabled: false, chatSoundEnabled: true })).toBe(false)
  })

  it("chat's own switch narrows too — it can opt out without touching the global one", () => {
    expect(chatSoundActive({ globalSoundEnabled: true, chatSoundEnabled: false })).toBe(false)
  })

  it('both off stays off', () => {
    expect(chatSoundActive({ globalSoundEnabled: false, chatSoundEnabled: false })).toBe(false)
  })
})
