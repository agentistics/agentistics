import { describe, expect, it, test } from 'bun:test'
import {
  BAND_FULLSCREEN_OVERSHOOT_PX, BAND_MIN_PX, BAND_SNAP_THRESHOLD_PX, DEFAULT_BAND_PREFS,
  clampBandHeight, keepUsableColumnHeight, readBandPrefs, resolveBandDrag, resolveBandHeight, shellErrorText,
  wantsFullscreen, bandPanelFull, withBandPanelFull, seedBandOpen,
  bandGeometry, shellApiUrl, shellWatching, shellWhere, writeBandGeometry, writeBandPrefs, type BandPrefs,
} from './shellBand'

describe('keepUsableColumnHeight — transient hidden-window measurements', () => {
  test('keeps the last real height when Chrome reports zero while the PWA is backgrounded', () => {
    expect(keepUsableColumnHeight(900, 0)).toBe(900)
  })

  test('keeps the last real height for invalid measurements, but accepts a real positive resize', () => {
    expect(keepUsableColumnHeight(900, Number.NaN)).toBe(900)
    expect(keepUsableColumnHeight(900, 720)).toBe(720)
  })
})

describe('the unwatch discipline', () => {
  const open = { bandOpen: true, sessionSelected: true, documentVisible: true }

  it('captures only when the band is open, the session selected AND the tab visible', () => {
    expect(shellWatching(open)).toBe(true)
  })

  it('a collapsed band captures nothing', () => {
    expect(shellWatching({ ...open, bandOpen: false })).toBe(false)
  })

  it('a session that is not selected captures nothing', () => {
    expect(shellWatching({ ...open, sessionSelected: false })).toBe(false)
  })

  it('a backgrounded tab captures nothing', () => {
    // This is the only per-second cost the feature has: two tmux reads a second, per watched pane.
    // A surface that forgets to unwatch leaves a capture-pane loop running for a screen nobody sees.
    expect(shellWatching({ ...open, documentVisible: false })).toBe(false)
  })
})

describe('the band geometry', () => {
  it('a dragged height is kept as asked when it fits', () => {
    expect(clampBandHeight(300, 900)).toBe(300)
  })

  it('it never shrinks below a readable floor', () => {
    expect(clampBandHeight(10, 900)).toBe(BAND_MIN_PX)
    expect(clampBandHeight(-40, 900)).toBe(BAND_MIN_PX)
  })

  // UX PASS ITEM 7: the old fixed 70%-of-viewport ceiling is gone — the band may be dragged all
  // the way up to the measured centre column's own height (never more).
  it('the ceiling is the measured column, not a fraction of it', () => {
    expect(clampBandHeight(10_000, 900)).toBe(900)
    expect(clampBandHeight(500, 900)).toBe(500)
  })

  it('a column too short for the floor still yields the floor, never a negative box', () => {
    // The ceiling would be below the floor here; a max/min written the other way round returns a
    // height the flex column cannot lay out.
    expect(clampBandHeight(200, 100)).toBe(BAND_MIN_PX)
  })

  it('a height that is not a number falls back to the floor', () => {
    expect(clampBandHeight(Number.NaN, 900)).toBe(BAND_MIN_PX)
  })

  it('an unmeasured column (0, NaN) never becomes a ceiling', () => {
    expect(clampBandHeight(5000, 0)).toBe(5000)
    expect(clampBandHeight(5000, Number.NaN)).toBe(5000)
  })
})

