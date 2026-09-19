import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_LAST_SLOT, EMPTY_SLOT_LAYOUT, PANEL_IDS, allowed, closePanel, dockedShowsTarget,
  getPanelLayout, hidePanel, isPanelShown, movePanel, openPanel, readLayout, relocatePanel,
  resetPanelSlots, resolveForGates, resolveForViewport, rightSlotShowing, setBottomOpen, showPanel,
  subscribePanelLayout,
  type PanelGates, type PanelId, type SlotId, type SlotLayout,
} from './panelSlots'
import { answerUnsaved, getUnsaved, reportUnsaved, resetUnsaved } from './unsavedBuffers'

const SLOTS: readonly SlotId[] = ['right', 'bottom']

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

describe('allowed — the closed sets', () => {
  test('right hosts all five panels', () => {
    for (const p of PANEL_IDS) expect(allowed('right', p)).toBe(true)
  })

  test('bottom hosts cli/shell/studio — contents and hardware do not fit a band', () => {
    expect(allowed('bottom', 'contents')).toBe(false)
    expect(allowed('bottom', 'studio')).toBe(true)
    expect(allowed('bottom', 'cli')).toBe(true)
    expect(allowed('bottom', 'shell')).toBe(true)
    expect(allowed('bottom', 'hardware')).toBe(false)
  })
})

