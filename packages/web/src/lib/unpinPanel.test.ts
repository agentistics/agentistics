import { beforeEach, describe, expect, test } from 'bun:test'
import {
  floatPanel, getFloating, isFloating, minimizeFloatingPanel, minimizedPanels, resetFloating, setFloatingSession,
} from './floatingPanels'
import { unpinPanel } from './panelSlots'

describe('unpinPanel — pin → minimize → unpin round trip', () => {
  beforeEach(() => { resetFloating(); setFloatingSession('s1', 'main') })

  test('a minimized floating window is docked back by the unpin', () => {
    floatPanel('tasks', 'main')
    minimizeFloatingPanel('tasks', 'main')
    expect(minimizedPanels(getFloating('main'))).toEqual(['tasks'])
    unpinPanel('tasks', 'main')
    expect(isFloating('tasks', 'main')).toBe(false)
    expect(minimizedPanels(getFloating('main'))).toEqual([])
  })

  test('a visible floating window is docked back too, and unpinning twice is harmless', () => {
    floatPanel('tasks', 'main')
    unpinPanel('tasks', 'main')
    unpinPanel('tasks', 'main')
    expect(isFloating('tasks', 'main')).toBe(false)
  })
})
