import { describe, expect, test } from 'bun:test'
import { accountHome, homeFromPasswd } from './account-home'

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'o:x:1000:1000:Owner,,,:/home/o:/bin/bash',
  'svc:x:1001:1001::/var/lib/svc:/usr/sbin/nologin',
].join('\n')

describe('the account\'s home, not $HOME (Bun\'s userInfo().homedir follows $HOME)', () => {
  test('read from the uid\'s passwd line', () => {
    expect(homeFromPasswd(PASSWD, 1000)).toBe('/home/o')
    expect(homeFromPasswd(PASSWD, 1001)).toBe('/var/lib/svc')
    expect(homeFromPasswd(PASSWD, 4242)).toBeNull()
    expect(homeFromPasswd('garbage', 0)).toBeNull()
  })
  test('an overridden HOME does not move it (this process)', () => {
    const before = process.env.HOME
    try {
      process.env.HOME = '/tmp/isolated-home'
      expect(accountHome()).not.toBe('/tmp/isolated-home')
    } finally {
      process.env.HOME = before
    }
  })
})
