import { describe, test, expect } from 'bun:test'
import {
  BACKUP, DASHBOARD, EVERYWHERE, KEYMAP, LOGS, OUTPUT, READING, SERVICES, SESSIONS,
  helpLines, helpSections, keyProbes, pressName, type KeySection,
} from './keymap'
import {
  isQuitChord, resolveLogsKey, resolveOutputKey, resolveScrollKey, resolveServicesKey, resolveShellKey,
  PANE_ORDER, type KeyPress, type PaneId,
} from './nav'
import { resolveSessionsKey, sessionKeyHelp } from './sessions'
import { resolveBackupKey, resolveHistoryKey, resolveLayerEditorKey, type BackupFocus } from './backup'
import { resolveDashboardKey } from '../dashboard/view'
import { controlStrings } from './i18n'
import { TAB_ORDER } from './types'

/**
 * GL-04: the help overlay's table IS the key map.
 *
 * Each section is held to the screen's own PURE resolver in both directions:
 *  - every key the table lists is answered by that resolver in at least one state, so the help can
 *    never advertise a key that does nothing;
 *  - every key the resolver answers, over every state below and over a universe of presses, is in
 *    the table, so a binding added to a screen without a line in the help fails here.
 */

/** Everything a person can press that any screen could plausibly bind. */
function universe(): KeyPress[] {
  const out: KeyPress[] = []
  for (let c = 0x20; c <= 0x7e; c++) out.push({ input: String.fromCharCode(c) })
  for (let c = 0x61; c <= 0x7a; c++) out.push({ input: String.fromCharCode(c), ctrl: true })
  out.push(
    { input: '', upArrow: true }, { input: '', downArrow: true },
    { input: '', leftArrow: true }, { input: '', rightArrow: true },
    { input: '', return: true }, { input: '', escape: true },
    { input: '', tab: true }, { input: '', tab: true, shift: true },
    { input: '', pageUp: true }, { input: '', pageDown: true },
    { input: '', home: true }, { input: '', end: true },
  )
  return out
}

/** A resolver over every state worth asking in: `true` when SOME state answers the press. */
type Answers = (k: KeyPress) => boolean

function holds(section: KeySection, answers: Answers) {
  const listed = new Set(section.entries.flatMap(e => keyProbes(e.keys)).map(pressName))
  // Direction 1: nothing listed is inert.
  const inert = section.entries.flatMap(e => keyProbes(e.keys)).filter(k => !answers(k)).map(pressName)
  expect({ section: section.id, inert }).toEqual({ section: section.id, inert: [] })
  // Direction 2: nothing answered is unlisted.
  const unlisted = universe().filter(k => answers(k) && !listed.has(pressName(k))).map(pressName)
  expect({ section: section.id, unlisted }).toEqual({ section: section.id, unlisted: [] })
}

const bools = [false, true] as const

