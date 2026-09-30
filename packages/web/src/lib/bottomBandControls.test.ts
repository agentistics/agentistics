import { describe, expect, test } from 'bun:test'
import { panelBarEntries, resolvePanelBarPick, type PanelBarGates } from './panelBar'
import {
  minimizeIn, minimizedPanels, parseBook, restoreIn, stackOrder, writeEntry, type FloatingSet,
} from './floatingPanels'
import {
  closeEndsShell, closeFlowVisible, closeOutcome, CLOSE_RESULT_MS, panelClosable, shellCloseText,
} from './shellClose'

const OPEN: PanelBarGates = { editorEnabled: true, shellEnabled: true, relayed: false, hardwareOffered: true }

describe('minimize a floating window', () => {
  const set: FloatingSet = {
    shell: { x: 10, y: 20, w: 400, h: 300, z: 1 },
    studio: { x: 50, y: 60, w: 500, h: 350, z: 2 },
  }

  test('keeps the rect and hides the window from the stack', () => {
    const next = minimizeIn(set, 'shell')
    expect(next.shell).toEqual({ x: 10, y: 20, w: 400, h: 300, z: 1, min: true })
    expect(stackOrder(next)).toEqual(['studio'])
    expect(minimizedPanels(next)).toEqual(['shell'])
  })

  test('restore puts it back exactly where it was, on top', () => {
    const back = restoreIn(minimizeIn(set, 'shell'), 'shell')
    expect(back.shell).toEqual({ x: 10, y: 20, w: 400, h: 300, z: 3 })
    expect(stackOrder(back)).toEqual(['studio', 'shell'])
  })

  test('no-ops: minimizing twice, or a panel that does not float', () => {
    const once = minimizeIn(set, 'shell')
    expect(minimizeIn(once, 'shell')).toBe(once)
    expect(minimizeIn(set, 'cli')).toBe(set)
    expect(restoreIn(set, 'cli')).toBe(set)
  })

  test('the minimized flag survives storage (per viewer)', () => {
    const book = writeEntry({ v: 1, sessions: {} }, 'k', minimizeIn(set, 'shell'), 1)
    const read = parseBook(JSON.stringify(book))
    expect(read.sessions.k!.windows.shell).toEqual({ x: 10, y: 20, w: 400, h: 300, z: 1, min: true })
    expect(read.sessions.k!.windows.studio!.min).toBeUndefined()
  })
})

describe('minimized windows in the bottom bar', () => {
  test('join after the docked tabs, never lit, never twice', () => {
    expect(panelBarEntries(['cli', 'shell'], 'cli', OPEN, ['studio', 'shell'])).toEqual([
      { id: 'cli', on: true },
      { id: 'shell', on: false },
      { id: 'studio', on: false, minimized: true },
    ])
  })

  test('a closed gate hides the minimized tab too', () => {
    const gates = { ...OPEN, editorEnabled: false }
    expect(panelBarEntries(['cli'], 'cli', gates, ['studio'])).toEqual([{ id: 'cli', on: true }])
  })

  test('its tab restores the window, whatever the band is doing', () => {
    expect(resolvePanelBarPick({ id: 'shell', activeBottom: 'shell', bottomOpen: true, minimized: true }))
      .toEqual({ kind: 'restore-window' })
    expect(resolvePanelBarPick({ id: 'shell', activeBottom: 'shell', bottomOpen: true }))
      .toEqual({ kind: 'minimize' })
  })
})

describe('shell close', () => {
  test('only the Shell is closable', () => {
    expect(panelClosable('shell')).toBe(true)
    expect(panelClosable('cli')).toBe(false)
    expect(panelClosable('studio')).toBe(false)
  })

  test('reads the server answer for one id', () => {
    expect(closeOutcome('a', { ok: true, body: { closed: ['a'], unknown: [] } })).toBe('closed')
    expect(closeOutcome('a', { ok: true, body: { closed: [], unknown: ['a'] } })).toBe('gone')
    expect(closeOutcome('a', { ok: true, body: { closed: ['b'], unknown: [] } })).toBe('failed')
    expect(closeOutcome('a', { ok: false, body: null })).toBe('failed')
    expect(closeOutcome('a', null)).toBe('failed')
    expect(closeEndsShell('gone')).toBe(true)
    expect(closeEndsShell('failed')).toBe(false)
  })

  test('says every step, and the result fades', () => {
    expect(shellCloseText({ phase: 'idle' }, 'pt')).toBeNull()
    expect(shellCloseText({ phase: 'closing', id: 'a' }, 'pt')).toBe('Encerrando o processo deste terminal…')
    const done = { phase: 'done' as const, id: 'a', outcome: 'failed' as const, at: 1000 }
    expect(shellCloseText(done, 'pt')).toContain('continua rodando')
    expect(closeFlowVisible(done, 1000 + CLOSE_RESULT_MS - 1)).toBe(true)
    expect(closeFlowVisible(done, 1000 + CLOSE_RESULT_MS)).toBe(false)
  })
})