describe('resolveBandHeight — the free-resize snap (design item 7)', () => {
  it('an ordinary height, well short of the column, is never full', () => {
    expect(resolveBandHeight(400, 900)).toEqual({ height: 400, full: false })
  })

  it('within the snap threshold of the column\'s own top, it SNAPS to fill it exactly', () => {
    const wanted = 900 - BAND_SNAP_THRESHOLD_PX // right at the edge of the threshold
    expect(resolveBandHeight(wanted, 900)).toEqual({ height: 900, full: true })
  })

  it('one pixel short of the threshold is still an ordinary height', () => {
    const wanted = 900 - BAND_SNAP_THRESHOLD_PX - 1
    expect(resolveBandHeight(wanted, 900)).toEqual({ height: wanted, full: false })
  })

  it('asking for MORE than the column still snaps to exactly the column\'s height', () => {
    expect(resolveBandHeight(10_000, 900)).toEqual({ height: 900, full: true })
  })

  it('dragging DOWN from full releases it, symmetrically — same function, no separate rule', () => {
    // The next drag starts from the column's own height (what `full` rendered) and moves down by
    // more than the threshold: back to an ordinary height, not full.
    const startedFull = resolveBandHeight(900, 900)
    expect(startedFull.full).toBe(true)
    const draggedDown = resolveBandHeight(startedFull.height - BAND_SNAP_THRESHOLD_PX - 20, 900)
    expect(draggedDown.full).toBe(false)
  })

  it('an unmeasured column never snaps — there is nothing to snap TO', () => {
    expect(resolveBandHeight(5000, 0)).toEqual({ height: 5000, full: false })
    expect(resolveBandHeight(5000, Number.NaN)).toEqual({ height: 5000, full: false })
  })

  it('the floor still applies underneath the snap logic', () => {
    expect(resolveBandHeight(10, 900)).toEqual({ height: BAND_MIN_PX, full: false })
  })
})

