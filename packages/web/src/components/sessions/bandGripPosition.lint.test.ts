/**
 * bandGripPosition.lint.test.ts — THE GRIP IS ALWAYS THE BAND'S FIRST CHILD, ABOVE THE TAB ROW, IN
 * EVERY PANEL.
 *
 * Owner report: "dependendo da aba q eu to o item de indicacao de reposicionamento muda de lugar,
 * ele deveria estar SEMPRE no topo, na borda superior da barra inferior." Measured from the
 * screenshots: with Conteúdo/Hardware selected (`SimpleDockedBand`) and with Studio selected
 * (`StudioBand`), the grip sat ONE ROW BELOW the tab row, level with the toolbar — because each band
 * rendered its own copy of the `role="separator"` markup as the bar row's SIBLING, placed AFTER it.
 * `ShellBand`'s own docked branch (Claude Code / Shell) never had this bug: its handle was already
 * the root's first child, above the bar.
 *
 * THE FIX IS STRUCTURAL, not three copies that happen to agree: `bandControls.tsx` exports ONE
 * `BandResizeHandle` (the markup) and ONE `useBandDrag` (the drag state machine) — see their own
 * headers — and all three bands now import and render `BandResizeHandle` before their own bar row.
 * STILL DUPLICATED, by design and stated in the fix's own report: each band still owns its ROOT
 * div's own chrome (the border, the height/fullscreen sizing, the bar row itself) — only the top
 * edge and its drag machinery are shared. A full extraction of the whole band shell was judged too
 * large for this change.
 *
 * Not reachable by rendering: none of `StudioBand`/`SimpleDockedBand` is exported (there is no seam
 * to mount them through — see `sessionPanel.lint.test.ts`'s own header for the same fact), and this
 * package has no jsdom regardless. `ShellBand` IS exported, but mounting its desktop branch needs a
 * live `usePanelSlots`/`useTerminalStream`/`useDocumentVisible` stack this package has no harness
 * for. So the SHAPE is what is asserted, over comment-free source — the same approach
 * `sessionPanel.lint.test.ts` and every other `*.lint.test.ts` in this package already takes — with
 * a planted reversion proving the scan still sees the bug this pins.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const BAND_CONTROLS_RAW = readFileSync(join(import.meta.dir, 'bandControls.tsx'), 'utf-8')
const BAND_CONTROLS_SRC = stripComments(BAND_CONTROLS_RAW)
const SESSION_PANEL_RAW = readFileSync(join(import.meta.dir, 'SessionPanel.tsx'), 'utf-8')
const SESSION_PANEL_SRC = stripComments(SESSION_PANEL_RAW)
const SHELL_BAND_RAW = readFileSync(join(import.meta.dir, 'ShellBand.tsx'), 'utf-8')
const SHELL_BAND_SRC = stripComments(SHELL_BAND_RAW)

describe('BandResizeHandle — defined exactly once, and exported for the three bands to share', () => {
  test('bandControls.tsx defines it exactly once', () => {
    expect(BAND_CONTROLS_SRC.match(/function BandResizeHandle\(/g)?.length).toBe(1)
    expect(BAND_CONTROLS_SRC).toContain('export function BandResizeHandle(')
  })

  test('no OTHER band component in this package defines its own copy', () => {
    // The bug this fix closes was exactly this: a second (and third) hand-rolled `role="separator"`
    // drag handle, each agreeing with `bandControls.tsx`'s only by coincidence. A `function
    // BandResizeHandle(` appearing anywhere else would be that regression returning.
    expect(SESSION_PANEL_SRC).not.toContain('function BandResizeHandle(')
    expect(SHELL_BAND_SRC).not.toContain('function BandResizeHandle(')
  })

  test('SessionPanel.tsx and ShellBand.tsx both import it from the shared module', () => {
    expect(SESSION_PANEL_SRC).toMatch(/BandResizeHandle[^;]*\}\s*from '\.\/bandControls'/)
    expect(SHELL_BAND_SRC).toMatch(/BandResizeHandle[^;]*\}\s*from '\.\/bandControls'/)
  })
})

describe('useBandDrag — the one drag state machine, shared the same way', () => {
  test('defined exactly once, exported', () => {
    expect(BAND_CONTROLS_SRC.match(/function useBandDrag\(/g)?.length).toBe(1)
    expect(BAND_CONTROLS_SRC).toContain('export function useBandDrag(')
  })

  test('both callers import it rather than tracking their own dragRef/mousemove listeners', () => {
    expect(SESSION_PANEL_SRC).toMatch(/useBandDrag[^;]*\}\s*from '\.\/bandControls'/)
    expect(SHELL_BAND_SRC).toMatch(/useBandDrag[^;]*\}\s*from '\.\/bandControls'/)
    // The regression this guards: a hand-rolled `addEventListener('mousemove', …)` back inside
    // either file instead of going through the shared hook.
    expect(SESSION_PANEL_SRC).not.toContain("addEventListener('mousemove'")
    expect(SHELL_BAND_SRC).not.toContain("addEventListener('mousemove'")
  })
})

/** Slices one band's own function body out of `SessionPanel.tsx`, comments already stripped. */
function bandBody(name: 'StudioBand' | 'SimpleDockedBand'): string {
  const start = SESSION_PANEL_SRC.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const nextFn = SESSION_PANEL_SRC.indexOf('\nfunction ', start + 1)
  expect(nextFn).toBeGreaterThan(start)
  return SESSION_PANEL_SRC.slice(start, nextFn)
}

