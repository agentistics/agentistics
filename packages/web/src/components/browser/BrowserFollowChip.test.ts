import { describe, expect, test } from 'bun:test'
import { followChipView } from './BrowserFollowChip'

describe('followChipView dot colour follows the session state', () => {
  const dot = (state: 'working' | 'waiting' | 'waiting-approval' | 'lost' | 'exited') =>
    followChipView({ title: 'S', state }, undefined, 'en').dot

  test('working is green', () => {
    expect(dot('working')).toBe('#22c55e')
  })
  test('needs-you states are orange', () => {
    expect(dot('waiting')).toBe('var(--anthropic-orange)')
    expect(dot('waiting-approval')).toBe('var(--anthropic-orange)')
  })
  test('lost, exited and unknown row are grey', () => {
    expect(dot('lost')).toBe('var(--text-tertiary)')
    expect(dot('exited')).toBe('var(--text-tertiary)')
    expect(followChipView(undefined, 'x', 'pt').dot).toBe('var(--text-tertiary)')
  })
  test('the three colours are distinct', () => {
    expect(new Set([dot('working'), dot('waiting'), dot('lost')]).size).toBe(3)
  })
})
