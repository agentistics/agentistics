import { expect, test } from 'bun:test'
import { userSearchPath } from './user-path'

test('~/.local/bin goes first, exactly once, whatever PATH the service started with', () => {
  expect(userSearchPath('/usr/bin:/bin', '/home/u')).toBe('/home/u/.local/bin:/usr/bin:/bin')
  expect(userSearchPath('/usr/bin:/home/u/.local/bin', '/home/u')).toBe('/home/u/.local/bin:/usr/bin')
  expect(userSearchPath('', '/home/u')).toBe('/home/u/.local/bin')
})
