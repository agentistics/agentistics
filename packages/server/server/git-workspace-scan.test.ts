import { expect, test } from 'bun:test'
import { isNeverAWorkspace } from './git'

const env = { home: '/home/u', tmp: '/tmp' }

test('the temp roots themselves are never scanned as workspaces', () => {
  expect(isNeverAWorkspace('/tmp', env)).toBe(true)
  expect(isNeverAWorkspace('/tmp/', env)).toBe(true)
  expect(isNeverAWorkspace('/var/tmp', env)).toBe(true)
  expect(isNeverAWorkspace('/var/folders', env)).toBe(true)
})

test('a workspace made inside a temp folder is still scanned (tests, scratch dirs)', () => {
  expect(isNeverAWorkspace('/tmp/ws-123', env)).toBe(false)
})

test('the home folder itself and the root are never scanned', () => {
  expect(isNeverAWorkspace('/home/u', env)).toBe(true)
  expect(isNeverAWorkspace('/home/u/', env)).toBe(true)
  expect(isNeverAWorkspace('/', env)).toBe(true)
})

test('a real workspace folder under home is still scanned', () => {
  expect(isNeverAWorkspace('/home/u/code', env)).toBe(false)
  expect(isNeverAWorkspace('/home/u/projects/acme', env)).toBe(false)
  expect(isNeverAWorkspace('/tmpfoo/bar', env)).toBe(false)
})
