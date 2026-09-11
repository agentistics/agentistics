import { describe, expect, test } from 'bun:test'
import { upgradeArrived, clearAppCaches, UPGRADE_WAIT_MS } from './appReload'

describe('when has the machine come back on the new version', () => {
  test('the version it reports IS the one we asked for', () => {
    expect(upgradeArrived({ current: '2.30.0' }, '2.30.0')).toBe(true)
  })

  test('a `v` prefix on either side is the same version', () => {
    expect(upgradeArrived({ current: 'v2.30.0' }, '2.30.0')).toBe(true)
    expect(upgradeArrived({ current: '2.30.0' }, 'v2.30.0')).toBe(true)
  })

  // The server is restarted mid-upgrade, so a poll that cannot reach it is the ORDINARY case and
  // must never be read as "done" — reloading then would put the OLD bundle back on screen.
  test('a poll that answered nothing is not an arrival', () => {
    expect(upgradeArrived(null, '2.30.0')).toBe(false)
    expect(upgradeArrived({ current: '' }, '2.30.0')).toBe(false)
  })

  test('the version still on the old number is not an arrival', () => {
    expect(upgradeArrived({ current: '2.29.0' }, '2.30.0')).toBe(false)
  })

  // A machine that jumped PAST the version we asked for still arrived: another upgrade could have
  // landed in between, and refusing to reload would strand the reader on an older bundle.
  test('a version newer than the one asked for counts as arrived', () => {
    expect(upgradeArrived({ current: '2.31.0' }, '2.30.0')).toBe(true)
  })

  test('the wait has a ceiling, so a failed upgrade stops spinning', () => {
    expect(UPGRADE_WAIT_MS).toBeGreaterThan(60_000)
    expect(UPGRADE_WAIT_MS).toBeLessThanOrEqual(10 * 60_000)
  })
})

describe('the hard reload, done by the page', () => {
  const spy = () => {
    const calls: string[] = []
    return {
      calls,
      caches: {
        keys: async () => ['assets-v1', 'html-v1'],
        delete: async (k: string) => { calls.push(`cache:${k}`); return true },
      },
      sw: {
        getRegistrations: async () => [
          { unregister: async () => { calls.push('sw:a'); return true } },
          { unregister: async () => { calls.push('sw:b'); return true } },
        ],
      },
    }
  }

  // `location.reload()` alone hands the reader the SERVICE WORKER's copy of the old bundle — the
  // reason a person has had to press ctrl+shift+R after every release. Unregistering and emptying
  // the caches first is what the keystroke actually does.
  test('unregisters every worker and empties every cache', async () => {
    const s = spy()
    await clearAppCaches({ caches: s.caches, serviceWorker: s.sw })
    expect(s.calls.sort()).toEqual(['cache:assets-v1', 'cache:html-v1', 'sw:a', 'sw:b'].sort())
  })

  // A browser with no service worker, a private window, an accessor that throws: none of them may
  // stop the reload that follows.
  test('a browser that offers neither is not an error', async () => {
    await expect(clearAppCaches({})).resolves.toBeUndefined()
  })

  test('an accessor that throws is swallowed, because the reload still has to happen', async () => {
    const hostile = {
      caches: { keys: async () => { throw new Error('blocked') }, delete: async () => true },
      serviceWorker: { getRegistrations: async () => { throw new Error('blocked') } },
    }
    await expect(clearAppCaches(hostile)).resolves.toBeUndefined()
  })
})
