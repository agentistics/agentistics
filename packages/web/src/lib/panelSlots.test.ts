import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_PLACEMENT, EMPTY_SLOT_LAYOUT, PANEL_IDS, allowed, bottomPanels, closePanel,
  getPanelLayout, hidePanel, hiddenPanels, hidePanelPlacement, isPanelId, isPanelPinned,
  isPanelShown, movePanel, openPanel, overlayOutsideAction, planPanelDrop, railClickAction,
  railPanels, readLayout, relocatePanel, reorderPlacement, resetPanelSlots, resolveForGates,
  resolveForViewport, restorePanelPlacement, rightSlotShowing, setBandOpen, setBottomOpen,
  setPanelPinned, setPlacement, setRightOpen, setSlotRightOpen, showPanel, subscribePanelLayout,
  togglePanelPinned, togglePinned,
  type OpenPlacement, type PanelGates, type PanelId, type Placement, type SlotLayout,
} from './panelSlots'
import { answerUnsaved, getUnsaved, reportUnsaved, resetUnsaved } from './unsavedBuffers'

const PLACEMENTS: readonly Placement[] = ['rail', 'bottom', 'hidden']
const OPEN_PLACEMENTS: readonly OpenPlacement[] = ['rail', 'bottom']

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

// ---------------------------------------------------------------------------------------------
// The fourteen panels, and `allowed`
// ---------------------------------------------------------------------------------------------

describe('PANEL_IDS', () => {
  test('is exactly the fifteen panels — the ten former Contents tabs, search, plus studio/hardware/cli/shell', () => {
    expect(PANEL_IDS.slice().sort()).toEqual([
      'agents', 'cli', 'forks', 'gallery', 'hardware', 'live', 'mcps', 'metrics', 'prs', 'search',
      'shell', 'skills', 'studio', 'tasks', 'workflows',
    ])
  })

  test('has no duplicate', () => {
    expect(new Set(PANEL_IDS).size).toBe(PANEL_IDS.length)
  })
})

describe('isPanelId', () => {
  test('accepts every PANEL_IDS member and nothing else, including the retired "contents"', () => {
    for (const id of PANEL_IDS) expect(isPanelId(id)).toBe(true)
    expect(isPanelId('contents')).toBe(false)
    expect(isPanelId('bogus')).toBe(false)
    expect(isPanelId(null)).toBe(false)
    expect(isPanelId(42)).toBe(false)
  })
})