describe('wantsFullscreen / resolveBandDrag — the full-screen threshold, shared by both bands', () => {
  it('an ordinary height, well short of the column, never wants full screen', () => {
    expect(wantsFullscreen(400, 900)).toBe(false)
  })

  it('reaching exactly the column top (ordinary `full`) is not YET full screen', () => {
    expect(wantsFullscreen(900, 900)).toBe(false)
  })

  it('one pixel short of the overshoot threshold is still not full screen', () => {
    expect(wantsFullscreen(900 + BAND_FULLSCREEN_OVERSHOOT_PX - 1, 900)).toBe(false)
  })

  it('right at the overshoot threshold PAST the column, it wants full screen', () => {
    expect(wantsFullscreen(900 + BAND_FULLSCREEN_OVERSHOOT_PX, 900)).toBe(true)
  })

  it('dragged all the way to the top of the screen — the reported freeze — wants full screen', () => {
    expect(wantsFullscreen(10_000, 900)).toBe(true)
  })

  it('an unmeasured column never wants full screen — there is no top edge to have gone past', () => {
    expect(wantsFullscreen(10_000, 0)).toBe(false)
    expect(wantsFullscreen(10_000, Number.NaN)).toBe(false)
  })

  it('resolveBandDrag bundles the ordinary snap with the fullscreen want, in one call', () => {
    expect(resolveBandDrag(400, 900)).toEqual({ height: 400, full: false, fullscreen: false })
    expect(resolveBandDrag(900, 900)).toEqual({ height: 900, full: true, fullscreen: false })
  })

  it('once past the overshoot, height/full stay exactly what the ORDINARY snap would have answered', () => {
    // The whole point: the band is never told to remember the raw, enormous overshoot as its own
    // height — `height`/`full` here are identical to `resolveBandHeight(10_000, 900)` alone, so
    // leaving full screen can fall back to this record and land on a sane, column-filling band
    // rather than on whatever the drag's raw number happened to be.
    const dragged = resolveBandDrag(10_000, 900)
    expect(dragged).toEqual({ height: 900, full: true, fullscreen: true })
    expect({ height: dragged.height, full: dragged.full }).toEqual(resolveBandHeight(10_000, 900))
  })

  // THE REPORTED FREEZE, REPRODUCED AS A SEQUENCE OF SMALL DRAGS rather than one big jump — "aos
  // poucos pra cima" (gradually, upward). Each `it` below is one mousedown→mousemove→mouseup cycle;
  // `startH` for gesture N is `renderedHeight` from the END of gesture N-1, exactly as
  // `StudioBand`/`ShellBand`'s own `onDragStart` reads it off their component state. This is the
  // STATE MACHINE's contract: as long as every caller renders `full` as an EXPLICIT height (never
  // `flex-grow`, see this module's own `resolveBandDrag` header), `renderedHeight` and the box on
  // screen can never disagree, so this sequence can never desync the way the live bug did.
  it('a run of small upward drags reaches full and STAYS there — no jump back on the next nudge', () => {
    const columnHeight = 900
    let height = 240
    let full = false
    const renderedHeight = () => (full && columnHeight > 0 ? columnHeight : height)
    const drag = (deltaUpPx: number) => {
      const startH = renderedHeight()
      const wantedPx = startH + deltaUpPx // dragging UP grows the band, exactly like the real handle
      const resolved = resolveBandDrag(wantedPx, columnHeight)
      height = resolved.height
      full = resolved.full
      return resolved
    }
    // Five small nudges of 40px each: 240 -> 280 -> 320 -> 360 -> 400 -> 440, all ordinary.
    for (let i = 0; i < 5; i++) {
      const r = drag(40)
      expect(r.full).toBe(false)
      expect(r.fullscreen).toBe(false)
    }
    expect(renderedHeight()).toBe(440)
    // Now nudge it the rest of the way, in more small steps, crossing the snap threshold.
    for (let i = 0; i < 11; i++) drag(40) // 440 -> 880 (11 * 40), inside the snap threshold of 900
    expect(full).toBe(true)
    expect(renderedHeight()).toBe(columnHeight) // FILLS the column — never a smaller "middle" value
    // THE REPORTED BUG: a further TINY nudge (well under `BAND_FULLSCREEN_OVERSHOOT_PX`) must stay
    // exactly full — never an immediate, surprise jump into full screen from a movement that small.
    // In the broken world this fired because `startH` for THIS gesture was read as "900" (what the
    // STATE said) while the box on screen was really ~381px (what the flex competition rendered),
    // so even a few pixels of real movement computed as a `wantedPx` already past the overshoot.
    const tinyNudge = drag(5)
    expect(tinyNudge.fullscreen).toBe(false)
    expect(renderedHeight()).toBe(columnHeight) // still exactly full, never smaller and never larger
    // A DELIBERATE further push, past the actual overshoot threshold, is the one thing that may
    // still escalate — that is the feature, not the bug, and it is exercised on its own below.
    const deliberate = drag(BAND_FULLSCREEN_OVERSHOOT_PX)
    expect(deliberate.fullscreen).toBe(true)
  })

  it('past the overshoot from a TRUE full state, height/full never fall back to a smaller "middle" value', () => {
    const columnHeight = 900
    const filled = resolveBandDrag(columnHeight, columnHeight)
    expect(filled).toEqual({ height: 900, full: true, fullscreen: false })
    // Drag further, past BAND_FULLSCREEN_OVERSHOOT_PX, starting from the ALREADY-full height —
    // exactly the second gesture in the reported sequence.
    const escalated = resolveBandDrag(filled.height + BAND_FULLSCREEN_OVERSHOOT_PX, columnHeight)
    expect(escalated.fullscreen).toBe(true)
    // Full screen and the band height never disagree: the height/full pair underneath full screen
    // is IDENTICAL to the ordinary "fills the column" state, so leaving full screen lands there
    // rather than on some other, smaller value a caller might mistake for "the middle".
    expect({ height: escalated.height, full: escalated.full }).toEqual({ height: filled.height, full: filled.full })
  })
})

