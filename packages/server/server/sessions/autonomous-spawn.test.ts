import { describe, expect, test } from 'bun:test'
import { resolveAutonomousMode } from './spawn-context'
import { tuiStartModes } from './spawn-spec'

// Reads the machine's preferences for the global switch: under `agentop run --rm` that is an empty HOME (off).
// The per-session flag (`away` true) is the same autonomous signal and is deterministic here.
describe('resolveAutonomousMode', () => {
  const claudeCarries = tuiStartModes('claude').includes('no-questions')
  test('autonomous session → no-questions where the TUI can carry it', async () => {
    const r = await resolveAutonomousMode('claude', undefined, true)
    expect(r.mode).toBe(claudeCarries ? 'no-questions' : undefined)
    expect(r.fromAutonomous).toBe(claudeCarries)
  })
  test('explicit mode wins over autonomous', async () => {
    expect((await resolveAutonomousMode('claude', 'plan', true)).mode).toBe('plan')
    expect((await resolveAutonomousMode('claude', 'default', true)).mode).toBe('default')
  })
  test('off → inherited mode, else none', async () => {
    expect((await resolveAutonomousMode('claude', undefined, false, 'accept-edits')).mode).toBe('accept-edits')
    expect((await resolveAutonomousMode('claude', undefined, false)).mode).toBeUndefined()
  })
})