describe('allowed — every panel reaches every placement', () => {
  test('rail/bottom/hidden are all allowed for all fourteen panels', () => {
    for (const placement of PLACEMENTS) {
      for (const panel of PANEL_IDS) expect(allowed(placement, panel)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Defaults (spec §1)
// ---------------------------------------------------------------------------------------------

describe('DEFAULT_PLACEMENT / EMPTY_SLOT_LAYOUT — a machine that has never touched this', () => {
  test('cli and shell default to bottom, every other panel defaults to rail', () => {
    for (const id of PANEL_IDS) {
      const want: Placement = id === 'cli' || id === 'shell' ? 'bottom' : 'rail'
      expect(DEFAULT_PLACEMENT[id]).toBe(want)
    }
  })

  test('nothing is hidden by default', () => {
    for (const id of PANEL_IDS) expect(EMPTY_SLOT_LAYOUT.placement[id]).not.toBe('hidden')
  })

  test('nothing is open by default — placement is not occupancy', () => {
    expect(EMPTY_SLOT_LAYOUT.right).toBeNull()
    expect(EMPTY_SLOT_LAYOUT.bottom).toBeNull()
    expect(EMPTY_SLOT_LAYOUT.bottomOpen).toBe(false)
  })

  test('railPanels/bottomPanels/hiddenPanels partition PANEL_IDS exactly, on the default layout', () => {
    const rail = railPanels(EMPTY_SLOT_LAYOUT)
    const bottom = bottomPanels(EMPTY_SLOT_LAYOUT)
    const hidden = hiddenPanels(EMPTY_SLOT_LAYOUT)
    expect(hidden).toEqual([])
    expect(bottom.slice().sort()).toEqual(['cli', 'shell'])
    expect(new Set([...rail, ...bottom])).toEqual(new Set(PANEL_IDS))
    expect(rail.length + bottom.length).toBe(PANEL_IDS.length)
  })
})

// ---------------------------------------------------------------------------------------------
// setPlacement / movePanel / hide / restore / reorder
// ---------------------------------------------------------------------------------------------

describe('setPlacement', () => {
  test('changes only the named panel’s placement', () => {
    const next = setPlacement(EMPTY_SLOT_LAYOUT, 'skills', 'bottom')
    expect(next.placement.skills).toBe('bottom')
    for (const id of PANEL_IDS) {
      if (id !== 'skills') expect(next.placement[id]).toBe(EMPTY_SLOT_LAYOUT.placement[id])
    }
  })

  test('is a no-op (same reference) when the panel is already there', () => {
    const next = setPlacement(EMPTY_SLOT_LAYOUT, 'cli', 'bottom')
    expect(next).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('does NOT change which panel is the active occupant, unless hiding it', () => {
    const opened = openPanel(EMPTY_SLOT_LAYOUT, 'skills')
    expect(opened.right).toBe('skills')
    const moved = setPlacement(opened, 'skills', 'bottom')
    // placement changed; occupancy untouched (movePanel is the one that also reopens)
    expect(moved.placement.skills).toBe('bottom')
    expect(moved.right).toBe('skills')
  })

  test('hiding a panel that is the active occupant removes it from that slot', () => {
    const opened = openPanel(EMPTY_SLOT_LAYOUT, 'skills')
    const hidden = setPlacement(opened, 'skills', 'hidden')
    expect(hidden.placement.skills).toBe('hidden')
    expect(hidden.right).toBeNull()
  })

  test('hiding remembers restoreTo from the placement it was hidden FROM', () => {
    const onBottom = setPlacement(EMPTY_SLOT_LAYOUT, 'live', 'bottom')
    const hidden = setPlacement(onBottom, 'live', 'hidden')
    expect(hidden.restoreTo.live).toBe('bottom')
  })

  test('hiding an already-hidden panel keeps its existing restoreTo', () => {
    const onBottom = setPlacement(EMPTY_SLOT_LAYOUT, 'live', 'bottom')
    const hidden = setPlacement(onBottom, 'live', 'hidden')
    const rehidden = setPlacement(hidden, 'live', 'hidden') // no-op, same ref
    expect(rehidden).toBe(hidden)
  })

  test('a currently-placed panel’s restoreTo always mirrors its own placement', () => {
    for (const id of PANEL_IDS) {
      const restoreTo: string = EMPTY_SLOT_LAYOUT.restoreTo[id]
      expect(restoreTo).toBe(EMPTY_SLOT_LAYOUT.placement[id])
    }
  })
})

describe('restorePanelPlacement', () => {
  test('puts a hidden panel back where it was, without opening it', () => {
    const onBottom = setPlacement(EMPTY_SLOT_LAYOUT, 'live', 'bottom')
    const opened = openPanel(onBottom, 'live')
    const hidden = setPlacement(opened, 'live', 'hidden')
    const restored = restorePanelPlacement(hidden, 'live')
    expect(restored.placement.live).toBe('bottom')
    expect(restored.right).toBeNull()
    expect(restored.bottom).toBeNull()
  })

  test('is a no-op for a panel that is not hidden', () => {
    const next = restorePanelPlacement(EMPTY_SLOT_LAYOUT, 'live')
    expect(next).toBe(EMPTY_SLOT_LAYOUT)
  })
})

describe('hidePanelPlacement', () => {
  test('is setPlacement(..., "hidden") by another name', () => {
    const a = hidePanelPlacement(EMPTY_SLOT_LAYOUT, 'skills')
    const b = setPlacement(EMPTY_SLOT_LAYOUT, 'skills', 'hidden')
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------------------------------
// PIN (narrow-overlay pass, spec §11) — isPanelPinned / setPanelPinned / togglePanelPinned,
// setPlacement clearing it on the way off the rail, and the pure click-outside/Esc decision.
// ---------------------------------------------------------------------------------------------

describe('PIN — nothing is pinned on a fresh layout', () => {
  test('every panel reads unpinned by default', () => {
    for (const id of PANEL_IDS) expect(isPanelPinned(EMPTY_SLOT_LAYOUT, id)).toBe(false)
  })
})

describe('setPanelPinned / togglePanelPinned', () => {
  test('sets exactly the named panel, leaving every other one untouched', () => {
    const next = setPanelPinned(EMPTY_SLOT_LAYOUT, 'live', true)
    expect(isPanelPinned(next, 'live')).toBe(true)
    for (const id of PANEL_IDS) {
      if (id !== 'live') expect(isPanelPinned(next, id)).toBe(false)
    }
  })

  test('is a no-op (same reference) when the value is already what was asked for', () => {
    const next = setPanelPinned(EMPTY_SLOT_LAYOUT, 'live', false)
    expect(next).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('togglePanelPinned flips whatever the current value is, twice returns to the start', () => {
    const once = togglePanelPinned(EMPTY_SLOT_LAYOUT, 'skills')
    expect(isPanelPinned(once, 'skills')).toBe(true)
    const twice = togglePanelPinned(once, 'skills')
    expect(isPanelPinned(twice, 'skills')).toBe(false)
  })
})

describe('setPlacement clears pin on the way OFF the rail (spec §11 item 5)', () => {
  test('moving a pinned rail panel to the bottom clears its pin', () => {
    const pinned = setPanelPinned(EMPTY_SLOT_LAYOUT, 'live', true)
    expect(pinned.placement.live).toBe('rail')
    const moved = setPlacement(pinned, 'live', 'bottom')
    expect(isPanelPinned(moved, 'live')).toBe(false)
  })

  test('hiding a pinned rail panel clears its pin too — it also leaves the rail', () => {
    const pinned = setPanelPinned(EMPTY_SLOT_LAYOUT, 'live', true)
    const hidden = setPlacement(pinned, 'live', 'hidden')
    expect(isPanelPinned(hidden, 'live')).toBe(false)
  })

  test('moving it BACK to the rail does NOT restore the pin (spec: "reseta o estado dela, inclusive se o usuario voltar ela pra direita ela n esta mais pinned")', () => {
    const pinned = setPanelPinned(EMPTY_SLOT_LAYOUT, 'live', true)
    const toBottom = setPlacement(pinned, 'live', 'bottom')
    const backToRail = setPlacement(toBottom, 'live', 'rail')
    expect(isPanelPinned(backToRail, 'live')).toBe(false)
  })

  test('moving an UNPINNED panel off the rail is a no-op on pin (nothing to clear)', () => {
    const moved = setPlacement(EMPTY_SLOT_LAYOUT, 'live', 'bottom')
    expect(isPanelPinned(moved, 'live')).toBe(false)
  })

  test('a panel that starts at the bottom (cli/shell) moving to the rail is never pinned by the move itself', () => {
    const moved = setPlacement(EMPTY_SLOT_LAYOUT, 'cli', 'rail')
    expect(isPanelPinned(moved, 'cli')).toBe(false)
  })

  test('pinning one panel never disturbs another panel’s placement, order or restoreTo', () => {
    const base = setPlacement(EMPTY_SLOT_LAYOUT, 'agents', 'bottom')
    const pinned = setPanelPinned(base, 'live', true)
    const moved = setPlacement(pinned, 'live', 'bottom')
    expect(moved.placement.agents).toBe('bottom') // untouched by an unrelated panel's move
  })

  // PLANTED-REVERT: a version of setPlacement that never clears pin at all would leave a panel
  // moved off the rail still reading pinned — exactly the "moving it back restores the pin" bug
  // item 5 forbids, one step earlier (it would not even need to come back to see it).
  test('[planted-revert coverage] a setPlacement that never clears pin leaves a moved-away panel still pinned', () => {
    function brokenSetPlacement(layout: SlotLayout, panel: PanelId, to: Placement): SlotLayout {
      // The OLD shape, before this pass — everything setPlacement does today, minus the pin clear.
      if (layout.placement[panel] === to) return layout
      return { ...layout, placement: { ...layout.placement, [panel]: to } }
    }
    const pinned = setPanelPinned(EMPTY_SLOT_LAYOUT, 'live', true)
    const broken = brokenSetPlacement(pinned, 'live', 'bottom')
    const correct = setPlacement(pinned, 'live', 'bottom')
    expect(isPanelPinned(broken, 'live')).not.toBe(isPanelPinned(correct, 'live'))
    expect(isPanelPinned(broken, 'live')).toBe(true) // wrongly kept
    expect(isPanelPinned(correct, 'live')).toBe(false) // correctly cleared
  })
})

describe('movePanel also clears pin — it routes through setPlacement', () => {
  test('movePanel(..., "bottom") on a pinned, currently-open rail panel clears the pin', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'skills')
    const pinned = setPanelPinned(shown, 'skills', true)
    const moved = movePanel(pinned, 'skills', 'bottom')
    expect(moved.bottom).toBe('skills') // the existing open-state-carries rule, untouched
    expect(isPanelPinned(moved, 'skills')).toBe(false)
  })
})

describe('overlayOutsideAction — the narrow-width overlay’s click-outside/Esc decision (spec §11 items 2-3)', () => {
  test('pinned wins outright, regardless of where the click landed', () => {
    expect(overlayOutsideAction({ pinned: true, insideOverlay: false, insideRail: false })).toBe('none')
    expect(overlayOutsideAction({ pinned: true, insideOverlay: true, insideRail: false })).toBe('none')
    expect(overlayOutsideAction({ pinned: true, insideOverlay: false, insideRail: true })).toBe('none')
  })

  test('unpinned: a click inside the overlay itself does nothing', () => {
    expect(overlayOutsideAction({ pinned: false, insideOverlay: true, insideRail: false })).toBe('none')
  })

  test('unpinned: a click on the rail does nothing — switching panels is not "clicking away"', () => {
    expect(overlayOutsideAction({ pinned: false, insideOverlay: false, insideRail: true })).toBe('none')
  })

  test('unpinned: a click that lands neither inside the overlay nor on the rail minimizes', () => {
    expect(overlayOutsideAction({ pinned: false, insideOverlay: false, insideRail: false })).toBe('minimize')
  })

  // PLANTED-REVERT: a version that checks `insideOverlay` alone (dropping the rail exemption) would
  // wrongly minimize on a rail click — exactly the "switching panels still works normally" rule
  // item 3 requires, and the regression a merged single-boolean shortcut would reintroduce.
  test('[planted-revert coverage] dropping the rail exemption wrongly minimizes on a rail click', () => {
    function brokenOverlayOutsideAction(
      { pinned, insideOverlay }: { pinned: boolean; insideOverlay: boolean; insideRail: boolean },
    ): 'minimize' | 'none' {
      if (pinned) return 'none'
      return insideOverlay ? 'none' : 'minimize' // rail exemption dropped
    }
    const onRail = { pinned: false, insideOverlay: false, insideRail: true }
    expect(brokenOverlayOutsideAction(onRail)).not.toBe(overlayOutsideAction(onRail))
    expect(brokenOverlayOutsideAction(onRail)).toBe('minimize') // wrongly minimizes
    expect(overlayOutsideAction(onRail)).toBe('none') // correctly leaves it alone
  })
})

describe('the imperative togglePinned', () => {
  beforeEach(() => resetPanelSlots())

  test('flips the stored layout’s pin and persists (a fresh getPanelLayout sees it)', () => {
    let notified = 0
    const unsub = subscribePanelLayout(() => { notified += 1 })
    togglePinned('live')
    expect(getPanelLayout().pinned.live).toBe(true)
    expect(notified).toBe(1)
    togglePinned('live')
    expect(getPanelLayout().pinned.live).toBe(false)
    unsub()
  })

  test('never asks — pinning discards no buffer, unlike closing/hiding the Studio', () => {
    // No `holdIfUnsaved` question is ever raised by this verb, even for the Studio.
    togglePinned('studio')
    expect(getPanelLayout().pinned.studio).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// readLayout persistence — the `pinned` field round-trips, migrates and degrades safely
// ---------------------------------------------------------------------------------------------

describe('readLayout — pinned', () => {
  test('a legacy (pre-rail) value has no pinned field at all and reads every panel as unpinned', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      right: null, bottom: null, bottomOpen: false, rightOpen: true,
      lastSlot: { contents: 'right', studio: 'right', cli: 'bottom', shell: 'bottom', hardware: 'right' },
    }))
    const layout = readLayout(s)
    for (const id of PANEL_IDS) expect(isPanelPinned(layout, id)).toBe(false)
  })

  test('a current-shape value with no pinned field (an older build of THIS shape) reads as unpinned — absent is NOT pinned', () => {
    const s = memory()
    const written = openPanel(EMPTY_SLOT_LAYOUT, 'live')
    const { pinned: _drop, ...withoutPinned } = written
    void _drop
    s.setItem('agentistics-panel-slots', JSON.stringify({ version: 2, ...withoutPinned }))
    const layout = readLayout(s)
    expect(isPanelPinned(layout, 'live')).toBe(false)
  })

  test('round-trips a pinned rail panel through write→read', () => {
    const s = memory()
    const written = setPanelPinned(openPanel(EMPTY_SLOT_LAYOUT, 'live'), 'live', true)
    s.setItem('agentistics-panel-slots', JSON.stringify({ version: 2, ...written }))
    expect(isPanelPinned(readLayout(s), 'live')).toBe(true)
  })

  test('a corrupt stored value pairing pinned:true with a NON-rail placement reads as unpinned — the placement is trusted, not the pin', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      version: 2,
      placement: { ...DEFAULT_PLACEMENT, live: 'bottom' },
      order: {}, restoreTo: {},
      pinned: { live: true },
      right: null, bottom: 'live', bottomOpen: true, rightOpen: true,
    }))
    const layout = readLayout(s)
    expect(layout.placement.live).toBe('bottom')
    expect(isPanelPinned(layout, 'live')).toBe(false)
  })

  test('a non-boolean pinned value for a panel is ignored, never throws', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      version: 2,
      placement: DEFAULT_PLACEMENT, order: {}, restoreTo: {},
      pinned: { live: 'yes', skills: 1, agents: null },
      right: null, bottom: null, bottomOpen: false, rightOpen: true,
    }))
    const layout = readLayout(s)
    for (const id of PANEL_IDS) expect(isPanelPinned(layout, id)).toBe(false)
  })
})

describe('reorderPlacement', () => {
  test('reorders panels within one placement to match the given sequence', () => {
    const rail = railPanels(EMPTY_SLOT_LAYOUT)
    const reversed = [...rail].reverse()
    const next = reorderPlacement(EMPTY_SLOT_LAYOUT, 'rail', reversed)
    expect(railPanels(next)).toEqual(reversed)
  })

  test('an id from the OTHER placement in the given sequence is ignored', () => {
    const next = reorderPlacement(EMPTY_SLOT_LAYOUT, 'bottom', ['shell', 'live', 'cli'])
    expect(bottomPanels(next)).toEqual(['shell', 'cli'])
  })

  test('never touches placement, only order', () => {
    const next = reorderPlacement(EMPTY_SLOT_LAYOUT, 'rail', [...railPanels(EMPTY_SLOT_LAYOUT)].reverse())
    expect(next.placement).toEqual(EMPTY_SLOT_LAYOUT.placement)
  })
})

describe('planPanelDrop — spec §3, drag', () => {
  test('same-bar drop on another panel reorders, matching reorderByDrag exactly', () => {
    const rail = railPanels(EMPTY_SLOT_LAYOUT) // ['live', 'gallery', 'skills', ...]
    const next = planPanelDrop(EMPTY_SLOT_LAYOUT, rail[0]!, { panel: rail[2]! })
    // live dragged onto skills: gallery moves ahead, live lands right before skills.
    expect(railPanels(next)).toEqual([rail[1]!, rail[0]!, rail[2]!, ...rail.slice(3)])
    // placement is untouched — a same-bar drop is a pure reorder.
    expect(next.placement).toEqual(EMPTY_SLOT_LAYOUT.placement)
  })

  test('dropping a panel on itself is a no-op', () => {
    const next = planPanelDrop(EMPTY_SLOT_LAYOUT, 'live', { panel: 'live' })
    expect(next).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('cross-bar drop of a CLOSED panel onto a specific panel MOVES and lands beside it, opening nothing (owner, 2026-09-21)', () => {
    // drag a rail panel (never opened) onto 'shell' (bottom) — relocates and positions, but a
    // closed panel dropped anywhere stays closed; see `movePanel`'s own header for the rule.
    const next = planPanelDrop(EMPTY_SLOT_LAYOUT, 'skills', { panel: 'shell' })
    expect(next.placement.skills).toBe('bottom')
    expect(next.bottom).toBeNull() // nothing was open at either end, so nothing opens now
    expect(bottomPanels(next)).toEqual(['cli', 'skills', 'shell']) // still positioned correctly
  })

  test('cross-bar drop of an OPEN panel onto a specific panel MOVES, OPENS, and lands beside it', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'skills') // right: skills
    const next = planPanelDrop(shown, 'skills', { panel: 'shell' })
    expect(next.placement.skills).toBe('bottom')
    expect(next.bottom).toBe('skills') // it WAS open, so it opens at the destination
    expect(next.right).toBeNull() // and the source (right) minimizes
    expect(bottomPanels(next)).toEqual(['cli', 'skills', 'shell'])
  })

  test('cross-bar drop onto bare placement space — CLOSED stays closed, still appended at the end', () => {
    const next = planPanelDrop(EMPTY_SLOT_LAYOUT, 'skills', { placement: 'bottom' })
    expect(next.placement.skills).toBe('bottom')
    expect(next.bottom).toBeNull()
    expect(bottomPanels(next)).toEqual(['cli', 'shell', 'skills'])
  })

  test('same-bar drop onto bare placement space is a no-op — no position was implied', () => {
    const next = planPanelDrop(EMPTY_SLOT_LAYOUT, 'live', { placement: 'rail' })
    expect(next).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('a HIDDEN, CLOSED panel dropped on a rail panel is placed and positioned, but stays closed', () => {
    const hidden = hidePanelPlacement(EMPTY_SLOT_LAYOUT, 'skills')
    const next = planPanelDrop(hidden, 'skills', { panel: 'live' })
    expect(next.placement.skills).toBe('rail')
    expect(next.right).toBeNull() // a hidden panel was never "open" — stays closed after the move
    const rail = railPanels(next)
    // still lands immediately before the panel it was dropped on, same as any cross-bar drop onto
    // a specific target — position is independent of whether it opens.
    expect(rail.indexOf('skills')).toBe(rail.indexOf('live') - 1)
  })

  test('restoreTo is refreshed by a cross-bar drop exactly as the gear’s move verb refreshes it', () => {
    const viaMove = movePanel(EMPTY_SLOT_LAYOUT, 'skills', 'bottom')
    const viaDrop = planPanelDrop(EMPTY_SLOT_LAYOUT, 'skills', { placement: 'bottom' })
    expect(viaDrop.restoreTo).toEqual(viaMove.restoreTo)
  })

  // PLANTED-REVERT: plant the class of bug this shares its arithmetic with (an index-based reorder
  // applied across bars, ignoring the target bar's OWN current order), confirm the tests above
  // distinguish it, then restore the file to its correct state.
  test('[planted-revert coverage] a drop is judged by the TARGET panel’s bar, not the dragged one’s', () => {
    // If planPanelDrop mistakenly reordered within the DRAGGED panel's own (rail) list instead of
    // the target's (bottom) list, 'skills' would never appear in bottomPanels at all.
    const next = planPanelDrop(EMPTY_SLOT_LAYOUT, 'skills', { panel: 'shell' })
    expect(bottomPanels(next)).toContain('skills')
    expect(railPanels(next)).not.toContain('skills')
  })

  // Pins the exact live scenario (rail-loose-ends, item 1): the bottom band already holds SEVERAL
  // panels — not just the two defaults — and a rail panel is dropped precisely on a tab in the
  // MIDDLE of that row. Reproduced live in a real browser (`bandControls.tsx`'s `useBandDropTarget`
  // now listens natively rather than through React's synthetic props — see that module's own
  // header — and `BandSegmentTab`'s own `onDrop` still stops propagation so a positioned drop is
  // never re-read by `PanelBar`'s own blank-space handler as a bare append): dragging a rail icon
  // onto an EXISTING middle tab landed it immediately before that tab, never at the row's end. This
  // is the pure arithmetic that outcome rests on — a regression here would silently turn every
  // positioned drop into a plain append even though the DOM wiring stayed correct.
  test('a rail panel dropped onto a tab in the MIDDLE of an already-crowded bottom row lands exactly there, not appended', () => {
    // Build a bottom row of five: cli, shell (defaults) + studio, live, gallery moved there first.
    let layout = movePanel(EMPTY_SLOT_LAYOUT, 'studio', 'bottom')
    layout = movePanel(layout, 'live', 'bottom')
    layout = movePanel(layout, 'gallery', 'bottom')
    expect(bottomPanels(layout)).toEqual(['cli', 'shell', 'studio', 'live', 'gallery'])

    // Drop a still-rail panel ('skills') precisely onto the middle tab ('studio').
    const next = planPanelDrop(layout, 'skills', { panel: 'studio' })
    expect(bottomPanels(next)).toEqual(['cli', 'shell', 'skills', 'studio', 'live', 'gallery'])
    expect(railPanels(next)).not.toContain('skills')
  })
})

describe('railClickAction — the rail is a launcher, the bottom bar is a tab strip', () => {
  test('clicking the panel that is already open, and active, minimizes it', () => {
    expect(railClickAction('skills', true, 'skills')).toBe('minimize')
  })

  test('clicking a DIFFERENT panel opens it, even while something else is open', () => {
    expect(railClickAction('skills', true, 'live')).toBe('open')
  })

  test('clicking the active panel while it is ALREADY minimized restores it — never a third state', () => {
    expect(railClickAction('skills', false, 'skills')).toBe('open')
  })

  test('clicking when nothing is open opens', () => {
    expect(railClickAction(null, false, 'live')).toBe('open')
  })

  // PLANTED-REVERT: a version that ignores `rightOpen` would minimize an already-minimized active
  // panel on a second click (a no-op read as a toggle), which is exactly the "third state" this
  // function's own header refuses.
  test('[planted-revert coverage] ignoring rightOpen would wrongly toggle a minimized active panel', () => {
    function brokenAction(active: PanelId | null, _rightOpen: boolean, panel: PanelId): 'open' | 'minimize' {
      return active === panel ? 'minimize' : 'open'
    }
    // active + minimized: correct answer is 'open' (restore); the broken version says 'minimize'.
    expect(brokenAction('skills', false, 'skills')).not.toBe(railClickAction('skills', false, 'skills'))
  })
})

describe('movePanel — a move carries the panel’s open state, it never creates one (owner, 2026-09-21)', () => {
  test('CLOSED → moved: relocates the placement, opens nothing, touches no occupant', () => {
    const withCli = openPanel(EMPTY_SLOT_LAYOUT, 'cli') // bottom is showing cli
    const moved = movePanel(withCli, 'skills', 'bottom') // skills was never opened
    expect(moved.placement.skills).toBe('bottom') // relocated
    expect(moved.bottom).toBe('cli') // cli is UNTOUCHED — skills never displaces it
    expect(isPanelShown(moved, 'skills')).toBe(false) // skills stays closed
  })

  test('OPEN → moved: reopens at the destination, displacing whatever was there', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'skills') // skills is the right slot's occupant
    const withCli = openPanel(shown, 'cli') // bottom now shows cli; skills is still open on the right
    const moved = movePanel(withCli, 'skills', 'bottom')
    expect(moved.placement.skills).toBe('bottom')
    expect(moved.bottom).toBe('skills') // opened at the destination, displacing cli
  })

  test('the SOURCE side MINIMIZES when the moved panel was the one showing there', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'skills') // right: skills, rightOpen: true
    const moved = movePanel(shown, 'skills', 'bottom')
    expect(moved.right).toBeNull()
    expect(moved.bottom).toBe('skills')
  })

  test('the BOTTOM band specifically ends up bottomOpen:false when its own occupant moves away', () => {
    const shown = openPanel(setPlacement(EMPTY_SLOT_LAYOUT, 'skills', 'bottom'), 'skills') // bottom: skills, bottomOpen: true
    expect(shown.bottomOpen).toBe(true)
    const moved = movePanel(shown, 'skills', 'rail')
    expect(moved.bottom).toBeNull()
    expect(moved.bottomOpen).toBe(false) // MINIMIZED, not left open-and-empty
  })

  test('the SOURCE side is UNTOUCHED when the moved panel was NOT the one showing there', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'agents') // agents occupies the right slot
    // skills is placed on the rail too, but is not the active occupant — moving it must not
    // disturb agents, which stays open exactly as it was.
    const moved = movePanel(shown, 'skills', 'bottom')
    expect(moved.right).toBe('agents') // untouched
    expect(moved.rightOpen).toBe(true)
    expect(isPanelShown(moved, 'skills')).toBe(false) // skills itself stays closed too
  })

  test('moving to the placement it is already in — CLOSED stays closed even so', () => {
    const next = movePanel(EMPTY_SLOT_LAYOUT, 'live', 'rail')
    expect(next.right).toBeNull()
    expect(isPanelShown(next, 'live')).toBe(false)
  })

  test('moving to the placement it is already in — OPEN stays open, unaffected', () => {
    const shown = openPanel(EMPTY_SLOT_LAYOUT, 'live')
    const next = movePanel(shown, 'live', 'rail')
    expect(next.right).toBe('live')
  })

  for (const to of OPEN_PLACEMENTS) {
    test(`move to ${to} refreshes restoreTo to match, whether or not the panel was open`, () => {
      const next = movePanel(EMPTY_SLOT_LAYOUT, 'skills', to)
      expect(next.restoreTo.skills).toBe(to)
    })
  }

  // PLANTED-REVERT: a version that always opens (the old rule) would displace an occupant a CLOSED
  // move must leave alone — the exact regression this whole describe block exists to catch.
  test('[planted-revert coverage] always opening on move displaces an untouched occupant', () => {
    function brokenMovePanel(layout: SlotLayout, panel: PanelId, to: OpenPlacement): SlotLayout {
      return openPanel(setPlacement(layout, panel, to), panel) // old rule: always opens
    }
    const withCli = openPanel(EMPTY_SLOT_LAYOUT, 'cli')
    const broken = brokenMovePanel(withCli, 'skills', 'bottom')
    const correct = movePanel(withCli, 'skills', 'bottom')
    expect(broken.bottom).not.toBe(correct.bottom)
    expect(broken.bottom).toBe('skills') // wrongly seized the slot
    expect(correct.bottom).toBe('cli') // correctly left alone
  })
})

