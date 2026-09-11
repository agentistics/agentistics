import { describe, expect, test } from 'bun:test'
import { PANE_COLS, PANE_ROWS } from './tmux-cli'
import { readWantedGeometry, resizePlan } from './pane-resize'

describe('a SHELL pane follows the box it is drawn in', () => {
  test('it takes the geometry asked for', () => {
    // Nothing in the product reads a shell's screen, so there is no floor to protect.
    expect(resizePlan({ scope: 'shell', want: { cols: 200, rows: 60 }, current: { cols: 120, rows: 50 } }))
      .toEqual({ cols: 200, rows: 60 })
  })

  test('and it may shrink', () => {
    expect(resizePlan({ scope: 'shell', want: { cols: 60, rows: 20 }, current: { cols: 120, rows: 50 } }))
      .toEqual({ cols: 60, rows: 20 })
  })
})

describe('an ASSISTANT pane may GROW and never shrink past the floor', () => {
  test('growing is allowed', () => {
    expect(resizePlan({ scope: 'fleet', want: { cols: 220, rows: 80 }, current: { cols: 120, rows: 50 } }))
      .toEqual({ cols: 220, rows: 80 })
  })

  test('a phone asking for 40x20 is CLAMPED, not obeyed', () => {
    // `PANE_COLS`/`PANE_ROWS` exist because a 24-row pane cut the top off an `AskUserQuestion` and
    // broke `readDialog`/`approvalTail` — invisible from an attached terminal, because attaching
    // resizes. Letting a phone shrink this pane would degrade approval detection in the cockpit,
    // the VS Code panel and the web at once, for every other viewer of the same session.
    expect(resizePlan({ scope: 'fleet', want: { cols: 40, rows: 20 }, current: { cols: 120, rows: 50 } }))
      .toBeNull()
  })

  test('one dimension may grow while the other is held at the floor', () => {
    expect(resizePlan({ scope: 'fleet', want: { cols: 300, rows: 10 }, current: { cols: 120, rows: 50 } }))
      .toEqual({ cols: 300, rows: PANE_ROWS })
  })
})

describe('a resize that changes nothing is not a resize', () => {
  test('the same geometry costs no tmux call', () => {
    // The client measures on every layout change, so an unguarded plan would spawn a process per
    // animation frame while somebody drags a divider.
    expect(resizePlan({ scope: 'shell', want: { cols: 120, rows: 50 }, current: { cols: 120, rows: 50 } }))
      .toBeNull()
    expect(resizePlan({ scope: 'fleet', want: { cols: PANE_COLS, rows: PANE_ROWS }, current: { cols: PANE_COLS, rows: PANE_ROWS } }))
      .toBeNull()
  })
})

describe('a geometry that is not one is refused rather than resolved', () => {
  test('zero, negative and absurd values yield no plan', () => {
    // The numbers come off a browser measuring a box that can be mid-layout, display:none, or
    // zero-height for a frame. A `resize-window -x 0` is a pane nobody can read.
    for (const want of [{ cols: 0, rows: 50 }, { cols: 120, rows: 0 }, { cols: -5, rows: 50 }, { cols: 5000, rows: 50 }]) {
      expect(resizePlan({ scope: 'shell', want, current: { cols: 120, rows: 50 } })).toBeNull()
    }
  })
})

describe('the geometry a stream may be OPENED with', () => {
  const q = (s: string) => readWantedGeometry(new URLSearchParams(s))

  test('a pair of positive whole numbers is read', () => {
    expect(q('id=s1&cols=144&rows=13')).toEqual({ cols: 144, rows: 13 })
  })

  test('saying nothing is not an error — it is the ordinary case', () => {
    expect(q('id=s1')).toBeNull()
    expect(q('id=s1&cols=144')).toBeNull()
    expect(q('id=s1&rows=13')).toBeNull()
  })

  // A query string is untrusted input and this one arrives BEFORE the stream exists, so a value it
  // cannot read must cost the caller the resize and never the stream.
  test('anything that is not a pair of positive whole numbers is refused, never clamped', () => {
    for (const s of [
      'cols=0&rows=13', 'cols=144&rows=0', 'cols=-5&rows=13', 'cols=1.5&rows=13',
      'cols=abc&rows=13', 'cols=144&rows=NaN', 'cols=&rows=13', 'cols=1e400&rows=13',
    ]) {
      expect(q(s), s).toBeNull()
    }
  })

  test('a geometry past the ceiling is refused here too, so the plan is never asked a silly question', () => {
    expect(q('cols=100000&rows=13')).toBeNull()
    expect(q('cols=144&rows=100000')).toBeNull()
  })
})
