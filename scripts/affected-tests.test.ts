import { describe, expect, test } from 'bun:test'
import { needsTypecheck, parseSlowList, selectTests } from './affected-tests'

const ALL = [
  'packages/web/src/lib/a.test.ts',
  'packages/web/src/lib/b.test.ts',
  'packages/web/src/components/X.test.tsx',
  'packages/server/server/s.test.ts',
  'packages/server/server/claude-chat-removed.test.ts',
  'packages/core/src/c.test.ts',
]
const SLOW = new Set(['packages/server/server/claude-chat-removed.test.ts'])

describe('selectTests', () => {
  test('a staged test file runs itself', () => {
    expect(selectTests(['packages/web/src/lib/a.test.ts'], ALL, SLOW).files).toEqual(['packages/web/src/lib/a.test.ts'])
  })
  test('a source file runs the tests in its own directory only', () => {
    const s = selectTests(['packages/web/src/lib/a.ts'], ALL, SLOW)
    expect(s.mode).toBe('files')
    expect(s.files).toEqual(['packages/web/src/lib/a.test.ts', 'packages/web/src/lib/b.test.ts'])
  })
  test('a web component runs its directory (tsx)', () => {
    expect(selectTests(['packages/web/src/components/X.tsx'], ALL, SLOW).files).toEqual(['packages/web/src/components/X.test.tsx'])
  })
  test('shared core falls back to the full suite', () => {
    expect(selectTests(['packages/core/src/types.ts'], ALL, SLOW).mode).toBe('full')
  })
  test.each(['bun.lock', 'package.json', 'tsconfig.json', '.husky/pre-commit', 'scripts/x.ts', 'packages/engine-api/src/i.ts'])(
    '%s falls back to the full suite', p => expect(selectTests([p], ALL, SLOW).mode).toBe('full'))
  test('docs and images need no tests', () => {
    const s = selectTests(['README.md', 'docs/a.png', 'CLAUDE.md'], ALL, SLOW)
    expect(s.mode).toBe('none')
  })
  test('slow tests are excluded from the selection but reported', () => {
    const s = selectTests(['packages/server/server/claude-chat-removed.ts'], ALL, SLOW)
    expect(s.files).toEqual(['packages/server/server/s.test.ts'])
    expect(s.reason).toContain('slow')
  })
  test('only a slow test relates: none, said in words', () => {
    const s = selectTests(['packages/server/server/claude-chat-removed.test.ts'], ALL, SLOW)
    expect(s.mode).toBe('none')
    expect(s.reason).toContain('slow')
  })
  test('a source file in a directory with no tests runs nothing', () => {
    expect(selectTests(['packages/mcp/index.ts'], ALL, SLOW).mode).toBe('none')
  })
  test('a deleted/unknown test path is not invented', () => {
    expect(selectTests(['packages/web/src/lib/gone.test.ts'], ALL, SLOW).mode).toBe('none')
  })
})

describe('parseSlowList / needsTypecheck', () => {
  test('comments and blanks ignored', () => {
    expect([...parseSlowList('# slow\na.test.ts # why\n\nb.test.ts\n')]).toEqual(['a.test.ts', 'b.test.ts'])
  })
  test('docs-only needs no typecheck; ts does', () => {
    expect(needsTypecheck(['README.md', 'a.png'])).toBe(false)
    expect(needsTypecheck(['a.tsx'])).toBe(true)
    expect(needsTypecheck(['bun.lock'])).toBe(true)
  })
})
