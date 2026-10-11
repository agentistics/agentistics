import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { worstUsedPct } from '../lib/planLimits'

const src = readFileSync(new URL('./SessionsPage.tsx', import.meta.url), 'utf8')

test('every foldable drawer section starts closed and is wired to a fold', () => {
  for (const name of ['drawerLimitsOpen', 'drawerSessionOpen', 'drawerActionsOpen', 'drawerCtxOpen']) {
    expect(src).toContain(`const [${name}, set${name[0]!.toUpperCase()}${name.slice(1)}] = useState(false)`)
    expect(src).toContain(`open: ${name}, toggle:`)
  }
  expect(src).not.toMatch(/drawerSection\('view'[^]*open: drawerView/)
})

test('worstUsedPct picks the most pressing window, null when nothing reads', () => {
  const now = 1_000_000
  const mk = (usedPct: number, kind: '5h' | 'week') => ({ kind, usedPct, resetsAt: now + 3_600_000 })
  const limits = [
    { harness: 'claude', windows: [mk(30, '5h'), mk(80, 'week')] },
    { harness: 'codex', windows: [mk(55, '5h')] },
  ] as never
  expect(worstUsedPct(limits, now)).toBe(80)
  expect(worstUsedPct(null, now)).toBeNull()
  expect(worstUsedPct([], now)).toBeNull()
})
