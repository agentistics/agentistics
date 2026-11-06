import { afterEach, describe, expect, test } from 'bun:test'
import { catalogCliPath, modelCatalog, peekModelCatalog, resetModelCatalogForTests, setModelReaderForTests } from './model-catalog'

afterEach(() => resetModelCatalogForTests())

const opt = (id: string) => ({ id, label: id, verifiedAt: '2026-11-06', source: 't' })

describe('catalogCliPath', () => {
  test('a LaunchAgent PATH still reaches Homebrew and /usr/local — where opencode lives on a Mac', () => {
    const path = catalogCliPath('/usr/bin:/bin:/usr/sbin:/sbin', '/Users/dono').split(':')
    expect(path).toContain('/opt/homebrew/bin')
    expect(path).toContain('/usr/local/bin')
    // the process's own PATH still decides which binary wins
    expect(path.indexOf('/usr/bin')).toBeLessThan(path.indexOf('/opt/homebrew/bin'))
  })
})

describe('a failed command read is not remembered as "no models"', () => {
  test('first read fails → table answer; a later read succeeds → the CLI list (after the backoff)', async () => {
    let t = 1_000_000
    let calls = 0
    setModelReaderForTests('opencode', async () => (++calls === 1 ? null : [opt('upx/fable-5.1'), opt('opencode/big-pickle')]), () => t)
    peekModelCatalog('opencode')
    await Bun.sleep(5)
    expect(calls).toBe(1)
    expect(peekModelCatalog('opencode').source).toBe('table')
    expect(calls).toBe(1) // not retried inside the backoff
    t += 31_000
    peekModelCatalog('opencode') // due again → refresh in the background
    await Bun.sleep(5)
    const got = await modelCatalog('opencode')
    expect(calls).toBe(2)
    expect(got.source).toBe('cli')
    expect(got.models.map(m => m.id)).toEqual(['upx/fable-5.1', 'opencode/big-pickle'])
    expect(got.freeText).toBe(false)
  })

  test('when the CLI never answers, the models the config declares are offered (and a typed id stays accepted)', async () => {
    setModelReaderForTests('opencode', async () => null, () => 1, async () => [opt('upx/fable-5.1'), opt('upx/opus-5')])
    peekModelCatalog('opencode')
    await Bun.sleep(5)
    const got = peekModelCatalog('opencode')
    expect(got.models.map(m => m.id)).toEqual(['upx/fable-5.1', 'upx/opus-5'])
    expect(got.source).toBe('table')
    expect(got.freeText).toBe(true)
  })

  test('a later failure keeps the last good CLI list', async () => {
    let t = 1
    let ok = true
    setModelReaderForTests('opencode', async () => (ok ? [opt('a/b')] : null), () => t)
    await modelCatalog('opencode'); await Bun.sleep(5)
    expect(peekModelCatalog('opencode').models.map(m => m.id)).toEqual(['a/b'])
    ok = false; t += 7 * 60 * 60_000
    peekModelCatalog('opencode'); await Bun.sleep(5)
    expect(peekModelCatalog('opencode').models.map(m => m.id)).toEqual(['a/b'])
  })
})