// ---------------------------------------------------------------------------------------------
// openPanel / closePanel / isPanelShown / rightSlotShowing
// ---------------------------------------------------------------------------------------------

describe('openPanel', () => {
  test('opens a rail-placed panel into the right slot', () => {
    const next = openPanel(EMPTY_SLOT_LAYOUT, 'skills')
    expect(next.right).toBe('skills')
    expect(next.rightOpen).toBe(true)
  })

  test('opens a bottom-placed panel into the bottom slot', () => {
    const next = openPanel(EMPTY_SLOT_LAYOUT, 'cli')
    expect(next.bottom).toBe('cli')
    expect(next.bottomOpen).toBe(true)
  })

  test('is REFUSED for a hidden panel — no icon or tab to have clicked', () => {
    const hidden = setPlacement(EMPTY_SLOT_LAYOUT, 'skills', 'hidden')
    const next = openPanel(hidden, 'skills')
    expect(next).toBe(hidden)
    expect(next.right).toBeNull()
  })

  test('opening a second rail panel displaces the first, never both at once', () => {
    const first = openPanel(EMPTY_SLOT_LAYOUT, 'skills')
    const second = openPanel(first, 'gallery')
    expect(second.right).toBe('gallery')
    expect(isPanelShown(second, 'skills')).toBe(false)
  })

  test('opening a rail panel never touches the bottom occupant, and vice versa', () => {
    const withCli = openPanel(EMPTY_SLOT_LAYOUT, 'cli')
    const withSkills = openPanel(withCli, 'skills')
    expect(withSkills.bottom).toBe('cli')
    expect(withSkills.right).toBe('skills')
  })
})

