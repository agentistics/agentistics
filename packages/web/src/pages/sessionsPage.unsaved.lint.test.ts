/**
 * THE PAGE THAT DROPS THE STUDIO ASKS BEFORE IT DOES — asserted at the level that broke.
 *
 * `ArtifactsAside.gate.lint.test.ts` pins that nothing INSIDE the panel can unmount the Studio, and
 * that is exactly why the loss one level out went unnoticed: `SessionsPage` unmounts the whole pane
 * (`artShell === 'none'`) when the panel closes and when the page navigates away, and with autosave
 * off by default that dropped every unsaved buffer with no prompt. The pure halves are tested in
 * `lib/unsavedBuffers.test.ts`, `lib/unsavedLeave.test.ts` and `lib/artifactsStore.test.ts`; what
 * only the source can show is the WIRING that connects them to this page and to the Studio — and
 * each link, if dropped, silently turns the whole guard off while every one of those tests stays
 * green.
 *
 * Comments are stripped first with the one shared `stripComments`: these files explain the guard
 * in prose, and a doc comment naming `{leaveGuard}` must not satisfy an assertion that it is
 * rendered. Every scan has a self-check planting the defect.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { stripComments } from '../lib/stripComments'

const WEB_SRC = join(import.meta.dir, '..')
const PAGE = stripComments(readFileSync(join(import.meta.dir, 'SessionsPage.tsx'), 'utf8'))
const STUDIO = stripComments(readFileSync(join(WEB_SRC, 'components/sessions/Studio.tsx'), 'utf8'))
const STORE = stripComments(readFileSync(join(WEB_SRC, 'lib/artifactsStore.ts'), 'utf8'))
const PANEL_SLOTS = stripComments(readFileSync(join(WEB_SRC, 'lib/panelSlots.ts'), 'utf8'))
const GUARD = stripComments(readFileSync(join(WEB_SRC, 'components/sessions/UnsavedChangesGuard.tsx'), 'utf8'))

/**
 * The effect that arms the navigator guard: `useEffect(() => { … return guardNavigator(navigator,
 * <hold using navigationKeepsStudio>, run => holdIfUnsaved('leave', run)) }, [navigator])`. A
 * reviewer DELETED that whole effect and every test here stayed green — it is the link this file's
 * own header names, so it is asserted over the source like the others.
 */
function navigatorGuardInstalled(src: string): boolean {
  // `active` is false only on the second pane of a split view, whose ONE guard lives on the main
  // pane — the guard itself must still be installed there, in exactly this shape.
  return /useEffect\(\(\) => \{\s*if \(!active\) return[^}]*?return guardNavigator\(\s*navigator,\s*\(to, state\) => !navigationKeepsStudio\(pathnameOf\(to, window\.location\.pathname\), keys\.current\)\s*&& !navigationRetiresStudio\(state, keys\.current\),\s*run => holdIfUnsaved\('leave', run\),\s*\)\s*\}, \[navigator, active\]\)/
    .test(src)
}

/** The Back/Forward half: the page ARMS the one pop guard, held through the same question. */
function popGuardArmed(src: string): boolean {
  return /useEffect\(\(\) => \{\s*if \(!routed \|\| !active\) return\s*return armHistoryPopGuard\(\{\s*lastIndex: \(\) => shownIndex\.current,\s*hold: pathname => !navigationKeepsStudio\(pathname, keys\.current\),\s*onHold: run => holdIfUnsaved\('leave', run\),\s*\}\)\s*\}, \[routed, active\]\)/
    .test(src)
    && /useEffect\(\(\) => \{\s*shownIndex\.current = historyIndexOf\(window\.history\.state\)\s*\}, \[location\?\.key\]\)/.test(src)
}

const MAIN = stripComments(readFileSync(join(WEB_SRC, 'main.tsx'), 'utf8'))

/** Registered before the first render — after it, the router's listener runs first and it holds nothing. */
function popGuardInstalledBeforeRender(src: string): boolean {
  const install = src.search(/^installHistoryPopGuard\(\)$/m)
  const render = src.indexOf('ReactDOM.createRoot(')
  return install !== -1 && render !== -1 && install < render
}

/** The return that renders the pane: from its root's `ref={splitRef}` to the end of the file. */
function paneReturn(src: string): string {
  const at = src.indexOf('ref={splitRef}')
  return at === -1 ? '' : src.slice(at)
}

/** The pane slot and the guard slot, both inside that one return. */
function guardBesidePane(src: string): boolean {
  const ret = paneReturn(src)
  return ret.includes("{artShell === 'none' ? null : (") && /\{leaveGuard\}/.test(ret)
}

