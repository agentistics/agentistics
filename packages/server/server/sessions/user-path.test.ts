import { expect, test } from 'bun:test'
import { userSearchPath } from './user-path'

test('~/.local/bin goes first, exactly once, whatever PATH the service started with', () => {
  expect(userSearchPath('/usr/bin:/bin', '/home/u')).toBe('/home/u/.local/bin:/usr/bin:/bin')
  expect(userSearchPath('/usr/bin:/home/u/.local/bin', '/home/u')).toBe('/home/u/.local/bin:/usr/bin')
  expect(userSearchPath('', '/home/u')).toBe('/home/u/.local/bin')
})

test('per-user installer dirs are appended only when they exist, never ahead of PATH', () => {
  const has = (d: string) => d === '/home/u/.volta/bin' || d === '/home/u/.bun/bin'
  expect(userSearchPath('/usr/bin', '/home/u', has)).toBe('/home/u/.local/bin:/usr/bin:/home/u/.bun/bin:/home/u/.volta/bin')
  expect(userSearchPath('/home/u/.volta/bin:/usr/bin', '/home/u', has)).toBe('/home/u/.local/bin:/home/u/.volta/bin:/usr/bin:/home/u/.bun/bin')
  expect(userSearchPath('/usr/bin', '/home/u', () => false)).toBe('/home/u/.local/bin:/usr/bin')
})