describe('where the shell was opened, said in the room a band has', () => {
  it('the home directory becomes ~', () => {
    expect(shellWhere('/home/mithrandir/agentistics')).toBe('~/agentistics')
  })

  it('a long path keeps its TAIL, with a leading ellipsis', () => {
    // The tail is what answers "where am I". `direction: rtl` was the first attempt and it moves
    // the LEADING `~` to the end — `eu/freelas/Pelvis-Institucional/~`, which reads as a directory
    // called `~` inside the project. So the trim is computed rather than left to the text engine.
    expect(shellWhere('/home/mithrandir/eu/freelas/Pelvis-Institucional')).toBe('…/freelas/Pelvis-Institucional')
  })

  it('a path already short enough is untouched', () => {
    expect(shellWhere('/srv/app')).toBe('/srv/app')
    expect(shellWhere('/home/m/x')).toBe('~/x')
  })

  it('nothing to say is an empty string, never a guess', () => {
    expect(shellWhere(undefined)).toBe('')
    expect(shellWhere('')).toBe('')
  })
})

describe('the refusal comes back in the reader’s own language', () => {
  test('every call carries the language, because the SERVER composes the sentence', () => {
    // `handleShellRoute` renders each `ShellRefusal` code into prose and reads the language off the
    // query string; with no `lang` it answers in English. Seen on screen: a Portuguese dashboard
    // showing "8 terminals are already open. Close one to open another." beside a Portuguese retry
    // button. The one thing a refusal has to be is readable.
    expect(shellApiUrl('/api/shell/open', 'pt')).toBe('/api/shell/open?lang=pt')
    expect(shellApiUrl('/api/shell/list', 'en')).toBe('/api/shell/list?lang=en')
  })
})

describe('a refusal is a sentence, never a blank pane', () => {
  it('the switch being off says so, and says where to turn it on', () => {
    expect(shellErrorText('shell_disabled', 'en')).toContain('Settings')
    expect(shellErrorText('shell_disabled', 'pt')).toContain('Configurações')
  })

  it('a central says it has no host to open one on', () => {
    expect(shellErrorText('shell_central', 'en')).not.toBe('shell_central')
    expect(shellErrorText('shell_central', 'pt')).not.toBe('shell_central')
  })

  it('an unknown code is shown verbatim rather than swallowed', () => {
    // A reason the reader cannot parse still beats a silent failure — `inputReasonText`'s own rule.
    expect(shellErrorText('something_new', 'en')).toBe('something_new')
  })
})

