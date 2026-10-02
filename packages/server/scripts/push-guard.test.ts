import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrozenList } from './frozen-paths'
import { checkPush, parsePushLines, planRange } from './push-guard'

const LIST = parseFrozenList(readFileSync(join(import.meta.dir, '../../../.github/frozen-engine-paths.txt'), 'utf8'))
const Z = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('checkPush', () => {
  test('refuses an add or modify of a frozen path, naming it', () => {
    for (const status of ['A', 'M'] as const) {
      const v = checkPush([{ status, path: 'packages/runtime/src/x.ts' }], LIST, 'fix/x')
      expect(v.ok).toBe(false)
      expect(v.offences[0]!.sentence).toContain('packages/runtime/src/x.ts')
    }
  })
  test('refuses every engine-layout path', () => {
    for (const path of ['engine/src/a.ts', 'runtime/src/a.ts', 'engine/test/a.ts', 'public.pin']) {
      expect(checkPush([{ status: 'A', path }], LIST).ok).toBe(false)
    }
  })
  test('engine.pin and ordinary paths are allowed', () => {
    expect(checkPush([{ status: 'M', path: 'engine.pin' }, { status: 'A', path: 'packages/web/src/a.ts' }, { status: 'A', path: 'packages/engine-api/src/a.ts' }], LIST).ok).toBe(true)
  })
  test('deletions are allowed (ES.4 delete-only), a modify beside them is not', () => {
    expect(checkPush([{ status: 'D', path: 'packages/runtime/src/x.ts' }, { status: 'D', path: 'engine/src/a.ts' }], LIST).ok).toBe(true)
    const v = checkPush([{ status: 'D', path: 'packages/runtime/src/x.ts' }, { status: 'M', path: 'runtime/src/y.ts' }], LIST)
    expect(v.offences.map(o => o.path)).toEqual(['runtime/src/y.ts'])
  })
})

describe('planRange', () => {
  test('an existing branch diffs remote..local', () => {
    expect(planRange({ localRef: 'r', localSha: A, remoteRef: 'r', remoteSha: B })).toEqual({ kind: 'diff', base: B, head: A })
  })
  test('a new branch compares against origin/main', () => {
    expect(planRange({ localRef: 'r', localSha: A, remoteRef: 'r', remoteSha: Z })).toEqual({ kind: 'new-branch', head: A, against: 'origin/main' })
  })
  test('a branch deletion is skipped', () => {
    expect(planRange({ localRef: '(delete)', localSha: Z, remoteRef: 'r', remoteSha: B })).toEqual({ kind: 'skip', why: 'delete' })
  })
})

describe('parsePushLines', () => {
  test('reads git stdin and drops junk', () => {
    expect(parsePushLines(`refs/heads/a ${A} refs/heads/a ${Z}\n\nbad\n`)).toEqual([{ localRef: 'refs/heads/a', localSha: A, remoteRef: 'refs/heads/a', remoteSha: Z }])
  })
})
