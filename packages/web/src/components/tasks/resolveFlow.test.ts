import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveView, RESOLVED_FLASH_MS } from './resolveFlow'
import { threadCopy } from './threadCopy'

describe('resolveView — the three visible moments of a resolve', () => {
  test('open topic offers Resolve', () => expect(resolveView({ pending: false, flashing: false })).toBe('resolve'))
  test('while the verb is out the button says it is working', () => expect(resolveView({ pending: true, flashing: false })).toBe('working'))
  test('right after, the button reads done (held), before the ordinary resolved state', () => {
    expect(resolveView({ resolvedAt: '2026-10-05', pending: false, flashing: true })).toBe('done')
    expect(RESOLVED_FLASH_MS).toBeGreaterThan(1000)
  })
  test('a resolved topic then offers Reopen, and reopening flashes nothing', () => {
    expect(resolveView({ resolvedAt: '2026-10-05', pending: false, flashing: false })).toBe('reopen')
    expect(resolveView({ pending: false, flashing: false })).toBe('resolve')
  })
})

describe('the words', () => {
  test('Resolvido ✓ / Resolved ✓ and the section it moves to', () => {
    expect(threadCopy('pt').resolvedNow).toBe('Resolvido ✓')
    expect(threadCopy('en').resolvedNow).toBe('Resolved ✓')
    expect(threadCopy('pt').resolved).toBe('Resolvidos')
  })
  test('the panel wires the button to it, shows a note and keeps a Resolved badge', () => {
    const src = readFileSync(join(import.meta.dir, 'ThreadsPanel.tsx'), 'utf8')
    expect(src).toContain('data-resolve-button')
    expect(src).toContain('resolveView(')
    expect(src).toContain('data-resolved-note')
    expect(src).toContain('data-resolved-badge')
  })
})
