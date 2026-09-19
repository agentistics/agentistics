import { describe, expect, test } from 'bun:test'
import { planSessionDirectory } from './editor-directory'

describe('planSessionDirectory', () => {
  test('a live row wins over the store', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: '/live', storeDir: '/store', dirExists: true,
    })
    expect(r).toEqual({ ok: true, dir: '/live' })
  })
  test('falls back to the store when there is no live row', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: undefined, storeDir: '/store', dirExists: true,
    })
    expect(r).toEqual({ ok: true, dir: '/store' })
  })
  test('a session nobody has ever heard of is unknown-session, not no-cwd', () => {
    const r = planSessionDirectory({
      sessionKnown: false, liveCwd: undefined, storeDir: undefined, dirExists: false,
    })
    expect(r).toEqual({ ok: false, reason: 'unknown-session' })
  })
  test('a known session with no recorded directory anywhere is no-cwd', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: undefined, storeDir: undefined, dirExists: false,
    })
    expect(r).toEqual({ ok: false, reason: 'no-cwd' })
  })
  test('a recorded directory that no longer exists on disk is cwd-missing', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: '/gone', storeDir: undefined, dirExists: false,
    })
    expect(r).toEqual({ ok: false, reason: 'cwd-missing' })
  })
})