describe('the help overlay\'s key table matches the bindings (GL-04)', () => {
  test('EVERYWHERE — the shell', () => {
    holds(EVERYWHERE, k => isQuitChord(k) || TAB_ORDER.some(tab =>
      bools.some(arrows => resolveShellKey(k, { tab, arrows, mouse: true }) !== null)))
  })

  test('SERVICES — the cockpit, in every pane, wide and narrow, with and without verbs', () => {
    const focuses: PaneId[] = ['services', 'config', 'actions']
    holds(SERVICES, k => focuses.some(focus => bools.some(narrow => bools.some(hasActions =>
      resolveServicesKey(k, { focus, panes: PANE_ORDER, narrow, hasActions }) !== null))))
  })

  test('A RUNNING TASK — the output pane (services and backup)', () => {
    holds(OUTPUT, k => bools.some(follow => resolveOutputKey(k, { index: 25, follow }, 50, 10) !== null))
  })

  test('SESSIONS — list, menu, verb row, grid and the narrow detail pane', () => {
    const states: Parameters<typeof resolveSessionsKey>[1][] = []
    for (const focus of ['list', 'aside'] as const) {
      for (const aside of bools) for (const actionsFocused of bools) for (const grid of bools) {
        for (const detailPane of bools) states.push({ focus, aside, actionsFocused, grid, detailPane })
      }
    }
    holds(SESSIONS, k => states.some(st => resolveSessionsKey(k, st) !== null))
  })

  test('BACKUP — the cockpit, the layers editor and the history', () => {
    const focuses: BackupFocus[] = ['harnesses', 'config', 'detail']
    holds(BACKUP, k =>
      focuses.some(focus => bools.some(narrow => resolveBackupKey(k, { focus, narrow }) !== null))
      || resolveLayerEditorKey(k) !== null
      || resolveHistoryKey(k) !== null)
  })

  test('DASHBOARD — the screens, the pager and the harness filter', () => {
    holds(DASHBOARD, k => bools.some(open => resolveDashboardKey(k, { open, screen: 'overview' }) !== null))
  })

  test('LOGS — the sources and the tail', () => {
    holds(LOGS, k => bools.some(follow =>
      resolveLogsKey(k, { sources: 9, state: { index: 25, follow }, length: 50, page: 10 }) !== null))
  })

  test('HELP · CHEAT SHEET · CONTRIBUTE — the document keys', () => {
    // The shell scrolls a document only on a plain key — see `ControlCenter`'s static branch.
    holds(READING, k => !k.ctrl && resolveScrollKey(k, 25, 50, 10) !== null)
  })

  test('every key the sessions screen\'s own reference names is in the overlay too', () => {
    const w = controlStrings('en').sessionsKeyWhat
    const overlay = new Set([...SESSIONS.entries, ...EVERYWHERE.entries].flatMap(e => keyProbes(e.keys)).map(pressName))
    const missing = sessionKeyHelp(w).flatMap(r => keyProbes(r.keys)).map(pressName).filter(n => !overlay.has(n))
    expect(missing).toEqual([])
  })

  test('`?` belongs to the shell now — the sessions screen no longer answers it itself', () => {
    expect(resolveSessionsKey({ input: '?' }, { focus: 'list', aside: true, actionsFocused: false, grid: false })).toBeNull()
    expect(resolveShellKey({ input: '?' }, { tab: 'sessions', arrows: false, mouse: false })).toEqual({ kind: 'help' })
  })

  test('a `ctrl` chord the screen does not bind does not fall through to the plain letter', () => {
    // `ctrl+n` used to reach `input === 'n'` and start a session.
    expect(resolveSessionsKey({ input: 'n', ctrl: true }, { focus: 'list', aside: true, actionsFocused: false, grid: false })).toBeNull()
    expect(resolveShellKey({ input: 'r', ctrl: true }, { tab: 'sessions', arrows: true, mouse: true })).toBeNull()
  })

  test('the log sources are no longer on `[`/`]`, which the shell answers for the tabs', () => {
    for (const input of ['[', ']']) {
      expect(resolveLogsKey({ input }, { sources: 3, state: { index: 0, follow: true }, length: 10, page: 5 })).toBeNull()
    }
  })
})

describe('the help overlay\'s lines', () => {
  test('every key cell parses — a cell the test cannot probe fails the build', () => {
    for (const sec of KEYMAP) {
      if (sec.id === 'code') continue // the code tab's own table, tested against codeKeyIntent there
      for (const e of sec.entries) expect(keyProbes(e.keys).length).toBeGreaterThan(0)
    }
  })

  test('the screen you are on comes right after EVERYWHERE, and no section is left out', () => {
    for (const tab of TAB_ORDER) {
      const order = helpSections(tab)
      expect(order[0]!.id).toBe('everywhere')
      expect(order).toHaveLength(KEYMAP.length)
      const mine = KEYMAP.filter(s => s.id !== 'everywhere' && s.tabs.includes(tab)).map(s => s.id)
      expect(order.slice(1, 1 + mine.length).map(s => s.id)).toEqual(mine)
    }
  })

  test('no line is wider than the pane it is drawn in, in either language', () => {
    for (const lang of ['en', 'pt'] as const) {
      for (const width of [30, 46, 76, 96, 104, 140]) {
        const lines = helpLines(lang, 'sessions', width)
        expect(lines.length).toBeGreaterThan(0)
        for (const line of lines) {
          if (line.kind !== 'entry' || !line.text) continue
          // keys column + two spaces + the wrapped text
          expect(line.text.length).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test('both languages carry every entry', () => {
    for (const sec of KEYMAP) {
      expect(sec.title.en.length).toBeGreaterThan(0)
      expect(sec.title.pt.length).toBeGreaterThan(0)
      for (const e of sec.entries) {
        expect(e.action.en.length).toBeGreaterThan(0)
        expect(e.action.pt.length).toBeGreaterThan(0)
      }
    }
  })
})