describe('closePanel / isPanelShown', () => {
  test('closes the active occupant, placement untouched', () => {
    const opened = openPanel(EMPTY_SLOT_LAYOUT, 'skills')
    const closed = closePanel(opened, 'skills')
    expect(closed.right).toBeNull()
    expect(closed.placement.skills).toBe('rail')
  })

  test('is a no-op for a panel that is not shown', () => {
    const next = closePanel(EMPTY_SLOT_LAYOUT, 'skills')
    expect(next).toBe(EMPTY_SLOT_LAYOUT)
  })

  test('isPanelShown reads true for a collapsed-but-occupying bottom panel', () => {
    const opened = setBottomOpen(openPanel(EMPTY_SLOT_LAYOUT, 'cli'), false)
    expect(isPanelShown(opened, 'cli')).toBe(true)
  })
})

describe('rightSlotShowing', () => {
  test('is a plain read of layout.right — every panel carries its own field now', () => {
    expect(rightSlotShowing(EMPTY_SLOT_LAYOUT)).toBeNull()
    expect(rightSlotShowing(openPanel(EMPTY_SLOT_LAYOUT, 'metrics'))).toBe('metrics')
  })
})

describe('setBottomOpen / setRightOpen', () => {
  test('toggle without touching the occupant', () => {
    const opened = openPanel(EMPTY_SLOT_LAYOUT, 'cli')
    const collapsed = setBottomOpen(opened, false)
    expect(collapsed.bottom).toBe('cli')
    expect(collapsed.bottomOpen).toBe(false)
  })

  test('are no-ops (same reference) when already at that value', () => {
    expect(setBottomOpen(EMPTY_SLOT_LAYOUT, false)).toBe(EMPTY_SLOT_LAYOUT)
    expect(setRightOpen(EMPTY_SLOT_LAYOUT, true)).toBe(EMPTY_SLOT_LAYOUT)
  })
})