describe('openPanel — exhaustive, every panel × slot × starting occupant', () => {
  test('opening into an empty slot with an explicit slot places it there and remembers it', () => {
    for (const panel of PANEL_IDS) {
      for (const slot of SLOTS) {
        if (!allowed(slot, panel)) continue
        const next = openPanel(EMPTY_SLOT_LAYOUT, panel, slot)
        expect(next[slot]).toBe(panel)
        expect(next.lastSlot[panel]).toBe(slot)
        // The other slot is untouched.
        const other: SlotId = slot === 'right' ? 'bottom' : 'right'
        expect(next[other]).toBe(EMPTY_SLOT_LAYOUT[other])
      }
    }
  })

  test('an illegal placement is REFUSED — same object, nothing coerced', () => {
    const next = openPanel(EMPTY_SLOT_LAYOUT, 'contents', 'bottom')
    expect(next).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('with no slot given, it falls back to lastSlot, then to the panel’s default', () => {
    expect(openPanel(EMPTY_SLOT_LAYOUT, 'studio').right).toBe('studio')
    expect(openPanel(EMPTY_SLOT_LAYOUT, 'cli').bottom).toBe('cli')
    expect(openPanel(EMPTY_SLOT_LAYOUT, 'hardware').right).toBe('hardware')
    const remembered: SlotLayout = {
      ...EMPTY_SLOT_LAYOUT, lastSlot: { ...DEFAULT_LAST_SLOT, cli: 'right' },
    }
    expect(openPanel(remembered, 'cli').right).toBe('cli')
  })

  test('hardware can never land at the bottom, even asked for explicitly — right only', () => {
    expect(openPanel(EMPTY_SLOT_LAYOUT, 'hardware', 'bottom')).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('opening a panel where another already sits DISPLACES it — the other stops being shown anywhere', () => {
    const withCli = openPanel(EMPTY_SLOT_LAYOUT, 'cli', 'right')
    const next = openPanel(withCli, 'studio', 'right')
    expect(next.right).toBe('studio')
    expect(isPanelShown(next, 'cli')).toBe(false)
  })

  test('opening a panel already in the OTHER slot MOVES it rather than duplicating it', () => {
    const bottomCli = openPanel(EMPTY_SLOT_LAYOUT, 'cli', 'bottom')
    const next = openPanel(bottomCli, 'cli', 'right')
    expect(next.right).toBe('cli')
    expect(next.bottom).toBeNull()
  })

  test('opening bottom always expands the band', () => {
    const next = openPanel({ ...EMPTY_SLOT_LAYOUT, bottomOpen: false }, 'shell', 'bottom')
    expect(next.bottomOpen).toBe(true)
  })

  test('opening the panel already exactly where it is is a genuine no-op (idempotent) beyond the values', () => {
    const once = openPanel(EMPTY_SLOT_LAYOUT, 'studio', 'right')
    const twice = openPanel(once, 'studio', 'right')
    expect(twice.right).toBe('studio')
    expect(twice.bottom).toBeNull()
  })

  test('every panel can open into every slot that allows it, from every starting occupant, including itself', () => {
    for (const slot of SLOTS) {
      for (const panel of PANEL_IDS) {
        if (!allowed(slot, panel)) continue
        for (const occupant of [null, ...PANEL_IDS] as (PanelId | null)[]) {
          if (occupant !== null && !allowed(slot, occupant)) continue
          const start: SlotLayout = { ...EMPTY_SLOT_LAYOUT, [slot]: occupant }
          const next = openPanel(start, panel, slot)
          expect(next[slot]).toBe(panel)
        }
      }
    }
  })
})

describe('closePanel', () => {
  test('removes the panel from wherever it sits', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'studio', 'right')
    expect(closePanel(shown, 'studio')).toEqual(EMPTY_SLOT_LAYOUT)
  })

  test('a panel not shown anywhere closes as a no-op — same object', () => {
    expect(closePanel(EMPTY_SLOT_LAYOUT, 'studio')).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('closing one panel never touches the other slot', () => {
    const both: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'contents', bottom: 'cli', bottomOpen: true }
    const next = closePanel(both, 'contents')
    expect(next.bottom).toBe('cli')
    expect(next.bottomOpen).toBe(true)
  })

  test('closing the bottom occupant also clears bottomOpen — nothing left to show', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'shell', 'bottom')
    expect(closePanel(shown, 'shell').bottomOpen).toBe(false)
  })
})

describe('movePanel', () => {
  test('moves a shown panel to the other slot, displacing whatever was there', () => {
    const start: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'studio', bottom: 'cli', bottomOpen: true }
    const next = movePanel(start, 'studio', 'bottom')
    expect(next.bottom).toBe('studio')
    expect(next.right).toBeNull()
    expect(isPanelShown(next, 'cli')).toBe(false)
  })

  test('a panel not shown anywhere cannot be moved — no-op', () => {
    expect(movePanel(EMPTY_SLOT_LAYOUT, 'studio', 'bottom')).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('moving to the slot it is already in is a no-op', () => {
    const start = openPanel(EMPTY_SLOT_LAYOUT, 'shell', 'bottom')
    expect(movePanel(start, 'shell', 'bottom')).toBe(start)
  })

  test('a move to an illegal slot is refused', () => {
    const start = openPanel(EMPTY_SLOT_LAYOUT, 'contents', 'right')
    expect(movePanel(start, 'contents', 'bottom')).toBe(start)
  })

  test('every legal move, from every legal starting position, lands exactly where asked', () => {
    for (const panel of PANEL_IDS) {
      for (const from of SLOTS) {
        if (!allowed(from, panel)) continue
        for (const to of SLOTS) {
          if (to === from || !allowed(to, panel)) continue
          const start = openPanel(EMPTY_SLOT_LAYOUT, panel, from)
          const next = movePanel(start, panel, to)
          expect(next[to]).toBe(panel)
          expect(next[from]).toBeNull()
        }
      }
    }
  })

  test('vacating the bottom slot resets bottomOpen — a panel moved to the right leaves no orphaned flag (M2)', () => {
    const start = openPanel(EMPTY_SLOT_LAYOUT, 'studio', 'bottom')
    expect(start.bottomOpen).toBe(true)
    const next = movePanel(start, 'studio', 'right')
    expect(next.bottom).toBeNull()
    expect(next.bottomOpen).toBe(false)
  })

  // Owner feedback, 2026-09-17: "pressing 'Mover para baixo' only CLOSES the right aside instead of
  // moving that panel to the bottom band … add a panelSlots test per panel for both directions".
  // The exhaustive loop above already walks this table, but a bug reported by name deserves a test
  // that reads back as the same sentence — a reader checking the fix does not have to run the loop
  // in their head to see that "Studio, right to bottom" is covered. The FIX itself was never in this
  // pure function (verified live: it was the docked band's own local `target` preference going
  // stale when a move landed in `panelSlots` from OUTSIDE that band's own click handler — see
  // `ShellBand.tsx`'s own header and its new `useEffect`), but that is exactly why this module's own
  // contract has to be pinned in the open: if `movePanel` itself ever regressed, the wiring fix
  // would have nothing correct to react to.
  for (const panel of ['studio', 'cli', 'shell'] as const) {
    test(`${panel}: right → bottom actually moves it, never just vacates the right slot`, () => {
      const start = openPanel(EMPTY_SLOT_LAYOUT, panel, 'right')
      const next = movePanel(start, panel, 'bottom')
      expect(next.right).toBeNull()
      expect(next.bottom).toBe(panel)
      expect(isPanelShown(next, panel)).toBe(true)
    })

    test(`${panel}: bottom → right actually moves it, never just closes the band`, () => {
      const start = openPanel(EMPTY_SLOT_LAYOUT, panel, 'bottom')
      const next = movePanel(start, panel, 'right')
      expect(next.bottom).toBeNull()
      expect(next.right).toBe(panel)
      expect(isPanelShown(next, panel)).toBe(true)
    })
  }
})

describe('isPanelShown', () => {
  test('true in either slot, including a collapsed bottom band', () => {
    expect(isPanelShown({ ...EMPTY_SLOT_LAYOUT, right: 'contents' }, 'contents')).toBe(true)
    expect(isPanelShown({ ...EMPTY_SLOT_LAYOUT, bottom: 'shell', bottomOpen: false }, 'shell')).toBe(true)
  })

  test('false when it sits nowhere', () => {
    expect(isPanelShown(EMPTY_SLOT_LAYOUT, 'studio')).toBe(false)
  })
})

describe('rightSlotShowing — the one "what is shown" selector (C2)', () => {
  test('the right slot\'s own occupant always wins, whatever Contents\' own open flag says', () => {
    expect(rightSlotShowing({ ...EMPTY_SLOT_LAYOUT, right: 'cli' }, false)).toBe('cli')
    expect(rightSlotShowing({ ...EMPTY_SLOT_LAYOUT, right: 'cli' }, true)).toBe('cli')
    expect(rightSlotShowing({ ...EMPTY_SLOT_LAYOUT, right: 'shell' }, true)).toBe('shell')
    expect(rightSlotShowing({ ...EMPTY_SLOT_LAYOUT, right: 'studio' }, true)).toBe('studio')
  })

  test('Contents only decides the answer once nothing else occupies the slot', () => {
    expect(rightSlotShowing(EMPTY_SLOT_LAYOUT, true)).toBe('contents')
    expect(rightSlotShowing(EMPTY_SLOT_LAYOUT, false)).toBeNull()
  })
})

describe('dockedShowsTarget — exclusivity between the docked band and the right slot (C3)', () => {
  test('shown when nothing (or the OTHER target) sits at right', () => {
    expect(dockedShowsTarget(EMPTY_SLOT_LAYOUT, 'shell')).toBe(true)
    expect(dockedShowsTarget({ ...EMPTY_SLOT_LAYOUT, right: 'cli' }, 'shell')).toBe(true)
    expect(dockedShowsTarget({ ...EMPTY_SLOT_LAYOUT, right: 'studio' }, 'cli')).toBe(true)
  })

  test('excluded once the right slot holds this EXACT target', () => {
    expect(dockedShowsTarget({ ...EMPTY_SLOT_LAYOUT, right: 'shell' }, 'shell')).toBe(false)
    expect(dockedShowsTarget({ ...EMPTY_SLOT_LAYOUT, right: 'cli' }, 'cli')).toBe(false)
  })

  test('moving the panel away from the right hands the docked band back its target, unprompted', () => {
    const atRight: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'shell' }
    expect(dockedShowsTarget(atRight, 'shell')).toBe(false)
    const movedAway = closePanel(atRight, 'shell')
    expect(dockedShowsTarget(movedAway, 'shell')).toBe(true)
  })
})

describe('setBottomOpen', () => {
  test('flips the flag without touching the occupant', () => {
    const start: SlotLayout = { ...EMPTY_SLOT_LAYOUT, bottom: 'cli', bottomOpen: true }
    expect(setBottomOpen(start, false)).toEqual({ ...start, bottomOpen: false })
  })

  test('setting the same value is a no-op — same object', () => {
    expect(setBottomOpen(EMPTY_SLOT_LAYOUT, false)).toBe(EMPTY_SLOT_LAYOUT)
  })
})

describe('resolveForViewport — the phone reading', () => {
  test('a stored bottom studio becomes the fullscreen right sheet on a phone', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, bottom: 'studio', bottomOpen: true }
    const seen = resolveForViewport(stored, true)
    expect(seen.right).toBe('studio')
    expect(seen.bottom).toBeNull()
  })

  test('desktop reads the layout untouched', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, bottom: 'studio', bottomOpen: true }
    expect(resolveForViewport(stored, false)).toBe(stored)
  })

  test('mobile with nothing studio-shaped in the bottom is untouched', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, bottom: 'shell', bottomOpen: true }
    expect(resolveForViewport(stored, true)).toBe(stored)
  })

  test('turning the phone back into a desktop restores the ORIGINAL stored layout — nothing was rewritten', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, bottom: 'studio', bottomOpen: true }
    resolveForViewport(stored, true) // read as a phone once
    // The desktop reading is computed fresh from the SAME stored value, never from the phone's view.
    expect(resolveForViewport(stored, false)).toEqual(stored)
  })
})

