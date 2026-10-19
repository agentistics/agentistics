import { describe, expect, test } from 'bun:test'
import type { CleanWebItem } from '@agentistics/core'
import { cleanIdle, cleanMatches, cleanName, cleanSize, sortCleanItems, initialCleanSelection, toggleCleanVisible } from './cleanPresentation'
const now = 20 * 86_400_000
const item = (overrides: Partial<CleanWebItem> = {}): CleanWebItem => ({ id: 'a', repo: '/repo', project: 'repo', path: '/very/long/prefix/with/many/levels/worktree-name', name: 'worktree-name', kind: 'remove', bytes: 1024, reason: 'merged and clean', lastActivityMs: now - 8 * 86_400_000, ...overrides })
describe('cleanup presentation', () => {
  test('uses the leaf name instead of truncating the path before the worktree name', () => {
    expect(cleanName(item())).toBe('worktree-name')
    expect(cleanName(item({ name: 'important-name/node_modules', kind: 'node-modules' }))).toBe('important-name')
    expect(cleanName(item({ name: '', path: 'C:\\repo\\.worktrees\\important-name', kind: 'node-modules' }))).toBe('important-name')
  })
  test('localizes decimal sizes, zero bytes, unknown activity and future timestamps', () => {
    expect(cleanSize(1.5 * 1024 ** 3, 'pt')).toBe('1,5 GB')
    expect(cleanSize(1.5 * 1024 ** 3, 'en')).toBe('1.5 GB')
    expect(cleanSize(0, 'en')).toBe('0 B')
    expect(cleanIdle(null, now, 'pt')).toBe('—')
    expect(cleanIdle(now + 1000, now, 'en')).toBe('now')
    expect(cleanIdle(now - 86_400_000, now, 'pt')).toBe('1 dia')
  })
  test('idle filter is independent of the type and refuses unknown activity', () => {
    expect(cleanMatches(item(), 'idle', now)).toBe(true)
    expect(cleanMatches(item({ kind: 'node-modules' }), 'idle', now)).toBe(true)
    expect(cleanMatches(item({ lastActivityMs: null }), 'idle', now)).toBe(false)
    expect(cleanMatches(item({ lastActivityMs: now - 7 * 86_400_000 }), 'idle', now)).toBe(false)
    expect(cleanMatches(item({ kind: 'prune' }), 'worktrees', now)).toBe(true)
    expect(cleanMatches(item({ kind: 'keep' }), 'worktrees', now)).toBe(false)
  })
  test('sorts a copy numerically by size, places unknown activity last and is stable on ties', () => {
    const rows = [item({ id: 'b', bytes: 200 }), item({ id: 'a', bytes: 10 }), item({ id: 'c', lastActivityMs: null, bytes: 200 })]
    expect(sortCleanItems(rows, 'bytes', true).map(i => i.id)).toEqual(['b', 'c', 'a'])
    expect(sortCleanItems(rows, 'idle', false).at(-1)?.id).toBe('c')
    expect(rows[0]?.id).toBe('b')
  })
})


describe('cleanup selection', () => {
  const rows = [item({ id: 'remove' }), item({ id: 'nm', kind: 'node-modules' }), item({ id: 'prune', kind: 'prune', bytes: 0 }), item({ id: 'keep', kind: 'keep' })]
  test('dependencies are opt-in, kept paths cannot be selected by select-all, zero-byte records can', () => {
    expect([...initialCleanSelection(rows)]).toEqual(['remove', 'prune'])
    expect([...toggleCleanVisible(new Set(), rows)]).toEqual(['remove', 'nm', 'prune'])
  })
  test('selecting/deselecting a filtered view preserves hidden selections', () => {
    const current = new Set(['remove'])
    const selected = toggleCleanVisible(current, [rows[1]!])
    expect([...selected]).toEqual(['remove', 'nm'])
    expect([...toggleCleanVisible(selected, [rows[1]!])]).toEqual(['remove'])
    expect([...current]).toEqual(['remove'])
    expect([...toggleCleanVisible(current, [rows[3]!])]).toEqual(['remove'])
  })
})

test('default all view groups selectable rows before protected rows, each by descending size', () => {
  const rows = [item({ id: 'dirty-big', kind: 'keep', bytes: 900 }), item({ id: 'remove', bytes: 50 }), item({ id: 'active', kind: 'keep', bytes: 400 }), item({ id: 'nm', kind: 'node-modules', bytes: 200 }), item({ id: 'prune', kind: 'prune', bytes: 0 })]
  expect(sortCleanItems(rows, 'bytes', true, true).map(i => i.id)).toEqual(['nm', 'remove', 'prune', 'dirty-big', 'active'])
  expect(sortCleanItems(rows, 'bytes', false).map(i => i.id)).toEqual(['prune', 'remove', 'nm', 'active', 'dirty-big'])
})
