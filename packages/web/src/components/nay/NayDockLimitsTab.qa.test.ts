/**
 * QA (LOTE.LIVE-UI A+B, s-e6ed9a6bff): the owner asked for the Nay dock's "Limites" tab to go away, with
 * "Ligações" taking its place at the top (today Ligações is a button below the search and "+", inside the
 * Sessões tab). On feat/esteira-parte-b @e6e411f6e the dock still lists `limits` and Ligações is still an
 * extra tab inside Sessões.
 *
 * Written as `test.failing` so it documents the defect without breaking the hook: once the tab is removed
 * this starts to FAIL — flip it to a plain `test` then.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'NayDock.tsx'), 'utf8')

describe('Nay dock tabs (owner, s-e6ed9a6bff)', () => {
  test.failing('the dock has no "Limites" tab', () => {
    const tabs = /const DOCK_TABS[^=]*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? ''
    expect(tabs).not.toContain("'limits'")
  })
})
