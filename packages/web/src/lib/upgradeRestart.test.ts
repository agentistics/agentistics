import { describe, expect, test } from 'bun:test'
import { restartStep } from './upgradeRestart'

describe('update restart state machine', () => {
  test('holds the loader through restart and waits for the new version', () => {
    let phase = restartStep('updating', { type: 'submitted' })
    expect(phase).toBe('restarting')
    phase = restartStep(phase, { type: 'poll', version: 'down' })
    expect(phase).toBe('waiting-new-version')
    phase = restartStep(phase, { type: 'poll', version: 'old' })
    expect(phase).toBe('waiting-new-version')
    expect(restartStep(phase, { type: 'poll', version: 'new', serviceWorkerReady: false })).toBe('waiting-new-version')
    phase = restartStep(phase, { type: 'poll', version: 'new', serviceWorkerReady: true, bundleReady: true })
    expect(phase).toBe('ready')
    expect(restartStep(phase, { type: 'swap' })).toBe('swap')
  })

  test('does not swap on an old or incomplete answer', () => {
    expect(restartStep('updating', { type: 'poll', version: 'new' })).toBe('updating')
    expect(restartStep('waiting-new-version', { type: 'poll', version: 'new', bundleReady: false })).toBe('waiting-new-version')
    expect(restartStep('waiting-new-version', { type: 'swap' })).toBe('waiting-new-version')
  })
})