describe('resolveForGates — a closed gate reads the panel as absent (C1)', () => {
  const OPEN: PanelGates = { editorEnabled: true, shellEnabled: true, relayed: false }

  test('every gate open leaves the layout untouched', () => {
    const layout = openPanel(openPanel(EMPTY_SLOT_LAYOUT, 'studio', 'right'), 'shell', 'bottom')
    expect(resolveForGates(layout, OPEN)).toBe(layout)
  })

  test('editorEnabled off removes a right-slot Studio — the C1 repro', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'studio' }
    const resolved = resolveForGates(stored, { ...OPEN, editorEnabled: false })
    expect(resolved.right).toBeNull()
    expect(isPanelShown(resolved, 'studio')).toBe(false)
  })

  test('editorEnabled off removes a bottom-slot Studio too, and clears bottomOpen with it', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, bottom: 'studio', bottomOpen: true }
    const resolved = resolveForGates(stored, { ...OPEN, editorEnabled: false })
    expect(resolved.bottom).toBeNull()
    expect(resolved.bottomOpen).toBe(false)
  })

  test('shellEnabled off removes shell, cli is untouched', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'shell', bottom: 'cli', bottomOpen: true }
    const resolved = resolveForGates(stored, { ...OPEN, shellEnabled: false })
    expect(resolved.right).toBeNull()
    expect(resolved.bottom).toBe('cli')
  })

  test('a relayed session has no cli or shell stream — both are removed wherever they sit', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'cli', bottom: 'shell', bottomOpen: true }
    const resolved = resolveForGates(stored, { ...OPEN, relayed: true })
    expect(resolved.right).toBeNull()
    expect(resolved.bottom).toBeNull()
  })

  test('contents has no gate of its own', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'contents' }
    expect(resolveForGates(stored, { editorEnabled: false, shellEnabled: false, relayed: true })).toBe(stored)
  })

  test('hardware has no gate of its own either — it is a client-side read, not a session capability', () => {
    const stored: SlotLayout = { ...EMPTY_SLOT_LAYOUT, right: 'hardware' }
    expect(resolveForGates(stored, { editorEnabled: false, shellEnabled: false, relayed: true })).toBe(stored)
  })

  test('every panel × every gate combination: a closed gate never leaves its panel shown', () => {
    for (const editorEnabled of [true, false]) {
      for (const shellEnabled of [true, false]) {
        for (const relayed of [true, false]) {
          const gates: PanelGates = { editorEnabled, shellEnabled, relayed }
          for (const panel of PANEL_IDS) {
            for (const slot of SLOTS) {
              if (!allowed(slot, panel)) continue
              const layout = openPanel(EMPTY_SLOT_LAYOUT, panel, slot)
              const resolved = resolveForGates(layout, gates)
              const shouldBeOpen =
                panel === 'contents' ? true
                : panel === 'hardware' ? true
                : panel === 'studio' ? editorEnabled
                : panel === 'cli' ? !relayed
                : shellEnabled && !relayed
              expect(isPanelShown(resolved, panel)).toBe(shouldBeOpen)
            }
          }
        }
      }
    }
  })

  test('reading through the gate never touches the live layout — pure in, pure out', () => {
    resetPanelSlots()
    showPanel('studio', 'right')
    const live = getPanelLayout()
    // A caller reading through a closed gate sees the Studio gone...
    expect(resolveForGates(live, { ...OPEN, editorEnabled: false }).right).toBeNull()
    // ...but the LIVE layout — what every other reader still sees, and what gets persisted — is
    // exactly what it was. `resolveForGates` never commits, exactly like `resolveForViewport`.
    expect(getPanelLayout()).toBe(live)
    expect(getPanelLayout().right).toBe('studio')
  })
})

