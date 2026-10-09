import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_SESSION_PATH, resolveHostSessionRefresh } from './hostSession'
import { panelBarEntries } from './panelBar'
import { bottomPanels, EMPTY_SLOT_LAYOUT } from './panelSlots'

const BOOT = { required: false, authed: true } as { required: boolean; authed: boolean; shellEnabled?: boolean }

describe('resolveHostSessionRefresh', () => {
  test('a successful read wins', () => {
    expect(resolveHostSessionRefresh(BOOT, { ...BOOT, shellEnabled: true }, BOOT).shellEnabled).toBe(true)
  })
  test('a failed first read falls back to the boot default', () => {
    expect(resolveHostSessionRefresh(undefined, null, BOOT)).toBe(BOOT)
  })
  test('a failed refresh keeps what is known', () => {
    const known = { ...BOOT, shellEnabled: true }
    expect(resolveHostSessionRefresh(known, null, BOOT)).toBe(known)
  })
})

// THE REGRESSION (v2.113.0): App.tsx stopped reading the session gates and held a constant, so
// `shellEnabled` was undefined -> OFF and the Shell tab vanished for every harness.
describe('App.tsx reads the host gates from the server', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8')
  test('fetches the session route and can update the state', () => {
    expect(src.includes('fetchWithTimeout(HOST_SESSION_PATH')).toBe(true)
    expect(/const \[teamSession, setTeamSession\] = useState/.test(src)).toBe(true)
    expect(HOST_SESSION_PATH).toBe('/api/team/session')
  })
  test('the shell flag reaching the panels comes from that read', () => {
    expect(/shellEnabled: teamSession\?\.shellEnabled === true/.test(src)).toBe(true)
  })
})

describe('the Shell tab is in the bottom band once the server says the shell is on', () => {
  const gates = { editorEnabled: true, shellEnabled: true, relayed: false, hardwareOffered: false, screen: true }
  test('default layout shows Claude Code and Shell', () => {
    const ids = panelBarEntries(bottomPanels(EMPTY_SLOT_LAYOUT), 'cli', gates).map(e => e.id)
    expect(ids).toContain('shell')
    expect(ids).toContain('cli')
  })
})
