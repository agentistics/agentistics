import { describe, it, expect } from 'bun:test'
import { join, resolve } from 'path'
import { userInfo } from 'node:os'
import { resolveDataDir } from './data-dir'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { NOTIFICATIONS_FILE } from './notifications-store'

const HOME = '/home/someone'
const temp = () => '/tmp/agentistics-test-data-abc'

describe('resolveDataDir', () => {
  it('outside a test run: AGENTISTICS_DIR, else ~/.agentistics — unchanged', () => {
    expect(resolveDataDir({ env: {}, home: HOME, ownerHome: HOME, makeTemp: temp })).toEqual({ dir: join(HOME, '.agentistics'), isolated: false })
    expect(resolveDataDir({ env: { AGENTISTICS_DIR: '/srv/a' }, home: HOME, ownerHome: HOME, makeTemp: temp }))
      .toEqual({ dir: '/srv/a', isolated: false })
    expect(resolveDataDir({ env: { NODE_ENV: 'production' }, home: HOME, ownerHome: HOME, makeTemp: temp }).dir).toBe(join(HOME, '.agentistics'))
  })

  it('under test with no AGENTISTICS_DIR: a fresh temporary directory, flagged for export', () => {
    expect(resolveDataDir({ env: { NODE_ENV: 'test' }, home: HOME, ownerHome: HOME, makeTemp: temp }))
      .toEqual({ dir: '/tmp/agentistics-test-data-abc', isolated: true })
    expect(resolveDataDir({ env: { NODE_ENV: 'test', AGENTISTICS_DIR: '' }, home: HOME, ownerHome: HOME, makeTemp: temp }).isolated).toBe(true)
  })

  it('under test an explicit isolated AGENTISTICS_DIR is honoured', () => {
    expect(resolveDataDir({ env: { NODE_ENV: 'test', AGENTISTICS_DIR: '/tmp/x' }, home: HOME, ownerHome: HOME, makeTemp: temp }))
      .toEqual({ dir: '/tmp/x', isolated: false })
  })

  it('under test an AGENTISTICS_DIR pointing at the REAL store is refused, however it is spelled', () => {
    for (const dir of [join(HOME, '.agentistics'), `${HOME}/.agentistics/`, `${HOME}/x/../.agentistics`]) {
      expect(() => resolveDataDir({ env: { NODE_ENV: 'test', AGENTISTICS_DIR: dir }, home: HOME, ownerHome: HOME, makeTemp: temp }))
        .toThrow(/refusing to run tests against the real data dir/)
    }
  })
})

it('a sandbox HOME is not the owner\'s store: its .agentistics is allowed under test', () => {
  expect(resolveDataDir({ env: { NODE_ENV: 'test', AGENTISTICS_DIR: '/tmp/sb/.agentistics' }, home: '/tmp/sb', ownerHome: HOME, makeTemp: temp }))
    .toEqual({ dir: '/tmp/sb/.agentistics', isolated: false })
})

describe('this test process', () => {
  // The regression itself: a test that forgets to inject a notifier must still land somewhere
  // that is not the owner's bell.
  it('never resolves the data dir — or the notification store — to the real ~/.agentistics', () => {
    const real = resolve(join(userInfo().homedir, '.agentistics'))
    expect(resolve(AGENTISTICS_DATA_DIR)).not.toBe(resolve(join(HOME_DIR, '.agentistics')))
    expect(resolve(AGENTISTICS_DATA_DIR)).not.toBe(real)
    expect(resolve(NOTIFICATIONS_FILE).startsWith(real + '/')).toBe(false)
    expect(process.env.AGENTISTICS_DIR).toBe(AGENTISTICS_DATA_DIR)
  })
})