/**
 * THE POSITION RULE ITSELF: within each band's own render, `<BandResizeHandle` (the grip) appears
 * BEFORE `ref={barWidthRef}` (the bar row that measures its own width) — i.e. the grip is the root's
 * first rendered child, above the tab row, never its sibling placed after it.
 */
describe('the grip renders BEFORE the bar row, in every band — Studio, Contents/Hardware, Claude Code/Shell', () => {
  test('StudioBand', () => {
    const body = bandBody('StudioBand')
    const gripAt = body.indexOf('<BandResizeHandle')
    const barAt = body.indexOf('ref={barWidthRef}')
    expect(gripAt).toBeGreaterThan(-1)
    expect(barAt).toBeGreaterThan(-1)
    expect(gripAt).toBeLessThan(barAt)
  })

  test('SimpleDockedBand — the ONE component behind both Contents and Hardware', () => {
    const body = bandBody('SimpleDockedBand')
    const gripAt = body.indexOf('<BandResizeHandle')
    const barAt = body.indexOf('ref={barWidthRef}')
    expect(gripAt).toBeGreaterThan(-1)
    expect(barAt).toBeGreaterThan(-1)
    expect(gripAt).toBeLessThan(barAt)
  })

  test('ShellBand\'s docked branch — Claude Code and Shell, the one panel pair that was already correct', () => {
    // `<BandResizeHandle` and `ref={barWidthRef}` each occur exactly ONCE in the whole file — the
    // `dedicated`/`aside`/mobile branches carry neither (see the module header: no bar, no drag
    // handle there at all) — so no per-branch slicing is needed the way `SessionPanel.tsx` needs it.
    expect(SHELL_BAND_SRC.match(/<BandResizeHandle/g)?.length).toBe(1)
    expect(SHELL_BAND_SRC.match(/ref=\{barWidthRef\}/g)?.length).toBe(1)
    const gripAt = SHELL_BAND_SRC.indexOf('<BandResizeHandle')
    const barAt = SHELL_BAND_SRC.indexOf('ref={barWidthRef}')
    expect(gripAt).toBeLessThan(barAt)
  })
})

/**
 * GATING: the grip is drawn only while there is something to resize.
 *
 * UPDATED for the floating-panels redesign (`sdd/brief.md`): the band is now its OWN panel, and the
 * gap between it and the conversation panel above it must stay PRESENT even while the band is
 * collapsed (two panels with no gap between them would touch) — only the DRAG becomes a no-op. So
 * the JSX condition around `<BandResizeHandle>` narrowed to `{!fullscreen && (` (StudioBand /
 * SimpleDockedBand — never drawn in true full screen, where there is nothing left to negotiate a
 * height for) or dropped entirely (ShellBand's docked branch, which has no in-place fullscreen at
 * all — it NAVIGATES to a dedicated screen instead), and `open` moved INTO the spread: the handle
 * gets the real drag handlers while open, and inert no-op ones while collapsed.
 */