describe('the band prefs are a per-viewer convenience and never a hard dependency', () => {
  function memory(): Storage {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
      clear: () => map.clear(),
      key: () => null,
      get length() { return map.size },
    } as unknown as Storage
  }

  it('round-trips', () => {
    const s = memory()
    const prefs: BandPrefs = { open: true, height: 260 }
    writeBandPrefs(prefs, s)
    expect(readBandPrefs(s)).toEqual(prefs)
  })

  // design item 7
  it('round-trips `full` too, omitted (not `false`) when no panel has it set', () => {
    const s = memory()
    writeBandPrefs({ open: true, height: 900, full: { studio: true } }, s)
    expect(readBandPrefs(s)).toEqual({ open: true, height: 900, full: { studio: true } })

    const s2 = memory()
    writeBandPrefs({ open: true, height: 260 }, s2)
    expect(readBandPrefs(s2)).toEqual({ open: true, height: 260 })
    expect('full' in readBandPrefs(s2)).toBe(false)
  })

  /**
   * FULL SCREEN IS A PROPERTY OF THE PANEL, NOT OF THE SLOT — the reported bug: drag the Studio to
   * fill the column, then move Contents into the SAME bottom band, and Contents read as full too,
   * on the very first frame, before anyone had dragged it anywhere. `full` used to be one flat
   * boolean shared by every occupant of the band; it is now keyed by `PanelId`, and
   * `bandPanelFull`/`withBandPanelFull` are the only way anything reads or writes an entry in it.
   */
  describe('full screen is a property of the panel, not of the slot', () => {
    it('a panel put in full screen reads full; a DIFFERENT panel moved into the same band does not', () => {
      const s = memory()
      writeBandPrefs(withBandPanelFull(readBandPrefs(s), 'studio', true), s)
      const prefs = readBandPrefs(s)
      expect(bandPanelFull(prefs, 'studio')).toBe(true)
      expect(bandPanelFull(prefs, 'live')).toBe(false)
      expect(bandPanelFull(prefs, 'hardware')).toBe(false)
      expect(bandPanelFull(prefs, 'cli')).toBe(false)
      expect(bandPanelFull(prefs, 'shell')).toBe(false)
    })

    it('two panels can each be full at once — a per-panel fact, not a single slot-wide switch', () => {
      let prefs = withBandPanelFull(DEFAULT_BAND_PREFS, 'studio', true)
      prefs = withBandPanelFull(prefs, 'live', true)
      expect(bandPanelFull(prefs, 'studio')).toBe(true)
      expect(bandPanelFull(prefs, 'live')).toBe(true)
      expect(bandPanelFull(prefs, 'hardware')).toBe(false)
    })

    it('turning full OFF for one panel never disturbs another panel\'s own entry', () => {
      let prefs = withBandPanelFull(DEFAULT_BAND_PREFS, 'studio', true)
      prefs = withBandPanelFull(prefs, 'shell', true)
      prefs = withBandPanelFull(prefs, 'studio', false)
      expect(bandPanelFull(prefs, 'studio')).toBe(false)
      expect(bandPanelFull(prefs, 'shell')).toBe(true)
    })

    it('turning off the LAST full panel omits the key entirely, not an empty object', () => {
      let prefs = withBandPanelFull(DEFAULT_BAND_PREFS, 'studio', true)
      prefs = withBandPanelFull(prefs, 'studio', false)
      expect('full' in prefs).toBe(false)
    })

    it('setting a panel that was never full to false is a no-op, not a thrown key', () => {
      const prefs = withBandPanelFull(DEFAULT_BAND_PREFS, 'hardware', false)
      expect('full' in prefs).toBe(false)
    })

    it('every other field survives a full-panel write untouched', () => {
      const before: BandPrefs = { open: true, height: 555, target: 'shell' }
      const after = withBandPanelFull(before, 'cli', true)
      expect(after.open).toBe(true)
      expect(after.height).toBe(555)
      expect(after.target).toBe('shell')
    })
  })

  /**
   * THE MIGRATION: an existing record still holding the OLD flat-boolean shape must not throw, and
   * must not carry that boolean forward as any panel's own entry — it named no panel, so applying
   * it to whichever one asks first would just move the same bug one layer down.
   */
  describe('the old flat-boolean `full` migrates away rather than resurrecting', () => {
    it('an old record with `full: true` reads as no panel being full — never as EVERY panel full', () => {
      const s = memory()
      s.setItem('agentistics-shell-band', JSON.stringify({ open: true, height: 900, full: true }))
      const prefs = readBandPrefs(s)
      expect('full' in prefs).toBe(false)
      for (const panel of ['studio', 'live', 'hardware', 'cli', 'shell'] as const) {
        expect(bandPanelFull(prefs, panel)).toBe(false)
      }
    })

    it('an old record with `full: false` reads the same way, and the rest of the record survives', () => {
      const s = memory()
      s.setItem('agentistics-shell-band', JSON.stringify({ open: true, height: 700, full: false }))
      const prefs = readBandPrefs(s)
      expect('full' in prefs).toBe(false)
      expect(prefs.open).toBe(true)
      expect(prefs.height).toBe(700)
    })

    it('reading an old record never throws', () => {
      const s = memory()
      s.setItem('agentistics-shell-band', JSON.stringify({ open: true, height: 400, full: true }))
      expect(() => readBandPrefs(s)).not.toThrow()
    })

    it('an unrecognised key under the new object shape is dropped, not carried through', () => {
      const s = memory()
      s.setItem('agentistics-shell-band', JSON.stringify({ open: true, height: 400, full: { bogus: true, studio: true } }))
      const prefs = readBandPrefs(s)
      expect(prefs.full).toEqual({ studio: true })
    })

    it('a non-`true` value under a real panel key is dropped, matching every other boolean here', () => {
      const s = memory()
      s.setItem('agentistics-shell-band', JSON.stringify({ open: true, height: 400, full: { studio: 'yes' } }))
      expect('full' in readBandPrefs(s)).toBe(false)
    })
  })

  it('no stored value reads as CLOSED — the band is never opened by a machine nobody asked', () => {
    expect(readBandPrefs(memory()).open).toBe(false)
  })

  it('a storage that throws on read costs nothing', () => {
    const hostile = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } } as unknown as Storage
    expect(() => readBandPrefs(hostile)).not.toThrow()
    expect(readBandPrefs(hostile).open).toBe(false)
    expect(() => writeBandPrefs({ open: true, height: 200 }, hostile)).not.toThrow()
  })

  it('junk in storage reads as the default rather than as a broken band', () => {
    const s = memory()
    s.setItem('agentistics-shell-band', 'not json')
    expect(readBandPrefs(s).open).toBe(false)
    s.setItem('agentistics-shell-band', '{"open":"yes","height":"tall"}')
    expect(readBandPrefs(s)).toEqual({ open: false, height: DEFAULT_BAND_PREFS.height })
  })
})

