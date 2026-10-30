import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The phone's composer once drew a second model picker (a chip) beside the one behind the
// Send chevron ("More"). Both opened the same list; the chip is gone, on every harness.
describe('composer has ONE model picker', () => {
  const src = readFileSync(new URL('../components/sessions/SessionChat.tsx', import.meta.url), 'utf8')
  test('no model chip is rendered at any width', () => {
    expect(src).not.toContain('data-model-chip')
    expect(src).not.toContain('composerModelChip')
  })
  test('the model list lives behind the status band model button (M3: no chevron)', () => {
    expect(src).toContain('<TypedModel')
    expect(src).toContain('ag-composer-model-button')
    expect(src).not.toContain('ag-composer-more-status')
  })
})
