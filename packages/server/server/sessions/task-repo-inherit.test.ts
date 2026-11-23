import { expect, test } from 'bun:test'
import { isRepoInherited, repoInheritancePatch } from './task-model'

test('filing a session on a task without a repo writes it, stamped as inherited from that session', () => {
  expect(repoInheritancePatch({}, 's1', 'a/b')).toEqual({ repo: 'a/b', repoSource: 'inherited', repoFromSession: 's1' })
})
test('an existing repo is never overwritten, explicit or not', () => {
  expect(repoInheritancePatch({ repo: 'x/y' }, 's1', 'a/b')).toBeNull()
})
test('no repo to inherit writes nothing', () => {
  expect(repoInheritancePatch({}, 's1', undefined)).toBeNull()
  expect(repoInheritancePatch({}, 's1', '')).toBeNull()
})
test('provenance: explicit is not inherited; inherited and legacy (no source) are; no repo is neither', () => {
  expect(isRepoInherited({ repo: 'a/b', repoSource: 'explicit' })).toBe(false)
  expect(isRepoInherited({ repo: 'a/b', repoSource: 'inherited' })).toBe(true)
  expect(isRepoInherited({ repo: 'a/b' })).toBe(true)
  expect(isRepoInherited({})).toBe(false)
})
