import { describe, expect, test } from 'bun:test'
import {
  TERMINAL_PLACEMENTS, consentMode, dedicatedTerminalPath, dockedAllowed, keyStripShown,
  readTerminalPane, type TerminalPlacement,
} from './terminalSurface'

describe('consent follows the SURFACE, never the session', () => {
  test('a terminal you went to takes keys on FOCUS', () => {
    // The workspace placements are all deliberate: you clicked a tab, expanded a band, or opened
    // the dedicated screen. The VS Code extension already decided this — "FOCUS is the consent
    // gate (every terminal works that way)" — and the web kept an arm button, so one product held
    // two answers to one question.
    expect(consentMode('replacing')).toBe('focus')
    expect(consentMode('docked')).toBe('focus')
    expect(consentMode('dedicated')).toBe('focus')
    // The session's own pane, opened in the panel-slots' right slot — the same rule as `replacing`.
    expect(consentMode('aside')).toBe('focus')
  })

  test('a terminal merely PRESENT keeps the button', () => {
    // The dashboard's session list renders a terminal inside a card you are scrolling past. Nobody
    // went there to type, so a stray keystroke would land in a live assistant's dialog.
    expect(consentMode('card')).toBe('button')
  })

  test('every placement answers, and the set is closed', () => {
    for (const p of TERMINAL_PLACEMENTS) expect(['focus', 'button']).toContain(consentMode(p))
    expect([...TERMINAL_PLACEMENTS]).toEqual(['card', 'docked', 'replacing', 'dedicated', 'aside'])
  })
})

describe('the key strip', () => {
  test('appears on mobile wherever you went to the terminal on purpose', () => {
    // A soft keyboard has no `esc`, no `tab` and no arrows at all — so without it there is no
    // leaving `vim` and no Ctrl+C. The shell band has had it since phase 2; the assistant's own
    // terminal never did.
    for (const p of ['docked', 'replacing', 'dedicated', 'aside'] as TerminalPlacement[]) {
      expect(keyStripShown(p, true)).toBe(true)
    }
  })

  test('never on desktop — the keys are already on the keyboard', () => {
    for (const p of TERMINAL_PLACEMENTS) expect(keyStripShown(p, false)).toBe(false)
  })

  test('never in a dashboard card, even on mobile', () => {
    // That terminal is read-only until armed; a row of send-a-key buttons over it would be five
    // controls that do nothing.
    expect(keyStripShown('card', true)).toBe(false)
  })
})

describe('there is no docked placement on a phone', () => {
  test('below the breakpoint the band cannot exist', () => {
    // Measured in the phase-2 spec: at 390px with the keyboard open there are ~250px of visible
    // height; split between conversation, composer and terminal that is ~80px each — four lines.
    expect(dockedAllowed(true)).toBe(false)
  })

  test('on desktop it can', () => {
    expect(dockedAllowed(false)).toBe(true)
  })
})

describe('the dedicated terminal is a PLACE, not a mode', () => {
  test('its path carries the session and the pane it is showing', () => {
    // A route rather than a piece of component state: it survives a reload, it is a link somebody
    // can send, and the router already gives a phone a back gesture for it. The TARGET goes in the
    // URL or a shared link opens on the wrong pane.
    expect(dedicatedTerminalPath('abc')).toBe('/sessions/abc/terminal')
    expect(dedicatedTerminalPath('abc', 'shell')).toBe('/sessions/abc/terminal?pane=shell')
  })

  test('the id is encoded, so it can never smuggle a second segment', () => {
    expect(dedicatedTerminalPath('a/b')).toBe('/sessions/a%2Fb/terminal')
  })

  test('the assistant is the default and is left out of the URL', () => {
    // A bare `/sessions/x/terminal` has to mean something, and the assistant's own pane is what the
    // Terminal tab has always shown — so a link written by hand lands where a reader expects.
    expect(dedicatedTerminalPath('abc', 'assistant')).toBe('/sessions/abc/terminal')
    expect(readTerminalPane(null)).toBe('assistant')
    expect(readTerminalPane('assistant')).toBe('assistant')
  })

  test('a pane nobody offers reads as the assistant rather than as nothing', () => {
    // The value comes off a query string a person can type. An unknown one must not blank the
    // screen — it lands on the pane the bare path already means.
    expect(readTerminalPane('shell')).toBe('shell')
    expect(readTerminalPane('banana')).toBe('assistant')
    expect(readTerminalPane('')).toBe('assistant')
  })
})
