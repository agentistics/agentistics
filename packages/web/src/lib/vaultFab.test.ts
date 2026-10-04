import { describe, expect, test } from 'bun:test'
import { VAULT_FAB_INITIAL, closeVaultPanel, isContextMenuKey, vaultFabMotion, vaultFabReduce, vaultIconMounted, type VaultFabEvent, type VaultFabState } from './vaultFab'

const run = (...events: VaultFabEvent['type'][]): VaultFabState =>
  events.reduce<VaultFabState>((s, type) => vaultFabReduce(s, { type } as VaultFabEvent), VAULT_FAB_INITIAL)

describe('the vault icon over the chat button — open/close', () => {
  test('starts hidden and unmounted', () => {
    expect(VAULT_FAB_INITIAL).toEqual({ phase: 'hidden', panel: false })
    expect(vaultIconMounted(VAULT_FAB_INITIAL)).toBe(false)
  })
  test('a summon shows it; a second summon changes nothing', () => {
    expect(run('summon')).toEqual({ phase: 'shown', panel: false })
    expect(run('summon', 'summon')).toEqual({ phase: 'shown', panel: false })
  })
  test('an outside click / Escape sends it LEAVING (still mounted, animating out), then hidden once settled', () => {
    const leaving = run('summon', 'dismiss')
    expect(leaving.phase).toBe('leaving')
    expect(vaultIconMounted(leaving)).toBe(true)
    expect(run('summon', 'dismiss', 'settled')).toEqual({ phase: 'hidden', panel: false })
  })
  test('a dismiss while hidden is a no-op; settled only ends a leave', () => {
    expect(run('dismiss')).toEqual(VAULT_FAB_INITIAL)
    expect(run('settled')).toEqual(VAULT_FAB_INITIAL)
    expect(run('summon', 'settled').phase).toBe('shown')
  })
  test('summoning during the leave brings it straight back', () => {
    expect(run('summon', 'dismiss', 'summon').phase).toBe('shown')
  })
  test('activating the icon opens the quick vault and the icon leaves', () => {
    expect(run('summon', 'activate')).toEqual({ phase: 'leaving', panel: true })
    expect(run('summon', 'activate', 'settled')).toEqual({ phase: 'hidden', panel: true })
  })
  test('an icon that is not there cannot be activated', () => {
    expect(run('activate')).toEqual(VAULT_FAB_INITIAL)
  })
  test('closing the panel leaves the icon alone', () => {
    const s = run('summon', 'activate', 'settled')
    expect(closeVaultPanel(s)).toEqual({ phase: 'hidden', panel: false })
    expect(closeVaultPanel(VAULT_FAB_INITIAL)).toBe(VAULT_FAB_INITIAL)
  })
})

describe('keyboard', () => {
  test('Shift+F10 and the context-menu key summon it; F10 alone and other keys do not', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
    expect(isContextMenuKey({ key: 'Enter', shiftKey: true })).toBe(false)
  })
})

describe('motion', () => {
  test('normal: a spring rise ~260 ms, a sink ~180 ms, and a ripple on the button', () => {
    const m = vaultFabMotion(false)
    expect(m.enter).toContain('ag-vault-rise 260ms')
    expect(m.enter).toContain('cubic-bezier(0.34, 1.56') // the overshoot
    expect(m.leave).toContain('ag-vault-sink 180ms')
    expect(m.leaveMs).toBe(180)
    expect(m.ripple).toContain('ag-vault-ripple')
  })
  test('prefers-reduced-motion: a plain fade both ways, no scale, no ripple', () => {
    const m = vaultFabMotion(true)
    expect(m.enter).toContain('ag-vault-fade-in')
    expect(m.leave).toContain('ag-vault-fade-out')
    expect(m.enter).not.toContain('rise')
    expect(m.ripple).toBeNull()
    expect(m.leaveMs).toBeLessThanOrEqual(180)
  })
})