// ---------------------------------------------------------------------------------------------
// resolveForViewport / resolveForGates
// ---------------------------------------------------------------------------------------------

describe('resolveForViewport', () => {
  test('desktop: untouched', () => {
    const layout = openPanel(EMPTY_SLOT_LAYOUT, 'skills')
    expect(resolveForViewport(layout, false)).toBe(layout)
  })

  test('mobile: a bottom-only panel reads as the right sheet instead', () => {
    const layout = openPanel(setPlacement(EMPTY_SLOT_LAYOUT, 'skills', 'bottom'), 'skills')
    const mobile = resolveForViewport(layout, true)
    expect(mobile.right).toBe('skills')
    expect(mobile.bottom).toBeNull()
    expect(mobile.rightOpen).toBe(true)
  })

  test('mobile: cli/shell are exempt — SessionPanel draws its own toggle for them', () => {
    const layout = openPanel(EMPTY_SLOT_LAYOUT, 'cli')
    expect(resolveForViewport(layout, true)).toBe(layout)
  })

  /**
   * LIVE BUG, FOUND VERIFYING THE MOBILE SWITCHER: with `bottom` holding a non-cli/shell panel
   * (e.g. `studio`, moved there by the gear, or carried over from a migrated layout) and NOTHING on
   * `right` yet, the fold correctly opens it as the sheet — but the mobile switcher's own click only
   * ever writes `right` (`SessionsPage.tsx`'s `openSlotPanel`, which never touches `bottom`), so
   * without this guard the NEXT render folded `bottom` straight back over whatever was just picked.
   * Measured live: tapping "Skills" while `bottom` held `studio` left the panel on Studio forever —
   * the switcher was reachable but inert.
   */
  test('mobile: once something real sits on the right, the fold stops overriding it', () => {
    const layout = openPanel(setPlacement(EMPTY_SLOT_LAYOUT, 'studio', 'bottom'), 'studio')
    const firstFold = resolveForViewport(layout, true)
    expect(firstFold.right).toBe('studio') // the fold's own first-time behaviour, unchanged

    // The reader picks something else from the mobile switcher — writes RAW `right` only.
    const picked = openPanel(layout, 'skills')
    expect(picked.bottom).toBe('studio') // untouched — the switcher never writes `bottom`
    const resolved = resolveForViewport(picked, true)
    expect(resolved.right).toBe('skills') // the pick wins, not another fold of `bottom`
  })

  test('mobile: nothing at the bottom is untouched', () => {
    expect(resolveForViewport(EMPTY_SLOT_LAYOUT, true)).toBe(EMPTY_SLOT_LAYOUT)
  })
})

