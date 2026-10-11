import { describe, expect, test } from 'bun:test'
import { journalLoadingNotification, startupLoadingNotification } from './loadingNotifications'

describe('loading notification mapping', () => {
  test('maps startup progress in both languages', () => {
    const state = { partial: true, partialReason: 'quick' as const, projects: 0.42 }
    expect(startupLoadingNotification(state, 'en')?.message).toContain('42%')
    expect(startupLoadingNotification(state, 'pt')?.message).toContain('carregando')
  })

  test('keeps one stable identity while progress changes', () => {
    const a = journalLoadingNotification({ state: 'running', written: 1, harness: 'codex', done: 1, total: 2 }, 'en')!
    const b = journalLoadingNotification({ state: 'running', written: 2, harness: 'codex', done: 2, total: 2 }, 'en')!
    expect(a.meta.notificationKey).toBe('loading.journal')
    expect(b.meta.notificationKey).toBe(a.meta.notificationKey)
    expect(b.message).not.toBe(a.message)
  })

  test('maps completion and failure action state', () => {
    expect(journalLoadingNotification({ state: 'done', written: 2, harness: null, done: null, total: null }, 'pt')?.type).toBe('success')
    expect(journalLoadingNotification({ state: 'failed', written: 2, harness: null, done: null, total: null }, 'en')?.meta.state).toBe('failed')
  })
})