/**
 * `seedBandOpen` — THE FIX: with the band open on the Studio, picking Claude Code or Shell used to
 * MINIMIZE it instead of switching, needing a second click. `ShellBand` mounts fresh whenever it
 * swaps in for `StudioBand`/`SimpleDockedBand` (three different components sharing one bottom
 * slot), and reading the shared `agentistics-shell-band` record's `open` field cold — the same
 * flat-boolean shape `withBandPanelFull` already had to fix for `full` — ignored the
 * `bottomOpen: true` `panelSlots.ts`'s own `openPanel` had JUST set for the very panel now
 * mounting. This is the one function that closes it: seed the freshly-read record with the
 * authoritative `slotLayout.bottomOpen` the caller passes in as `openSeed`.
 */
describe('seedBandOpen — the fresh-mount fix for "picking a tab minimized the band"', () => {
  it('a stale `open: false` in storage is overridden by a true seed', () => {
    const stale: BandPrefs = { open: false, height: 300 }
    expect(seedBandOpen(stale, true)).toEqual({ open: true, height: 300 })
  })

  it('a stale `open: true` in storage is overridden by a false seed', () => {
    const stale: BandPrefs = { open: true, height: 300 }
    expect(seedBandOpen(stale, false)).toEqual({ open: false, height: 300 })
  })

  it('no seed (a caller that predates the prop) trusts the record exactly as read', () => {
    const stored: BandPrefs = { open: false, height: 300 }
    expect(seedBandOpen(stored, undefined)).toEqual(stored)
    expect(seedBandOpen(stored, undefined)).toBe(stored) // the SAME object — never a needless copy
  })

  it('every other field survives a seed untouched', () => {
    const stored: BandPrefs = { open: false, height: 555, target: 'shell', full: { studio: true } }
    expect(seedBandOpen(stored, true)).toEqual({ open: true, height: 555, target: 'shell', full: { studio: true } })
  })

  it('the reported repro, worked through the record directly: Studio open, collapsed, then Claude Code takes the slot', () => {
    // 1) The band is open on Studio: `agentistics-shell-band` holds `open: true`.
    const whileStudioOpen: BandPrefs = { open: true, height: 300 }
    // 2) The reader collapses it (the shared minimize chevron writes `open: false` here too, since
    //    Studio and this band share one record for `height`/`open`).
    const whileStudioCollapsed: BandPrefs = { ...whileStudioOpen, open: false }
    // 3) The reader picks "Claude Code". `resolvePanelBarPick` answers `{kind:'open'}`,
    //    `panelSlots.openPanel` sets `bottomOpen: true` for the NEW occupant, and `ShellBand` mounts
    //    fresh — `openSeed` is that fresh `true`, not the `false` the record above still holds.
    const seeded = seedBandOpen(whileStudioCollapsed, true)
    expect(seeded.open).toBe(true) // FIXED: without the seed this stays `false` (the reported bug)
  })
})