function guardDefined(src: string): boolean {
  return /const leaveGuard = \(\s*<UnsavedChangesGuard\b[\s\S]{0,200}?sessionKeys=\{/.test(src)
}

/**
 * One exported function's own body, from `export function <name>(` to the next `export function` —
 * `showPanel` and `concealPanel` (spec §5's "Ocultar") both guard a Studio displacement with the
 * BYTE-IDENTICAL line `if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return`,
 * so a whole-file `.replace()` (which only ever touches the FIRST occurrence) silently stopped
 * proving `showPanel`'s own guarantee the moment `concealPanel` gained the same line — the second
 * occurrence survived every planted removal and the test kept passing regardless. Scoping to one
 * function's own text is what makes each guarantee provable on its own.
 */
function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`)
  if (start === -1) return ''
  const next = src.indexOf('export function ', start + 1)
  return next === -1 ? src.slice(start) : src.slice(start, next)
}

describe('SessionsPage holds the pane drop behind the question', () => {
  test('the guard is defined with the session keys, and rendered in the return that holds the pane', () => {
    expect(PAGE.includes("import { UnsavedChangesGuard } from '../components/sessions/UnsavedChangesGuard'")).toBe(true)
    expect(guardDefined(PAGE)).toBe(true)
    expect(guardBesidePane(PAGE)).toBe(true)
  })

  test('the pane is closed through panelSlots.closePanel (which asks for the Studio), not a bypass', () => {
    // Post-rail: every one of the ten former Contents tabs carries its OWN `onClose`, closing
    // exactly the panel it belongs to through `closeSlotPanel` (`panelSlots.ts`'s `closePanel`) —
    // the same function `hidePanel` already asks through for the Studio. There is no separate
    // `closeArtifacts` bypass left to check for; its retirement is pinned below.
    const aside = PAGE.slice(PAGE.indexOf('<ArtifactsAside'), PAGE.indexOf('const leaveGuard'))
    expect(aside.includes('onClose={() => closeSlotPanel(id)}')).toBe(true)
  })

  test('the scan still sees the defect it exists to catch', () => {
    // The shape that shipped: the pane slot with no guard beside it.
    const unguarded = PAGE.replace(/\{leaveGuard\}/g, '')
    expect(guardBesidePane(unguarded)).toBe(false)
    // The guard rendered in some OTHER return, not the one holding the pane.
    const elsewhere = `return (<div>{leaveGuard}</div>)\n${unguarded}`
    expect(guardBesidePane(elsewhere)).toBe(false)
    // And the comment form: prose naming the slot is not the slot.
    expect(guardBesidePane(stripComments(`ref={splitRef} {artShell === 'none' ? null : (x)} /* {leaveGuard} */`)))
      .toBe(false)
    expect(guardBesidePane(`ref={splitRef} {artShell === 'none' ? null : (x)} {leaveGuard}`)).toBe(true)
  })
})

describe('the links the guard depends on', () => {
  /**
   * WHERE THE ASK NOW LIVES — updated for the right-icon-rail pass.
   *
   * This test used to pin the ask INSIDE `closeArtifacts`, from before `contents` stopped existing
   * as a single panel. Every one of its ten former tabs is a genuine `PanelId` now, tracked directly
   * in `SlotLayout` exactly like `studio`/`cli`/`shell`/`hardware` always were — so `closeArtifacts`
   * (and the `closeNow`/`dismissed` machinery it stood on) had nothing left to answer that
   * `panelSlots.closePanel` does not already, and is RETIRED rather than kept as a thin, ask-nothing
   * wrapper. `artifactsStore.test.ts` covers what remains of that module.
   */
  test('closeArtifacts is RETIRED — every panel closes straight through panelSlots.closePanel now', () => {
    expect(/\bcloseArtifacts\b/.test(STORE)).toBe(false)
    expect(/\bcloseNow\b/.test(STORE)).toBe(false)
  })

  test('showPanel asks before a displacing open drops the Studio, and hidePanel asks before a direct close', () => {
    expect(PANEL_SLOTS.includes(
      "if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return",
    )).toBe(true)
    expect(PANEL_SLOTS.includes(
      "if (panel === 'studio' && holdIfUnsaved('close', () => { commit(next); after?.() })) return",
    )).toBe(true)
  })

  test('the Studio REPORTS its dirty paths, and clears them when it unmounts', () => {
    expect(/reportUnsaved\(unsavedOwner, /.test(STUDIO)).toBe(true)
    expect(STUDIO.includes('useEffect(() => () => clearUnsaved(unsavedOwner), [unsavedOwner])')).toBe(true)
    // Derived from the tabs' own dirty flag, the one `ConfirmModal` for a single tab already reads.
    expect(STUDIO.includes("const dirtyKey = tabs.filter(t => t.dirty).map(t => t.path)")).toBe(true)
  })

  test('nothing else in the web package closes the panel around the question or answers it', () => {
    // `closeNow` is module-private to the store, and `answerUnsaved` is spoken only by the modal.
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue
        const src = stripComments(readFileSync(p, 'utf8'))
        const rel = relative(WEB_SRC, p)
        if (/\banswerUnsaved\(/.test(src) && rel !== join('components', 'sessions', 'UnsavedChangesGuard.tsx')
          && rel !== join('lib', 'unsavedBuffers.ts')) offenders.push(rel)
        if (/\bcloseNow\b/.test(src) && rel !== join('lib', 'artifactsStore.ts')) offenders.push(rel)
      }
    }
    walk(WEB_SRC)
    expect(offenders).toEqual([])
    expect(/export function closeNow/.test(STORE)).toBe(false)
  })

  test('the guard component installs the navigator guard and the Back/Forward guard', () => {
    expect(navigatorGuardInstalled(GUARD)).toBe(true)
    expect(popGuardArmed(GUARD)).toBe(true)
    expect(popGuardInstalledBeforeRender(MAIN)).toBe(true)
  })

  test('the scan still sees a guard component that stopped installing either', () => {
    const at = GUARD.indexOf('return guardNavigator(')
    const effectStart = GUARD.lastIndexOf('useEffect(', at)
    const effectEnd = GUARD.indexOf('}, [navigator, active])', at) + '}, [navigator, active])'.length
    expect(effectStart).toBeGreaterThan(-1)
    // The deletion the reviewer made: the whole effect gone.
    expect(navigatorGuardInstalled(GUARD.slice(0, effectStart) + GUARD.slice(effectEnd))).toBe(false)
    // Installed, but asking nothing.
    expect(navigatorGuardInstalled(GUARD.replace("run => holdIfUnsaved('leave', run),\n    )\n  }, [navigator, active])", 'run => false,\n    )\n  }, [navigator, active])')))
      .toBe(false)
    // Prose naming it is not it.
    expect(navigatorGuardInstalled(stripComments(`/* ${GUARD.slice(effectStart, effectEnd)} */`))).toBe(false)
    expect(popGuardArmed(GUARD.replace('return armHistoryPopGuard(', 'return void armHistoryPopGuard('))).toBe(false)
    // Installed after the render is installed too late.
    const late = MAIN.replace(/^installHistoryPopGuard\(\)$/m, '') + '\ninstallHistoryPopGuard()\n'
    expect(popGuardInstalledBeforeRender(late)).toBe(false)
    expect(popGuardInstalledBeforeRender(MAIN.replace(/^installHistoryPopGuard\(\)$/m, ''))).toBe(false)
  })

  test('the scan still sees either guarantee bypassed, and a Studio that stopped reporting', () => {
    // `closeArtifacts` grows the old bypassed shape back.
    const oldShape = STORE.replace(
      'export function closeArtifacts(): void {\n  closeNow()\n}',
      "export function closeArtifacts(): void {\n  if (state.open && holdIfUnsaved('close', closeNow)) return\n  closeNow()\n}",
    )
    expect(oldShape.includes('export function closeArtifacts(): void {\n  closeNow()\n}')).toBe(false)
    // `showPanel` stops asking before a displacing open drops the Studio. Scoped to `showPanel`'s
    // OWN body (`sliceFunction`) — `concealPanel` (spec §5's "Ocultar") guards the identical line,
    // and a whole-file replace only ever strips the FIRST of the two, leaving this coverage unable
    // to tell "showPanel stopped asking" from "concealPanel still asks".
    const showPanelSrc = sliceFunction(PANEL_SLOTS, 'showPanel')
    expect(showPanelSrc.includes(
      "if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return",
    )).toBe(true)
    const noAskOnShow = showPanelSrc.replace(
      "if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return", '',
    )
    expect(noAskOnShow.includes(
      "if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return",
    )).toBe(false)
    // `concealPanel` (spec §5) stops asking before hiding the Studio while it is the active
    // occupant — the SAME guarantee, the OTHER call site, proven independently for the same reason.
    const concealPanelSrc = sliceFunction(PANEL_SLOTS, 'concealPanel')
    expect(concealPanelSrc.includes(
      "if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return",
    )).toBe(true)
    const noAskOnConceal = concealPanelSrc.replace(
      "if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return", '',
    )
    expect(noAskOnConceal.includes(
      "if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return",
    )).toBe(false)
    // `hidePanel` stops asking before a direct close drops the Studio.
    const noAskOnHide = PANEL_SLOTS.replace(
      "if (panel === 'studio' && holdIfUnsaved('close', () => { commit(next); after?.() })) return", '',
    )
    expect(noAskOnHide.includes(
      "if (panel === 'studio' && holdIfUnsaved('close', () => { commit(next); after?.() })) return",
    )).toBe(false)
    // Prose naming either ask is not the ask.
    expect(stripComments("// if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return")
      .includes("if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return")).toBe(false)
    expect(/reportUnsaved\(unsavedOwner, /.test(stripComments('// reportUnsaved(unsavedOwner, paths)'))).toBe(false)
  })
})