describe('the storage guard — readLayout', () => {
  test('no stored value reads as the empty layout', () => {
    expect(readLayout(memory())).toEqual(EMPTY_SLOT_LAYOUT)
  })

  test('round-trips a real layout', () => {
    const s = memory()
    const layout = openPanel(openPanel(EMPTY_SLOT_LAYOUT, 'studio', 'right'), 'shell', 'bottom')
    s.setItem('agentistics-panel-slots', JSON.stringify(layout))
    expect(readLayout(s)).toEqual(layout)
  })

  test('a storage that throws on read costs nothing', () => {
    const hostile = { getItem() { throw new Error('blocked') } } as unknown as Storage
    expect(() => readLayout(hostile)).not.toThrow()
    expect(readLayout(hostile)).toEqual(EMPTY_SLOT_LAYOUT)
  })

  test('junk in storage reads as empty rather than as a broken layout', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', 'not json')
    expect(readLayout(s)).toEqual(EMPTY_SLOT_LAYOUT)
  })

  test('an illegal occupant recorded by hand (or by an older build) is dropped, not trusted', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({ right: null, bottom: 'contents', bottomOpen: true }))
    expect(readLayout(s).bottom).toBeNull()
  })

  test('bottomOpen with no bottom occupant reads as false — nothing to show', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({ right: null, bottom: null, bottomOpen: true }))
    expect(readLayout(s).bottomOpen).toBe(false)
  })

  test('an unreadable lastSlot entry falls back to the default for that panel only', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      right: null, bottom: null, bottomOpen: false,
      // `contents` cannot host at the bottom (so that entry is dropped), `cli`'s value is not even
      // a slot name, and `studio` really can sit at the bottom — that one is kept.
      lastSlot: { contents: 'bottom', cli: 'nowhere', studio: 'bottom' },
    }))
    expect(readLayout(s).lastSlot).toEqual({ ...DEFAULT_LAST_SLOT, studio: 'bottom' })
  })
})

