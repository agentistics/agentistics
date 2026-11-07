/**
 * QA (LOTE.LIVE-UI A+B, s-e6ed9a6bff): the owner asked for the Nay dock's "Limites" tab to go away, with
 * "Ligações" (the engine's `nay-sessions` surface) taking its place at the TOP of the dock, in the tab
 * strip, rather than as a button inside Sessões below the search and "+".
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'NayDock.tsx'), 'utf8')

describe('Nay dock tabs (owner, s-e6ed9a6bff)', () => {
  test('the dock has no "Limites" tab', () => {
    const tabs = /const FIXED_TABS[^=]*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? ''
    expect(tabs).toContain("'nay'")
    expect(tabs).not.toContain("'limits'")
    expect(src).not.toContain('NayLimitsTab')
    expect(src).not.toContain("'Limites'")
  })

  test('Ligações sits in the dock tab strip, not inside the Sessões aside', () => {
    expect(src).toContain('const dockTabs')
    expect(src).toContain('...engineTabLabels.map(t => t.id)')
    // SessionsAside no longer receives the engine surfaces as a sub-tab.
    const aside = /<SessionsAside[\s\S]*?\/>/.exec(src)?.[0] ?? ''
    expect(aside).not.toContain('extraTabs')
  })
})
