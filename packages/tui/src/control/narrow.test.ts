import { describe, test, expect } from 'bun:test'
import { nextSessionsPane, sessionsCockpit, SESSIONS_PANES, resolveSessionsKey } from './sessions'
import { backupHints, resolveBackupKey } from './backup'
import { resolveServicesKey, PANE_ORDER } from './nav'
import { controlStrings } from './i18n'

/**
 * GL-07 / D-TUI-10 — below 100 columns the cockpits show ONE pane at a time. The layout arithmetic
 * and the keys that walk between panes are pure, and pinned here; `frames.test.ts` renders them.
 */

describe('the narrow sessions cockpit', () => {
  test('draws exactly one pane, at the full width, under a one-row strip', () => {
    for (const single of SESSIONS_PANES) {
      for (let height = 2; height <= 40; height++) {
        const c = sessionsCockpit({ width: 78, height, asideLabel: 20, detailWanted: 6, single })
        expect(c.single).toBe(single)
        expect(c.strip).toBe(1)
        // Only the shown pane takes rows: the menu and the list share the band, the detail its own.
        const band = single === 'detail' ? 0 : height - 1
        expect(c.band).toBe(band)
        expect(c.detail).toBe(single === 'detail' ? height - 1 : 0)
        expect(c.aside).toBe(single === 'menu' ? 78 : 0)
        expect(c.list).toBe(78)
        expect((c.strip ?? 0) + c.band + c.detail).toBe(height)
      }
    }
  })

  test('`tab` walks menu → sessions → detail and wraps; `shift+tab` walks it back', () => {
    expect(nextSessionsPane('menu')).toBe('sessions')
    expect(nextSessionsPane('sessions')).toBe('detail')
    expect(nextSessionsPane('detail')).toBe('menu')
    expect(nextSessionsPane('menu', true)).toBe('detail')
  })

  test('`esc` on the narrow detail pane walks back — it has no other meaning there', () => {
    const ctx = { focus: 'list' as const, aside: false, actionsFocused: false, grid: false }
    expect(resolveSessionsKey({ input: '', escape: true }, { ...ctx, detailPane: true })).toEqual({ kind: 'paneBack' })
    // …while on the list itself esc keeps its job: dropping the search, the project, the task.
    expect(resolveSessionsKey({ input: '', escape: true }, ctx)).toEqual({ kind: 'esc' })
  })
})

describe('the narrow services cockpit', () => {
  test('`esc` on the config pane walks back to the services list only when narrow', () => {
    const base = { focus: 'config' as const, panes: PANE_ORDER, hasActions: true }
    expect(resolveServicesKey({ input: '', escape: true }, { ...base, narrow: true })).toEqual({ kind: 'focus', pane: 'services' })
    expect(resolveServicesKey({ input: '', escape: true }, { ...base, narrow: false })).toBeNull()
  })

  test('`tab` reaches the detail pane even for a service with no verbs', () => {
    const next = resolveServicesKey({ input: '', tab: true }, { focus: 'config', panes: PANE_ORDER, narrow: true, hasActions: false })
    expect(next).toEqual({ kind: 'focus', pane: 'actions' })
    // …and there `enter` and the arrows are inert rather than running a verb that is not there.
    const verbless = { focus: 'actions' as const, panes: PANE_ORDER, narrow: true, hasActions: false }
    expect(resolveServicesKey({ input: '', return: true }, verbless)).toBeNull()
    expect(resolveServicesKey({ input: '', leftArrow: true }, verbless)).toBeNull()
  })
})

describe('the narrow backup cockpit', () => {
  test('`tab` walks three panes when narrow and two when wide', () => {
    expect(resolveBackupKey({ input: '', tab: true }, { focus: 'config', narrow: true })).toEqual({ kind: 'focus', focus: 'detail' })
    expect(resolveBackupKey({ input: '', tab: true }, { focus: 'config', narrow: false })).toEqual({ kind: 'focus', focus: 'harnesses' })
    expect(resolveBackupKey({ input: '', tab: true, shift: true }, { focus: 'harnesses', narrow: true })).toEqual({ kind: 'focus', focus: 'detail' })
  })

  test('the detail pane is read-only: its footer names no move or toggle key', () => {
    const s = controlStrings('en')
    const hints = backupHints('detail', s, { task: false, narrow: true })
    expect(hints).toContain(s.keyBack)
    expect(hints).not.toContain(s.keyMove)
    expect(hints).not.toContain(s.keyBackupToggle)
    expect(resolveBackupKey({ input: 'j' }, { focus: 'detail', narrow: true })).toBeNull()
  })
})
