import { describe, expect, test } from 'bun:test'
import { conversationLinkOf, rollupProvenanceOf } from './conversation-link'

const base = { harness: 'claude' as const, external: false, platform: 'linux' as const }

describe('conversationLinkOf — legacy rows keep their old meaning', () => {
  test('id, no link fields → spawn/assigned-id (absent reads assigned)', () => {
    const l = conversationLinkOf({ ...base, conversationId: 'c' })
    expect(l).toEqual({ provenance: 'spawn', reason: 'assigned-id', exact: true })
    expect(rollupProvenanceOf(l)).toBe('assigned')
  })
  test('legacy observed → recovered/first-sighting, not exact', () => {
    const l = conversationLinkOf({ ...base, conversationId: 'c', conversationLink: 'observed' })
    expect(l).toEqual({ provenance: 'recovered', reason: 'first-sighting', exact: false })
    expect(rollupProvenanceOf(l)).toBe('observed')
  })
  test('linkVia wins over the legacy field', () => {
    const l = conversationLinkOf({ ...base, conversationId: 'c', conversationLink: 'assigned', linkVia: 'process-log' })
    expect(l?.reason).toBe('process-log')
    expect(rollupProvenanceOf(l)).toBe('assigned')
  })
})

describe('conversationLinkOf — absence', () => {
  test('no id yet is null, never unrecoverable', () => {
    expect(conversationLinkOf(base)).toBeNull()
    expect(rollupProvenanceOf(null)).toBe('none')
  })
  test('unrecoverable only from harness/platform facts', () => {
    expect(conversationLinkOf({ ...base, harness: 'codex', noIdRoute: true })?.reason).toBe('no-id-route')
    expect(conversationLinkOf({ ...base, harness: 'antigravity', needsProc: true, platform: 'darwin' })?.reason).toBe('platform-unsupported')
    expect(conversationLinkOf({ ...base, harness: 'antigravity', needsProc: true })).toBeNull()
    const ext = conversationLinkOf({ ...base, external: true })
    expect(ext?.provenance).toBe('unrecoverable')
    expect(rollupProvenanceOf(ext)).toBe('none')
  })
})