describe('the grip is gated on open (and, where relevant, not-fullscreen) — never drawn collapsed', () => {
  test('StudioBand: `{!fullscreen && (` precedes the grip, and `open` picks real handlers vs. no-ops', () => {
    const body = bandBody('StudioBand')
    const gateAt = body.indexOf('{!fullscreen && (')
    const gripAt = body.indexOf('<BandResizeHandle')
    expect(gateAt).toBeGreaterThan(-1)
    expect(gripAt).toBeGreaterThan(gateAt)
    // Nothing but whitespace/JSX punctuation between the gate opening and the grip itself — no
    // stray element sneaks in ahead of it.
    expect(body.slice(gateAt + '{!fullscreen && ('.length, gripAt).trim()).toBe('')
    expect(body).toContain(
      "{...(open ? grip : { onMouseDown: () => {}, onTouchStart: () => {}, onKeyDown: () => {} })}",
    )
  })

  test('SimpleDockedBand: `{!fullscreen && (` precedes the grip, and `open` picks real handlers vs. no-ops', () => {
    const body = bandBody('SimpleDockedBand')
    const gateAt = body.indexOf('{!fullscreen && (')
    const gripAt = body.indexOf('<BandResizeHandle')
    expect(gateAt).toBeGreaterThan(-1)
    expect(gripAt).toBeGreaterThan(gateAt)
    expect(body.slice(gateAt + '{!fullscreen && ('.length, gripAt).trim()).toBe('')
    expect(body).toContain(
      "{...(open ? grip : { onMouseDown: () => {}, onTouchStart: () => {}, onKeyDown: () => {} })}",
    )
  })

  test('ShellBand: always rendered (no in-place fullscreen to skip it for), `prefs.open` picks real handlers vs. no-ops', () => {
    expect(SHELL_BAND_SRC).toContain(
      "{...(prefs.open ? grip : { onMouseDown: () => {}, onTouchStart: () => {}, onKeyDown: () => {} })}",
    )
    const gripAt = SHELL_BAND_SRC.indexOf('<BandResizeHandle')
    const gateAt = SHELL_BAND_SRC.indexOf('prefs.open ? grip')
    expect(gripAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(gripAt)
  })
})

/**
 * PLANTED REVERSION — proves the position test above actually distinguishes right from wrong,
 * rather than passing on any input. Reconstructs the EXACT broken shape this fix replaces (grip
 * after the bar row, inside `{open && (…)}`) as a string and confirms it would have FAILED the same
 * assertion `StudioBand`'s own test makes.
 */
describe('the scan still catches the original bug if it comes back', () => {
  test('grip-after-bar reads as broken by the same rule that reads grip-before-bar as fixed', () => {
    const reverted = [
      'function StudioBand({',
      '  const [barWidthRef] = useElementWidth()',
      '  return (',
      '    <div style={{}}>',
      '      <div',
      '        ref={barWidthRef}',
      '      >',
      '        {taskControl}',
      '      </div>',
      '      {open && (',
      '        <>',
      '          {!fullscreen && (',
      '            <BandResizeHandle label="x" onMouseDown={() => {}} onTouchStart={() => {}} onKeyDown={() => {}} />',
      '          )}',
      '          <div ref={contentRef} />',
      '        </>',
      '      )}',
      '    </div>',
      '  )',
      '}',
    ].join('\n')
    const gripAt = reverted.indexOf('<BandResizeHandle')
    const barAt = reverted.indexOf('ref={barWidthRef}')
    expect(gripAt).toBeGreaterThan(-1)
    expect(barAt).toBeGreaterThan(-1)
    // The exact opposite of what the real source must satisfy above.
    expect(gripAt).toBeGreaterThan(barAt)
  })
})
