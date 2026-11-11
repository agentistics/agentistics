import { test, expect } from 'bun:test'
import { OFFERED_TAG_SOURCE_TYPES } from './tagSourceTypes'

test('the picker offers repo and project first, then session attributes', () => {
  expect([...OFFERED_TAG_SOURCE_TYPES]).toEqual(['repo', 'project', 'harness', 'model'])
})

test('machine is read but never offered: there is exactly one', () => {
  expect(OFFERED_TAG_SOURCE_TYPES).not.toContain('machine')
})