describe('resolveForGates', () => {
  const OPEN: PanelGates = { editorEnabled: true, shellEnabled: true, relayed: false }

  test('every panel stays when every gate is open', () => {
    const layout = openPanel(openPanel(EMPTY_SLOT_LAYOUT, 'studio'), 'shell')
    expect(resolveForGates(layout, OPEN)).toBe(layout)
  })

  test('a shown studio closes when editorEnabled is false', () => {
    const layout = openPanel(EMPTY_SLOT_LAYOUT, 'studio')
    const gated = resolveForGates(layout, { ...OPEN, editorEnabled: false })
    expect(gated.right).toBeNull()
  })

  test('cli/shell close when relayed', () => {
    const layout = openPanel(EMPTY_SLOT_LAYOUT, 'cli')
    const gated = resolveForGates(layout, { ...OPEN, relayed: true })
    expect(gated.bottom).toBeNull()
  })

  test('the ten former Contents tabs and hardware carry no gate of their own', () => {
    const layout = openPanel(EMPTY_SLOT_LAYOUT, 'metrics')
    const gated = resolveForGates(layout, { editorEnabled: false, shellEnabled: false, relayed: true })
    expect(gated.right).toBe('metrics')
  })
})

// ---------------------------------------------------------------------------------------------
// Migration — readLayout
// ---------------------------------------------------------------------------------------------

