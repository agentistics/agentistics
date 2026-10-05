import { describe, expect, test } from 'bun:test'
import { healStaleBundle, planStaleBundle, RELOADED_FOR_KEY, takeUpdatedToast, UPDATED_TOAST_KEY, updatedToastFor, type SessionStore } from './bundleVersion'

const mem = (init: Record<string, string> = {}): SessionStore & { data: Record<string, string> } => {
  const data = { ...init }
  return { data, getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v }, removeItem: k => { delete data[k] } }
}

describe('planStaleBundle — a bundle the server is not running reloads once', () => {
  test('same version (with or without v) → current', () => {
    expect(planStaleBundle({ bundle: '2.103.1', server: 'v2.103.1', reloadedFor: null, dev: false })).toEqual({ kind: 'current' })
  })
  test('the 2026-10-04 shape: an old precached bundle on a new server → reload onto the server', () => {
    expect(planStaleBundle({ bundle: '2.101.2', server: '2.103.1', reloadedFor: null, dev: false })).toEqual({ kind: 'reload', server: '2.103.1' })
  })
  test('already reloaded for this version and still stale → gave up, never a loop', () => {
    expect(planStaleBundle({ bundle: '2.101.2', server: '2.103.1', reloadedFor: '2.103.1', dev: false })).toEqual({ kind: 'gave-up', server: '2.103.1' })
  })
  test('a reload for an OLDER server version does not block the next one', () => {
    expect(planStaleBundle({ bundle: '2.101.2', server: '2.104.0', reloadedFor: '2.103.1', dev: false }).kind).toBe('reload')
  })
  test('dev, or nothing to compare → current (never reload a Vite dev page)', () => {
    expect(planStaleBundle({ bundle: '2.101.2', server: '2.103.1', reloadedFor: null, dev: true }).kind).toBe('current')
    expect(planStaleBundle({ bundle: '', server: '2.103.1', reloadedFor: null, dev: false }).kind).toBe('current')
    expect(planStaleBundle({ bundle: '2.101.2', server: undefined, reloadedFor: null, dev: false }).kind).toBe('current')
  })
})

describe('the toast after the reload', () => {
  test('shown only when the RUNNING bundle is the one the reload was for', () => {
    expect(updatedToastFor({ bundle: '2.103.1', pending: '2.103.1' })).toBe('2.103.1')
    expect(updatedToastFor({ bundle: '2.101.2', pending: '2.103.1' })).toBeNull()
    expect(updatedToastFor({ bundle: '2.103.1', pending: null })).toBeNull()
  })
  test('takeUpdatedToast reads nothing when the build carries no version (tests, dev)', () => {
    const s = mem({ [UPDATED_TOAST_KEY]: '2.103.1' })
    expect(takeUpdatedToast(s)).toBeNull()
  })
})

describe('healStaleBundle (faked IO)', () => {
  test('without a build version it never reloads — nothing to compare', async () => {
    let reloads = 0
    const v = await healStaleBundle('2.103.1', { dev: false, reload: () => { reloads++ }, clear: async () => {}, storage: mem() })
    expect(v.kind).toBe('current')
    expect(reloads).toBe(0)
  })
  test('stale → caches cleared BEFORE the one reload, and both markers written', async () => {
    const order: string[] = []
    const s = mem()
    const v = await healStaleBundle('2.103.1', { bundle: '2.101.2', dev: false, storage: s, clear: async () => { order.push('clear') }, reload: () => { order.push('reload') } })
    expect(v).toEqual({ kind: 'reload', server: '2.103.1' })
    expect(order).toEqual(['clear', 'reload'])
    expect(s.data[RELOADED_FOR_KEY]).toBe('2.103.1')
    expect(s.data[UPDATED_TOAST_KEY]).toBe('2.103.1')
  })
  test('the second time for the same version does nothing', async () => {
    let reloads = 0
    const s = mem({ [RELOADED_FOR_KEY]: '2.103.1' })
    const v = await healStaleBundle('2.103.1', { bundle: '2.101.2', dev: false, storage: s, clear: async () => {}, reload: () => { reloads++ } })
    expect(v.kind).toBe('gave-up')
    expect(reloads).toBe(0)
  })
})