describe('the geometry the band remembers', () => {
  const fake = (): Storage => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v) },
      removeItem: (k: string) => { m.delete(k) },
      clear: () => m.clear(),
      key: () => null,
      get length() { return m.size },
    } as unknown as Storage
  }

  test('a band that has never been measured remembers nothing', () => {
    expect(bandGeometry('docked', fake())).toBeUndefined()
    expect(bandGeometry('dedicated', fake())).toBeUndefined()
  })

  test('the last measurement survives a reload, so the next open starts at the right size', () => {
    const s = fake()
    writeBandGeometry('docked', { cols: 144, rows: 13 }, s)
    expect(bandGeometry('docked', s)).toEqual({ cols: 144, rows: 13 })
  })

  // THE PLACEMENTS ARE DIFFERENT BOXES. A band under the composer is ~13 rows and the shell's own
  // screen is ~48; one shared memory means every arrival on the dedicated screen opens at the
  // band's height and jumps — the exact snap this memory exists to remove, from the other side.
  test('each placement remembers its OWN box', () => {
    const s = fake()
    writeBandGeometry('docked', { cols: 144, rows: 13 }, s)
    writeBandGeometry('dedicated', { cols: 144, rows: 48 }, s)
    writeBandGeometry('aside', { cols: 96, rows: 30 }, s)
    expect(bandGeometry('docked', s)).toEqual({ cols: 144, rows: 13 })
    expect(bandGeometry('dedicated', s)).toEqual({ cols: 144, rows: 48 })
    expect(bandGeometry('aside', s)).toEqual({ cols: 96, rows: 30 })
  })

  test('writing a geometry keeps everything else the record already held', () => {
    const s = fake()
    writeBandPrefs({ open: true, height: 320 }, s)
    writeBandGeometry('docked', { cols: 200, rows: 40 }, s)
    const back = readBandPrefs(s)
    expect(back.open).toBe(true)
    expect(back.height).toBe(320)
    expect(bandGeometry('docked', s)).toEqual({ cols: 200, rows: 40 })
  })

  test('a stored geometry that does not read as one is DROPPED, never half-used', () => {
    for (const bad of [
      { cols: 0, rows: 13 }, { cols: 144 }, { rows: 13 }, { cols: '144', rows: 13 },
      { cols: 1.5, rows: 13 }, { cols: 144, rows: -2 }, 'nope', null, 7,
    ]) {
      const s = fake()
      s.setItem('agentistics-shell-band', JSON.stringify({ open: true, height: 240, geometry: { docked: bad } }))
      expect(bandGeometry('docked', s), JSON.stringify(bad)).toBeUndefined()
      // The rest of the record still reads — one unreadable field is not an unreadable record.
      expect(readBandPrefs(s).open).toBe(true)
    }
  })

  test('one unreadable placement never costs the other', () => {
    const s = fake()
    s.setItem('agentistics-shell-band', JSON.stringify({
      open: true, height: 240, geometry: { docked: { cols: 0, rows: 0 }, dedicated: { cols: 144, rows: 48 } },
    }))
    expect(bandGeometry('docked', s)).toBeUndefined()
    expect(bandGeometry('dedicated', s)).toEqual({ cols: 144, rows: 48 })
  })

  test('a storage that throws costs the memory and never the band', () => {
    const hostile = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } as unknown as Storage
    expect(() => writeBandGeometry('docked', { cols: 144, rows: 13 }, hostile)).not.toThrow()
    expect(bandGeometry('docked', hostile)).toBeUndefined()
    expect(readBandPrefs(hostile)).toEqual(DEFAULT_BAND_PREFS)
  })
})