describe('readLayout — a fresh machine', () => {
  test('no stored value at all reads as the plain defaults', () => {
    expect(readLayout(memory())).toEqual(EMPTY_SLOT_LAYOUT)
  })
})

describe('readLayout — unreadable or unrecognisable storage', () => {
  test('non-JSON never throws, reads as defaults', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', 'not json at all {{{')
    expect(readLayout(s)).toEqual(EMPTY_SLOT_LAYOUT)
  })

  test('a bare JSON primitive (not an object) reads as defaults', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', '42')
    expect(readLayout(s)).toEqual(EMPTY_SLOT_LAYOUT)
  })

  test('a storage whose getItem throws reads as defaults, never propagates', () => {
    const s = {
      getItem: () => { throw new Error('blocked') },
    } as unknown as Storage
    expect(readLayout(s)).toEqual(EMPTY_SLOT_LAYOUT)
  })

  test('a value "from a future version" — unknown top-level fields, a placement id this build does not know — degrades to known fields rather than throwing', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      version: 99,
      placement: { ...DEFAULT_PLACEMENT, skills: 'bottom', someFuturePanel: 'rail' },
      order: { skills: 3 },
      restoreTo: { skills: 'bottom' },
      right: 'someFuturePanel',
      bottom: 'skills',
      bottomOpen: true,
      rightOpen: true,
      aBrandNewField: { nested: true },
    }))
    const layout = readLayout(s)
    expect(layout.placement.skills).toBe('bottom')
    // the unknown id is simply not a PanelId — never adopted as an occupant or a placement key
    expect(layout.right).toBeNull()
    expect(layout.bottom).toBe('skills')
    expect(layout.order.skills).toBe(3)
  })
})