describe('the imperative store — showPanel / hidePanel / relocatePanel', () => {
  beforeEach(() => { resetPanelSlots(); resetUnsaved() })

  test('showPanel places a panel and notifies subscribers', () => {
    let notified = 0
    const unsub = subscribePanelLayout(() => { notified += 1 })
    showPanel('studio')
    expect(getPanelLayout().right).toBe('studio')
    expect(notified).toBe(1)
    unsub()
  })

  test('relocatePanel moves without asking, even with unsaved buffers', () => {
    showPanel('studio', 'right')
    reportUnsaved('studio', ['README.md'])
    relocatePanel('studio', 'bottom')
    expect(getPanelLayout().bottom).toBe('studio')
    expect(getUnsaved().question).toBeNull()
  })

  test('displacing a dirty Studio out of every slot is HELD until the reader discards', () => {
    showPanel('studio', 'right')
    reportUnsaved('studio', ['README.md'])
    showPanel('contents', 'right')
    // Held: the Studio is still the one shown, nothing committed yet.
    expect(getPanelLayout().right).toBe('studio')
    expect(getUnsaved().question).toEqual({ cause: 'close' })
    answerUnsaved(true)
    expect(getPanelLayout().right).toBe('contents')
  })

  test('"keep editing" leaves the Studio exactly where it was', () => {
    showPanel('studio', 'right')
    reportUnsaved('studio', ['README.md'])
    showPanel('contents', 'right')
    answerUnsaved(false)
    expect(getPanelLayout().right).toBe('studio')
  })

  test('hidePanel on a dirty Studio asks too', () => {
    showPanel('studio')
    reportUnsaved('studio', ['a.ts'])
    hidePanel('studio')
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
    answerUnsaved(true)
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(false)
  })

  test('closing a clean Studio asks nothing', () => {
    showPanel('studio')
    hidePanel('studio')
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(false)
    expect(getUnsaved().question).toBeNull()
  })

  test('displacing something that is not the Studio never asks', () => {
    showPanel('cli', 'right')
    showPanel('studio', 'right')
    expect(getPanelLayout().right).toBe('studio')
    expect(getUnsaved().question).toBeNull()
  })

  test('hidePanel’s `after` runs immediately when there was nothing to close', () => {
    let ran = 0
    hidePanel('studio', () => { ran += 1 })
    expect(ran).toBe(1)
  })

  test('hidePanel’s `after` runs immediately on a clean close', () => {
    showPanel('studio')
    let ran = 0
    hidePanel('studio', () => { ran += 1 })
    expect(ran).toBe(1)
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(false)
  })

  test('hidePanel’s `after` is HELD with the question, and runs only on discard — this is I2’s fix', () => {
    showPanel('studio', 'right')
    reportUnsaved('studio', ['README.md'])
    let ran = 0
    hidePanel('studio', () => { ran += 1 })
    expect(ran).toBe(0)
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
    answerUnsaved(true)
    expect(ran).toBe(1)
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(false)
  })

  test('hidePanel’s `after` never runs on "keep editing"', () => {
    showPanel('studio', 'right')
    reportUnsaved('studio', ['README.md'])
    let ran = 0
    hidePanel('studio', () => { ran += 1 })
    answerUnsaved(false)
    expect(ran).toBe(0)
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
  })
})
