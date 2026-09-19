import { describe, expect, it } from 'bun:test'
import {
  artifactsPanelMax, ASIDE_DRAG_CENTRE_MIN, edgeHint, PANEL_MIN_WIDTH, resolveArtifactLayout,
} from './artifactLayout'

const at = (o: Partial<Parameters<typeof resolveArtifactLayout>[0]>) =>
  resolveArtifactLayout({ open: true, width: 1440, isMobile: false, listExpandedByUser: false, ...o })

describe('resolveArtifactLayout', () => {
  it('is closed when it is closed, and asks for no collapse', () => {
    expect(at({ open: false })).toEqual({ layout: 'closed', collapseList: false })
  })

  it('opens split and collapses the fleet list to the rail', () => {
    expect(at({})).toEqual({ layout: 'split-rail', collapseList: true })
  })

  it('KEEPS the list when the user expanded it themselves — their choice wins', () => {
    expect(at({ listExpandedByUser: true })).toEqual({ layout: 'split', collapseList: false })
  })

  it('becomes an overlay below the three-column floor, whatever the user chose', () => {
    expect(at({ width: 1000 })).toEqual({ layout: 'overlay', collapseList: false })
    expect(at({ width: 1000, listExpandedByUser: true }))
      .toEqual({ layout: 'overlay', collapseList: false })
  })

  it('is full-screen on mobile, at any width', () => {
    expect(at({ isMobile: true })).toEqual({ layout: 'fullscreen', collapseList: false })
    expect(at({ isMobile: true, width: 1440 })).toEqual({ layout: 'fullscreen', collapseList: false })
  })

  it('never asks to collapse the list in a layout that does not use the rail', () => {
    for (const o of [{ width: 1000 }, { isMobile: true }, { open: false }]) {
      expect(at(o).collapseList, JSON.stringify(o)).toBe(false)
    }
  })
})


describe('edgeHint', () => {
  const running = [
    { kind: 'read' as const, text: 'a.ts', live: true },
    { kind: 'wrote' as const, text: 'b.ts', live: true },
  ]

  it('names the LAST thing in flight — a verb tells you whether you care, a count does not', () => {
    expect(edgeHint({ open: false, events: running, isMobile: false }))
      .toEqual({ kind: 'wrote', text: 'b.ts' })
  })

  it('says nothing while the panel is open — it is already saying this, in full', () => {
    expect(edgeHint({ open: true, events: running, isMobile: false })).toBeNull()
  })

  it('says nothing on a phone, where the panel would cover what is being read', () => {
    expect(edgeHint({ open: false, events: running, isMobile: true })).toBeNull()
  })

  it('FINISHED actions are history and belong in the panel, not on the edge', () => {
    const done = [{ kind: 'wrote' as const, text: 'b.ts' }]
    expect(edgeHint({ open: false, events: done, isMobile: false })).toBeNull()
    expect(edgeHint({ open: false, events: [], isMobile: false })).toBeNull()
  })
})

describe('the edge hint carries the step it names', () => {
  // The strip NAMES what is happening; pressing it should land on that row, opened. So the step
  // travels with it — see `EdgeHint.ref`.
  it('carries the step of the action it names', () => {
    expect(edgeHint({
      open: false, isMobile: false,
      events: [
        { kind: 'read', text: 'a.ts', live: false, ref: 'old' },
        { kind: 'ran', text: 'bun test', live: true, ref: 'toolu_9' },
      ],
    })).toEqual({ kind: 'ran', text: 'bun test', ref: 'toolu_9' })
  })

  // `undefined` means "open the feed"; `''` would name a step that is not there, and the two must
  // not read the same downstream.
  it('omits the ref entirely when the event has none', () => {
    const h = edgeHint({
      open: false, isMobile: false,
      events: [{ kind: 'thought', text: 'weighing two options', live: true }],
    })
    expect(h).toEqual({ kind: 'thought', text: 'weighing two options' })
    expect(h && 'ref' in h).toBe(false)
  })

  it('does not carry an empty ref either', () => {
    const h = edgeHint({
      open: false, isMobile: false,
      events: [{ kind: 'ran', text: 'ls', live: true, ref: '' }],
    })
    expect(h && 'ref' in h).toBe(false)
  })
})

// item 6 — the right aside's own drag cap, raised from a flat 900px to the room the viewport
// actually has, always leaving `ASIDE_DRAG_CENTRE_MIN` for the centre column.
describe('artifactsPanelMax', () => {
  it('on an ordinary 1440px screen, the cap is far past the old flat 900px', () => {
    expect(artifactsPanelMax(1440)).toBe(1440 - ASIDE_DRAG_CENTRE_MIN)
    expect(artifactsPanelMax(1440)).toBeGreaterThan(900)
  })

  it('on a wide monitor, the cap grows with it — never stuck at a fixed number', () => {
    expect(artifactsPanelMax(2560)).toBe(2560 - ASIDE_DRAG_CENTRE_MIN)
    expect(artifactsPanelMax(3840)).toBeGreaterThan(artifactsPanelMax(2560))
  })

  it('always leaves exactly the centre floor clear, never less', () => {
    const viewport = 1920
    expect(viewport - artifactsPanelMax(viewport)).toBe(ASIDE_DRAG_CENTRE_MIN)
  })

  it('a viewport too narrow for both figures still returns a usable floor, never negative', () => {
    expect(artifactsPanelMax(500)).toBe(PANEL_MIN_WIDTH)
    expect(artifactsPanelMax(0)).toBe(PANEL_MIN_WIDTH)
  })

  it('an unmeasured or nonsense viewport is the same safe floor', () => {
    expect(artifactsPanelMax(Number.NaN)).toBe(PANEL_MIN_WIDTH)
    expect(artifactsPanelMax(-100)).toBe(PANEL_MIN_WIDTH)
  })
})
