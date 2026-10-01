import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkFrozen, isFrozen, parseFrozenList, parseNameStatus, type Change } from './frozen-paths'

const LIST = parseFrozenList(readFileSync(join(import.meta.dir, '../../../.github/frozen-engine-paths.txt'), 'utf8'))

describe('the frozen list', () => {
  test('freezes what ES.3 moved', () => {
    for (const p of [
      'packages/runtime/src/index.ts',
      'packages/server/server/integrations/claude/replay.ts',
      'packages/server/server/provider/credentials.ts',
      'packages/server/server/cli-provider.ts',
      'packages/server/server/cli-provider-models.test.ts',
      'packages/server/server/provider-web.ts',
      'packages/server/server/projections/differential.ts',
      'packages/server/server/projections/differential-kimi.test.ts',
      'packages/server/server/projections/parity-matrix.ts',
      'packages/server/scripts/parity-matrix.ts',
      'packages/server/test/fixtures/claude-replay/proj/x.jsonl',
    ]) expect(isFrozen(p, LIST)).toBe(true)
  })

  test('leaves engine-api, the slot/host and neighbours alone', () => {
    for (const p of [
      'packages/engine-api/src/index.ts',
      'packages/server/server/engine/load.ts',
      'packages/server/server/projections/session-meta.ts',
      'packages/server/server/index.ts',
      'packages/server/scripts/engine-slot.ts',
      'packages/server/test/fixtures/other/x.json',
      'packages/runtime-extra/x.ts',
    ]) expect(isFrozen(p, LIST)).toBe(false)
  })

  test('comments and blanks are not globs', () => {
    expect(parseFrozenList('# c\n\na/** # trailing\n')).toEqual(['a/**'])
  })
})

describe('checkFrozen', () => {
  const frozen = 'packages/runtime/src/a.ts'
  const free = 'packages/web/src/b.ts'

  test('an add or modify of a frozen path fails, naming the path and the engine repo', () => {
    for (const status of ['A', 'M'] as const) {
      const v = checkFrozen([{ status, path: frozen }], LIST, `[ES.4] anything`)
      expect(v.ok).toBe(false)
      expect(v.violations[0]!.sentence).toContain(frozen)
      expect(v.violations[0]!.sentence).toContain('fix it in agentistics/agentistics-engine')
    }
  })

  test('delete-only with the [ES.4] title tag passes', () => {
    const changes: Change[] = [{ status: 'D', path: frozen }, { status: 'M', path: free }]
    expect(checkFrozen(changes, LIST, 'chore: [ES.4] delete the public engine copies').ok).toBe(true)
  })

  test('delete-only WITHOUT the tag fails', () => {
    const v = checkFrozen([{ status: 'D', path: frozen }], LIST, 'chore: delete runtime')
    expect(v.ok).toBe(false)
    expect(v.violations[0]!.sentence).toContain('[ES.4]')
  })

  test('the tag does not excuse a modification beside the deletions', () => {
    const v = checkFrozen(
      [{ status: 'D', path: frozen }, { status: 'M', path: 'packages/server/server/provider/credentials.ts' }],
      LIST,
      '[ES.4] delete',
    )
    expect(v.ok).toBe(false)
    expect(v.violations.map(x => x.path)).toEqual(['packages/server/server/provider/credentials.ts'])
  })

  test('a PR touching only non-frozen paths passes', () => {
    expect(checkFrozen([{ status: 'M', path: free }, { status: 'A', path: 'packages/engine-api/x.ts' }], LIST, '').ok).toBe(true)
  })
})

describe('parseNameStatus', () => {
  test('reads git diff --name-status, and splits a rename into delete + add', () => {
    expect(parseNameStatus('M\ta.ts\nD\tb.ts\nR100\tc.ts\td.ts\n\n')).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'D', path: 'b.ts' },
      { status: 'D', path: 'c.ts' },
      { status: 'A', path: 'd.ts' },
    ])
  })

  test('a rename OUT of a frozen path is not a deletion: its new side is checked too', () => {
    const changes = parseNameStatus('R100\tpackages/runtime/a.ts\tpackages/runtime/b.ts\n')
    expect(checkFrozen(changes, LIST, '[ES.4]').ok).toBe(false)
  })
})
