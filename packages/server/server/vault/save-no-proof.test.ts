import { describe, expect, test } from 'bun:test'
import { VAULT_ACTION_ROWS, rowFor } from './gate'

/**
 * Owner, 2026-10-05: SAVING a secret asks for no proof at all (no Hello, no authenticator code); only
 * VIEWING asks presence, and the code stays for critical actions. These rows are the save paths.
 */
describe('saving a secret costs no proof on this computer', () => {
  const here = { session: 'http:local', loopback: true }
  test.each(['personal-create', 'personal-import-env', 'personal-group-write', 'personal-list'] as const)('%s asks nothing', action => {
    expect(rowFor(action, here)).toEqual({ code: false, gesture: false, grant: null })
    expect(VAULT_ACTION_ROWS[action]).toEqual({ code: false, gesture: false, grant: null })
  })
  test('viewing is the gesture, never the code', () => {
    expect(VAULT_ACTION_ROWS['personal-reveal']).toEqual({ code: false, gesture: true, grant: null })
  })
  test('critical actions keep the code', () => {
    for (const a of ['personal-purge', 'personal-restore-version', 'rekey', 'reset'] as const) expect(VAULT_ACTION_ROWS[a].code).toBe(true)
  })
})