describe('readLayout — migrating the OLD (pre-rail) shape', () => {
  test('a bare fresh-defaults-shaped legacy value (nothing ever opened) still reads as today’s defaults', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      right: null, bottom: null, bottomOpen: false, rightOpen: true,
      lastSlot: {
        contents: 'right', studio: 'right', cli: 'bottom', shell: 'bottom', hardware: 'right',
      },
    }))
    const layout = readLayout(s)
    expect(layout.placement).toEqual(DEFAULT_PLACEMENT)
    expect(layout.right).toBeNull()
    expect(layout.bottom).toBeNull()
  })

  test('studio parked at the bottom under the old model stays at the bottom under the new one', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      right: null, bottom: 'studio', bottomOpen: true, rightOpen: true,
      lastSlot: { contents: 'right', studio: 'bottom', cli: 'bottom', shell: 'bottom', hardware: 'right' },
    }))
    const layout = readLayout(s)
    expect(layout.placement.studio).toBe('bottom')
    expect(layout.bottom).toBe('studio')
    expect(layout.bottomOpen).toBe(true)
  })

  test('"contents" open on the RIGHT migrates to its ten descendants placed on the rail, opened on "live"', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      right: 'contents', bottom: null, bottomOpen: false, rightOpen: true,
      lastSlot: { contents: 'right', studio: 'right', cli: 'bottom', shell: 'bottom', hardware: 'right' },
    }))
    const layout = readLayout(s)
    for (const id of ['live', 'gallery', 'skills', 'agents', 'forks', 'workflows', 'mcps', 'prs', 'tasks', 'metrics'] as const) {
      expect(layout.placement[id]).toBe('rail')
    }
    expect(layout.right).toBe('live')
  })

  test('"contents" DOCKED AT THE BOTTOM still places its ten descendants on the RAIL, not the bottom — the spec’s own rule, not "wherever contents was"', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      right: null, bottom: 'contents', bottomOpen: true, rightOpen: true,
      lastSlot: { contents: 'bottom', studio: 'right', cli: 'bottom', shell: 'bottom', hardware: 'right' },
    }))
    const layout = readLayout(s)
    for (const id of ['live', 'gallery', 'skills', 'agents', 'forks', 'workflows', 'mcps', 'prs', 'tasks', 'metrics'] as const) {
      expect(layout.placement[id]).toBe('rail')
    }
    expect(layout.bottom).toBe('live')
  })

  test('hardware on the right, shell at the bottom — both preserved', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({
      right: 'hardware', bottom: 'shell', bottomOpen: true, rightOpen: true,
      lastSlot: { contents: 'right', studio: 'right', cli: 'bottom', shell: 'bottom', hardware: 'right' },
    }))
    const layout = readLayout(s)
    expect(layout.placement.hardware).toBe('rail')
    expect(layout.right).toBe('hardware')
    expect(layout.placement.shell).toBe('bottom')
    expect(layout.bottom).toBe('shell')
  })

  test('migration never throws on a legacy value missing lastSlot entirely', () => {
    const s = memory()
    s.setItem('agentistics-panel-slots', JSON.stringify({ right: 'studio', bottom: null }))
    const layout = readLayout(s)
    expect(layout.right).toBe('studio')
    expect(layout.placement.studio).toBe('rail')
  })
})

describe('readLayout — round-trips every PANEL_IDS member through write→read', () => {
  for (const id of PANEL_IDS) {
    test(`${id} on the rail`, () => {
      const s = memory()
      // `openPanel` after `setPlacement`, not `movePanel` — this test is about STORAGE
      // round-tripping an OPEN occupant, not about move semantics (`movePanel` no longer opens a
      // panel that was not already shown — see its own header).
      const written = openPanel(setPlacement(EMPTY_SLOT_LAYOUT, id, 'rail'), id)
      s.setItem('agentistics-panel-slots', JSON.stringify({ version: 2, ...written }))
      expect(readLayout(s).right).toBe(id)
    })

    test(`${id} at the bottom`, () => {
      const s = memory()
      const written = openPanel(setPlacement(EMPTY_SLOT_LAYOUT, id, 'bottom'), id)
      s.setItem('agentistics-panel-slots', JSON.stringify({ version: 2, ...written }))
      expect(readLayout(s).bottom).toBe(id)
    })

    test(`${id} hidden — round-trips its placement and restoreTo`, () => {
      const s = memory()
      const written = hidePanelPlacement(EMPTY_SLOT_LAYOUT, id)
      s.setItem('agentistics-panel-slots', JSON.stringify({ version: 2, ...written }))
      const read = readLayout(s)
      expect(read.placement[id]).toBe('hidden')
      expect(read.restoreTo[id]).toBe(written.restoreTo[id])
    })
  }
})

// ---------------------------------------------------------------------------------------------
// The imperative store — showPanel / hidePanel / relocatePanel / the unsaved-Studio hold
// ---------------------------------------------------------------------------------------------

describe('the imperative store', () => {
  beforeEach(() => { resetPanelSlots(); resetUnsaved() })

  test('showPanel opens and persists; a fresh getPanelLayout/subscribe pair see it', () => {
    let notified = 0
    const unsub = subscribePanelLayout(() => { notified += 1 })
    showPanel('skills')
    expect(getPanelLayout().right).toBe('skills')
    expect(notified).toBe(1)
    unsub()
  })

  test('showPanel over an already-open Studio with unsaved buffers HOLDS, asking first', () => {
    showPanel('studio')
    reportUnsaved('studio', ['a.ts'])
    showPanel('skills') // would displace the dirty Studio
    expect(getPanelLayout().right).toBe('studio') // not yet displaced
    expect(getUnsaved().question?.cause).toBe('close')
    answerUnsaved(true) // discard
    expect(getPanelLayout().right).toBe('skills')
  })

  test('showPanel moving the Studio to another slot never asks — it stays shown throughout', () => {
    showPanel('studio')
    reportUnsaved('studio', ['a.ts'])
    relocatePanel('studio', 'bottom')
    expect(getPanelLayout().bottom).toBe('studio')
    expect(getUnsaved().question).toBeNull()
  })

  test('hidePanel on the Studio with unsaved buffers holds; "keep editing" leaves it shown', () => {
    showPanel('studio')
    reportUnsaved('studio', ['a.ts'])
    let afterRan = false
    hidePanel('studio', () => { afterRan = true })
    expect(getPanelLayout().right).toBe('studio')
    expect(afterRan).toBe(false)
    answerUnsaved(false) // keep editing
    expect(getPanelLayout().right).toBe('studio')
    expect(afterRan).toBe(false)
  })

  test('relocatePanel moves and opens at the destination', () => {
    showPanel('live')
    relocatePanel('live', 'bottom')
    expect(getPanelLayout().bottom).toBe('live')
    expect(getPanelLayout().placement.live).toBe('bottom')
  })

  test('setBandOpen / setSlotRightOpen toggle the persisted layout', () => {
    showPanel('cli')
    setBandOpen(false)
    expect(getPanelLayout().bottomOpen).toBe(false)
    setSlotRightOpen(false)
    expect(getPanelLayout().rightOpen).toBe(false)
  })
})
