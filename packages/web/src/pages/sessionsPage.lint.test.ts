/**
 * sessionsPage.lint.test.ts — the centre's root may not change SHAPE with the edge strip.
 *
 * `SessionsPage` returned `edgeMarker === null ? panel : <div>{edgeMarker}{panel}</div>`. React
 * reconciles by POSITION, so swapping the root between `panel` and a div CONTAINING it unmounts the
 * whole panel and mounts a new one — every DOM node recreated, the composer's textarea among them.
 * Typing while a session worked lost the caret the moment the strip appeared, and lost it AGAIN
 * when it went away.
 *
 * A unit test cannot see this without mounting the page against a fleet host, which nothing in
 * `packages/web` is set up to do. The shape is what went wrong, so the shape is what is asserted —
 * the same approach `tokens.lint.test.ts` and `backup-route-body.lint.test.ts` take to invariants
 * that live in source rather than in a value.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../lib/stripComments'

const RAW = readFileSync(join(import.meta.dir, 'SessionsPage.tsx'), 'utf-8')

/**
 * CODE ONLY — comments are stripped before anything is asserted, BLOCK COMMENTS INCLUDED.
 *
 * The file explains the bug it forbids, quoting the old expression verbatim, so a grep over the raw
 * text matches the explanation and fails on a file that is correct. Same trap `attention-rules.ts`
 * records for footer markers: a source that discusses a pattern contains that pattern.
 *
 * **The stripper is `lib/stripComments.ts`, and it is shared on purpose.** This file used to keep
 * its own, which dropped only lines whose trim STARTS with `//` — so a needle planted as a TRAILING
 * comment after real code survived it, and a reviewer proved exactly that against the positive
 * assertion that used to live below. Two strippers of different strength for one job is one
 * stripper and one hole.
 */
const SRC = stripComments(RAW)

test('the centre is not swapped between `panel` and a wrapper around it', () => {
  // Any ternary whose branches are "the panel" and "something containing the panel" is this bug.
  expect(SRC).not.toMatch(/\?\s*panel\s*:/)
  expect(SRC).not.toMatch(/:\s*panel\s*\}/)
})

test('the edge strip is rendered INSIDE the wrapper, not as an alternative to it', () => {
  // The wrapper holds both, in this order, unconditionally — a `null` in the slot when the strip is
  // absent, which is what makes both cases the same shape. It is a fragment rather than a `return`
  // since the centre became a VALUE (see the `artifactsPane` assertions below); the property being
  // pinned is unchanged, and it is the ORDER plus the unconditional slot.
  const wrapper = /\{artShell === 'none' \? edgeMarker : null\}\s*\{panel\}/
  expect(SRC).toMatch(wrapper)
})

/**
 * ONE PANE, ONE PLACE — the defect this page shipped and the reason the centre is a value.
 *
 * `artifactsPane` was written into FOUR separate `return`s, one per `ArtifactLayout`. React
 * reconciles by POSITION, so four positions are four different elements: crossing 768px or
 * `SPLIT_MIN` unmounted the entire aside and mounted a new one. The Studio's whole composition
 * (`Layer`, `mountedEditors`, `StudioBody`'s one DOM shape) exists so that an unsaved buffer
 * survives every move a reader makes inside it, and the page around it was discarding the lot
 * whenever the WINDOW changed size — which on a phone is turning it over, or opening the keyboard.
 *
 * MEASURED at 390x844 on a live session before the fix: two files open, the second edited and the
 * strip reading `artifactLayout.test.ts — não salvo`, one Monaco instance. After a single resize to
 * 1600x900 the same reads answered `openTabs: []`, `monaco: 0` and a re-fetched tree.
 *
 * This is the same class of invariant as the edge-strip shape above, and the same reason it is a
 * grep: seeing it requires mounting the page against a fleet host and resizing the window, and
 * `packages/web` has no jsdom. The COUNT is what went wrong, so the count is what is asserted.
 *
 * ONE FUNCTION, AS OF THE RIGHT ICON RAIL PASS — `contents` stopped being a single panel, so
 * `artifactsPane` (one computed VALUE) became `tabPane` (one computed FUNCTION), called once for
 * whichever tab id the RIGHT slot shows and once for whichever DIFFERENT id the BOTTOM band shows —
 * `slotLayout.right`/`slotLayout.bottom` can never hold the SAME id at once (a panel sits in exactly
 * one placement), so this is still "at most one mount per id", not the four-copies-at-once shape
 * this test was originally written against. The two call sites are each their own single computed
 * value (`rightTabPane`, `bottomTabPane`), each rendered into the tree from exactly ONE site — the
 * right slot's own JSX child, and the one prop that threads the bottom occupant to `SessionPanel`.
 */
test('tabPane is defined exactly once, and called exactly once per slot', () => {
  expect([...SRC.matchAll(/const tabPane = /g)]).toHaveLength(1)
  expect([...SRC.matchAll(/const rightTabPane = /g)]).toHaveLength(1)
  expect([...SRC.matchAll(/const bottomTabPane = /g)]).toHaveLength(1)
  // Three: the right slot, the bottom band, and the FLOATING window (`floatingBody`) — a floating
  // panel has left its docked slot (`applyFloating`), so it is still at most one mount per id.
  expect([...SRC.matchAll(/\btabPane\(/g)]).toHaveLength(3)
})

test('...and each of the two is rendered into the tree from exactly ONE site', () => {
  expect([...SRC.matchAll(/\{rightTabPane\}/g)]).toHaveLength(1)
  expect([...SRC.matchAll(/bottomTabPane=\{/g)]).toHaveLength(1)
})

test('...and the layout is a STYLE, not a second copy of the pane', () => {
  // The one slot, and the two style objects the four old branches collapsed into. `artShell` is the
  // single answer to "which shape"; a branch that returned early would not need it.
  expect(has('const artShell:')).toBe(true)
  expect(has('const artOuter: CSSProperties')).toBe(true)
  // `ref={rightAsideRef}` was added alongside `style={artOuter}` so this box's live left edge can
  // be reported to `App.tsx`'s Filtros panel (`rightAsideEdge.ts`) — same one slot, same one style
  // object, with a second attribute rather than a second render site.
  expect(has('<div style={artOuter} ref={rightAsideRef}>')).toBe(true)
  // The box renders `rightSlotContent` — the Studio's own target box, `cli`/`shell`'s own region, or
  // `rightTabPane`, decided by `lib/panelSlots.ts`'s `layout.right` — never the pane directly, or
  // the Studio's switcher (`rightSwitcher`) would have nowhere to sit above whichever one is showing.
  expect(has('<div style={artInner}>{rightSlotContent}</div>')).toBe(true)
  expect(has('const rightSlotContent =')).toBe(true)
  // And the centre is a value. A `return` inside the layout branches is how the four sites happened.
  expect(has('let centre: ReactNode')).toBe(true)
})

test('the scan still sees a SECOND pane being added back', () => {
  // The plant: the same needle twice is what a second render site looks like, and the scan must
  // count it — including when one of the two is only prose, which must NOT count.
  const twice = 'a{rightTabPane}b\nc{rightTabPane}d\n'
  expect([...stripComments(twice).matchAll(/\{rightTabPane\}/g)]).toHaveLength(2)
  expect([...stripComments('{rightTabPane}\n// {rightTabPane}\n').matchAll(/\{rightTabPane\}/g)])
    .toHaveLength(1)
  expect([...stripComments('{rightTabPane}\nconst x = 1 // {rightTabPane}\n').matchAll(/\{rightTabPane\}/g)])
    .toHaveLength(1)
  expect([...stripComments('{rightTabPane}\n/* {rightTabPane} */\n').matchAll(/\{rightTabPane\}/g)])
    .toHaveLength(1)
})

// Without this the greps above could pass on a file that no longer has either name, which would be
// a test that checks nothing while staying green.
test('the names this pins still exist in the file', () => {
  expect(SRC).toContain('const edgeMarker')
  expect(SRC).toContain('const panel =')
})

/**
 * THE STUDIO'S GATE IS READ HERE AND NARROWED NOWHERE.
 *
 * `/api/fleet` is refused WHOLE on a central, and `editor-gate.ts` carries no central term — so a
 * central on a `local` profile with the preference on reports `editorEnabled: true`. That term used
 * to be subtracted on this line, which was correct for the two entries this page owns and said
 * nothing about the next surface to read `ctx.editorEnabled`. It is now subtracted where the value
 * is PUBLISHED (`lib/editorGate.ts`, spent in `App.tsx`'s `appCtx`), and the property — a central
 * never publishes a true `editorEnabled` — is asserted app-wide in `lib/editorGate.test.ts`.
 *
 * What is left for THIS page is narrower and still worth pinning: it reads the published value ONCE
 * and adds nothing to it. A second reading is a second gate, which is how the mobile entry came to
 * disagree with the desktop one in the first place.
 *
 * Not reachable by rendering: the page needs a fleet host and `packages/web` has no jsdom. The
 * expression is what went wrong, so the expression is what is asserted — over comment-free source,
 * with the defect planted below to prove the scan can still see it.
 */
const GATE = 'const editorEnabled = ctx.editorEnabled === true'

/**
 * A needle, as a BOOLEAN — the lesson `ArtifactsAside.gate.lint.test.ts` records.
 *
 * `expect(SRC).toMatch(…)` on a 60 KB file prints the whole file on failure, which buries the one
 * line that says what broke. The needle is in the assertion's own line; what the report has to carry
 * is whether it is there.
 */
const has = (needle: string) => SRC.includes(needle)

test('the Studio gate is the published value, read as written', () => {
  expect(has(GATE)).toBe(true)
})

test('and it is the only reading of `ctx.editorEnabled` on this page', () => {
  // A second, ungated read would be a second gate — which is exactly how the mobile entry came to
  // disagree with the desktop one.
  expect([...SRC.matchAll(/ctx\.editorEnabled/g)]).toHaveLength(1)
})

test('every Studio entry on this page is gated on that one value', () => {
  // The mobile session-menu row — built by `studioMenuRow` (`lib/studioMenuRow.ts`, W1-A), wired
  // into `...(editorEnabled ? [studioMenuRow(...)] : [])` once its own `on` wiring test lives in
  // `studioMenuRow.test.ts` — the right switcher's OWN `studio` entry (the switcher itself is no
  // longer gated wholesale — §1.5 added `cli`/`shell` entries that must stay reachable even where
  // `editorEnabled` is false), and the `StudioHost` mount that actually renders it — the Studio
  // moved out of `ArtifactsAside` (`lib/panelSlots.ts`), so the prop that used to gate ITS strip
  // entry and layer (`editorEnabled={editorEnabled}`) is gone with it; these three are what
  // replaced it.
  expect(/\.\.\.\(editorEnabled\s*\n?\s*\?\s*\[studioMenuRow\(/.test(SRC)).toBe(true)
  // The mobile in-panel switcher (`rightSwitcherMobile`, post-mobile-pass: ALL FOURTEEN panels get
  // an entry there now, `cli`/`shell` included — see the Mobile pass's own note on why the earlier
  // exclusion was the bug, not the design) reads `studio`'s gate through `railGateOpen`, the SAME
  // per-id gate function `gatedRailPanels`/`gatedHiddenPanels` already apply — one gate shared by
  // the rail, the eye's hidden list AND the mobile switcher now, rather than a fourth ad-hoc filter
  // chain that could drift from the other three the way the mobile entry once did.
  expect(has("if (id === 'studio') return editorEnabled === true")).toBe(true)
  expect(has('const gatedMobilePanels = [...railPanels(slotLayout), ...bottomPanels(slotLayout)]')).toBe(true)
  expect(has('    .filter(railGateOpen)')).toBe(true)
  expect(has("editorEnabled === true && (isPanelShown(slotLayout, 'studio') || studioFloating),")).toBe(true)
})

test('the scan still sees the defect it exists to catch', () => {
  // The line gone, and then each of the three ways it can be present as PROSE rather than as code.
  const gone = 'const editorEnabled = somethingElse\n'
  expect(stripComments(gone).includes(GATE)).toBe(false)
  expect(stripComments(`/**\n * ${GATE}\n */\n${gone}`).includes(GATE)).toBe(false)
  expect(stripComments(`// ${GATE}\n${gone}`).includes(GATE)).toBe(false)
  // THE PLANT THIS FILE SHIPPED WITHOUT. A needle written after real code is not code, and the
  // stripper that used to live here — lines whose trim STARTS with `//` — let exactly this through;
  // a reviewer proved it, and only a sibling assertion noticed.
  expect(stripComments(`const x = 1 // ${GATE}\n${gone}`).includes(GATE)).toBe(false)
})

/**
 * THE TWO "WHY THE COUNT IS SHORT" FACTS REACH A SURFACE.
 *
 * `hasUnlistedWrites` was computed on every poll and read by nothing for a release: its two surfaces
 * went with the Files tab and the producer stayed. A computed-and-discarded honesty flag is the worst
 * of the three options — it looks like the fact is being reported. The route's `outside` sentence was
 * dropped outright on a misreading of its own words (it qualifies OPENING, not listing).
 *
 * Both are now carried to the aside's header, beside the count they qualify. Asserted here because
 * `noUnusedLocals` is `false` in this package, so nothing else would notice either going dead again.
 */
test('the unlistable-writes flag is stored and handed to the aside', () => {
  expect(has('setArtifactsUnlisted(a.unlisted)')).toBe(true)
  expect(has('unlistedWrites={artifactsUnlisted}')).toBe(true)
})

test('the route\'s `outside` sentence is read and handed to the aside', () => {
  expect(has('setOutsideNote(d.outside)')).toBe(true)
  expect(has('{...(outsideNote ? { outsideNote } : {})}')).toBe(true)
})

test('the scan still sees either of those going dead', () => {
  // A prop passed in a comment is not a prop passed — in any of the three comment shapes.
  expect(stripComments('/* unlistedWrites={artifactsUnlisted} */').includes('unlistedWrites={artifactsUnlisted}'))
    .toBe(false)
  expect(stripComments('// setOutsideNote(d.outside)').includes('setOutsideNote(d.outside)')).toBe(false)
  expect(stripComments('const x = 1 // setOutsideNote(d.outside)').includes('setOutsideNote(d.outside)'))
    .toBe(false)
})

/**
 * I4 — THE STUDIO'S MOVE-NEVER-REMOUNTS GUARANTEE HAS A MOUNT SITE, AND THE MOUNT SITE CAN BREAK IT
 * ALL BY ITSELF. `StudioHost.lint.test.ts` pins the re-parenting MECHANISM inside `StudioHost.tsx`;
 * it says nothing about how this page MOUNTS that component, and a reviewer proved the gap three
 * times over. First: adding `key={rightIsStudio ? 'right' : 'bottom'}` to a hand-written
 * `cond && (<StudioHost .../>)` — every test in the suite at the time stayed green, because
 * `StudioHost.lint.test.ts` only reads `StudioHost.tsx` and `panelSlots.test.ts` never renders
 * anything. THE FIX for that was moving the mount through `lib/panelSlots.ts`'s `mountPanel`, pinned
 * against REAL `React.ReactElement` objects in `panelSlots.mountPanel.test.ts`. Second, in the
 * RE-REVIEW: adding `key: rightIsStudio ? 'right' : 'bottom',` into the literal PROPS object at that
 * call, still inside this page — `panelSlots.mountPanel.test.ts` only ever called `mountPanel` with a
 * `Dummy` component and hand-built props, so it never touched THIS call site and stayed green; only
 * this file's own source scan (a full scan of the literal, back then) caught it.
 *
 * THAT SCAN WAS THEN WEAKENED, and a THIRD re-review caught it: the fix that introduced
 * `mountStudioHostPanel` (the module-level function above) replaced the working "scan the whole
 * literal for a `key:` field, anywhere" test with one that only checks how many times the fixed
 * `CALL_GUARD` PREFIX string occurs. A `key` planted as the object's FIRST field still broke that
 * prefix string and was still (coincidentally) caught; a `key` planted as its LAST field, after
 * `target: studioTarget,`, left the prefix untouched and passed every `bun test` in the suite
 * — only `bun tsc --noEmit` caught it, and only because a directly-passed object literal still
 * triggers excess-property checking regardless of field order. The whole-literal scan below is that
 * protection RESTORED, not a new one — see `SRC.slice(start, close)` rather than a fixed-string
 * `.split(...).length`.
 *
 * `mountStudioHostPanel` also carries `studioHostMount.test.ts` (genuine structural coverage of the
 * function's own contract, calling it directly with real `React.ReactElement` objects) and
 * `studioHostMountParams.types.test.ts` (`StudioHostMountParams.key: never`, a TYPE-level guarantee
 * that reaches shapes NEITHER a source scan nor a call through the real function can see — a `key`
 * routed through an intermediate typed variable, or merged in via a later spread, since neither one
 * puts `key:` as literal text near this call, and neither one calls `mountStudioHostPanel` with a
 * bare `key` field for `studioHostMount.test.ts` to catch either).
 *
 * So THIS file owns two things: the SHAPE of the JSX call (exactly one, passing the same `shown`
 * condition every gate on this page uses rather than a slot-dependent ternary), and the CONTENT of
 * its literal (no `key:` field, at any position).
 */
describe('StudioHost is mounted once, through mountStudioHostPanel (I4)', () => {
  const CALL_GUARD = "mountStudioHostPanel({\n        shown: editorEnabled === true && (isPanelShown(slotLayout, 'studio') || studioFloating),"
  // The literal's own closing tokens: `}` closes the object, `)` closes the call, `}` closes the
  // JSX expression container — `{selected && mountStudioHostPanel({ ... })}`.
  const CALL_CLOSE = '\n      })}'

  test('the bare identifier appears exactly three times: twice on the import line, once in mountStudioHostPanel\'s own call to mountPanel', () => {
    expect([...SRC.matchAll(/\bStudioHost\b/g)]).toHaveLength(3)
  })

  test('the one call site passes the SAME `shown` condition every gate on this page uses, not a slot-dependent ternary', () => {
    expect(has(CALL_GUARD)).toBe(true)
    expect(SRC).not.toMatch(/rightIsStudio\s*\?\s*mountStudioHostPanel/)
    expect(SRC).not.toMatch(/bottomIsStudio\s*\?\s*mountStudioHostPanel/)
  })

  test('the call-site guard appears exactly once — a second, byte-identical mount call would be caught', () => {
    // This pins a DIFFERENT invariant than the key scan below (a second mount SITE, not a stray
    // field on this one) — it is deliberately not relied on for I4's own guarantee any more.
    const occurrences = SRC.split(CALL_GUARD).length - 1
    expect(occurrences).toBe(1)
    const secondMount = `${SRC}\n${CALL_GUARD} sessionId: 'x' })`
    expect(secondMount.split(CALL_GUARD).length - 1).toBe(2)
  })

  test('the scan still sees the guard move away from the call', () => {
    expect(has(CALL_GUARD)).toBe(true) // sanity: the needle exists in the real file
    const guardMovedAway = SRC.replace(CALL_GUARD, "editorEnabled === true && (isPanelShown(slotLayout, 'studio') || studioFloating) && (\n        <div />")
    expect(guardMovedAway.includes(CALL_GUARD)).toBe(false)
  })

  test('the props object handed to mountStudioHostPanel carries no `key` field, at ANY position in the literal', () => {
    const start = SRC.indexOf(CALL_GUARD)
    const close = SRC.indexOf(CALL_CLOSE, start)
    expect(start).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(start)
    expect(SRC.slice(start, close)).not.toMatch(/(^|[,{])\s*key\s*:/)
  })

  test('the scan still sees a `key` field slipped into the props object, whichever position it is added at', () => {
    // FIRST field — the shape the original review planted, and the shape the occurrence-count test
    // above (coincidentally) still catches because it breaks the CALL_GUARD prefix string.
    const first = SRC.replace(
      CALL_GUARD,
      "mountStudioHostPanel({\n        key: rightIsStudio ? 'right' : 'bottom',\n        shown: editorEnabled === true && (isPanelShown(slotLayout, 'studio') || studioFloating),",
    )
    const firstStart = first.indexOf('mountStudioHostPanel({')
    const firstClose = first.indexOf(CALL_CLOSE, firstStart)
    expect(first.slice(firstStart, firstClose)).toMatch(/(^|[,{])\s*key\s*:/)

    // LAST field, appended right before the closing `})}` — the shape the re-review found that the
    // occurrence-count test cannot see at all, because it never touches the fixed prefix string.
    // This must move whenever a field is added after it, or the plant silently stops matching
    // anything and the test passes for the wrong reason (see the failure this exact drift caused
    // when `target: studioTarget,`, then `onMention: onStudioMention,`, then
    // `onToggleFullscreen: …`, then `onMinimizeRight: …`, were each in turn assumed to be last —
    // PIN = FLOAT, 2026-09-27, is the current one).
    const LAST_FIELD = "pinned: isMobile ? undefined\n          : studioFloating\n            ? { active: true, onToggle: () => dockBack('studio') }\n            : { active: false, onToggle: () => floatPanel('studio') },"
    const last = SRC.replace(
      LAST_FIELD + CALL_CLOSE,
      `${LAST_FIELD}\n        key: rightIsStudio ? 'right' : 'bottom',` + CALL_CLOSE,
    )
    const lastStart = last.indexOf(CALL_GUARD)
    const lastClose = last.indexOf(CALL_CLOSE, lastStart)
    expect(last.slice(lastStart, lastClose)).toMatch(/(^|[,{])\s*key\s*:/)
  })
})

/**
 * THE DEDICATED-TERMINAL BRANCH MAY NEVER SKIP A HOOK — "Rendered fewer hooks than expected."
 *
 * `if (dedicatedTerminal && selected) { …; return (…) }` is a conditional early `return` inside this
 * component's body, and for one release two hooks lived textually AFTER it: `const rightAsideRef =
 * useRef(...)` and the `useEffect` that measures it. React calls hooks in call ORDER and COUNT, not
 * by name, so the ordinary render (41 hooks) and the dedicated-terminal render (38 — the branch
 * returns before the last three) disagreed on the count the moment a reader pressed a band's own
 * "full screen" control, whichever pane it named. Reported as the Claude Code panel AND the Shell
 * both crashing to `RootErrorBoundary` on the way IN, and again on the way OUT (`Voltar para a
 * sessão`) — the SAME defect from the other side, since leaving `/terminal` is exactly the reverse
 * transition between the same two hook counts.
 *
 * THE FIX moved the whole "ONE PANE, POSITIONED BY THE LAYOUT" section — `artShell`, `artOuter`,
 * `artInner`, `rightAsideRef` and its two effects — to BEFORE the branch, so every hook this
 * component ever calls is called on EVERY render, dedicated-terminal or not; only the JSX each
 * branch RETURNS differs, never the hooks that ran to get there.
 *
 * Not reachable by rendering: the page needs a fleet host, a selected session and a route change,
 * and `packages/web` has no jsdom. The SHAPE is what went wrong (a hook after a conditional
 * `return`), so the shape is what is asserted, over comment-free source, with the defect planted
 * below to prove the scan still sees it.
 */
describe('the dedicated-terminal branch may not skip a hook (hook-order crash)', () => {
  const DEDICATED_IF = 'if (dedicatedTerminal && selected) {'
  // Matches a hook call by NAME rather than by import, so it catches `useRef`, `useEffect(...)`,
  // and a generic call like `useRef<HTMLDivElement | null>(null)` alike — the exact shape that
  // slipped past a narrower `const \w+ = use\w+\(` pattern before (no `<...>` generic allowed).
  const HOOK_CALL = /\buse[A-Z]\w*\s*(<[^>]*>)?\s*\(/g

  test('the guarded branch is still where this test expects it', () => {
    expect(has(DEDICATED_IF)).toBe(true)
  })

  test('no hook call appears anywhere after the dedicated-terminal branch', () => {
    const at = SRC.indexOf(DEDICATED_IF)
    expect(at).toBeGreaterThan(-1)
    const after = SRC.slice(at)
    expect([...after.matchAll(HOOK_CALL)]).toHaveLength(0)
  })

  test('the scan still sees a hook planted after the branch, in either shape that actually broke this', () => {
    const plantedRef = `${SRC}\n  const rightAsideRef = useRef<HTMLDivElement | null>(null)\n`
    const afterRef = plantedRef.slice(plantedRef.indexOf(DEDICATED_IF))
    expect([...afterRef.matchAll(HOOK_CALL)].length).toBeGreaterThan(0)

    const plantedEffect = `${SRC}\n  useEffect(() => {}, [])\n`
    const afterEffect = plantedEffect.slice(plantedEffect.indexOf(DEDICATED_IF))
    expect([...afterEffect.matchAll(HOOK_CALL)].length).toBeGreaterThan(0)

    // A commented-out plant must never count — the same trap `GATE`'s own scan guards above.
    const plantedComment = `${SRC}\n  // const rightAsideRef = useRef(null)\n`
    const afterComment = stripComments(plantedComment).slice(stripComments(plantedComment).indexOf(DEDICATED_IF))
    expect([...afterComment.matchAll(HOOK_CALL)]).toHaveLength(0)
  })
})

/**
 * THE DEDICATED TERMINAL SCREEN CARRIES NO PANE SWITCHER — owner: "quando eu coloco o shell em
 * fullscreen ele ainda renderiza um componente antigo que tem o tabmenu claude code e shell, ele
 * deveria ter apenas o botao de fullscreen e de desfullscreen." The switcher duplicated the panel
 * bar the session itself already has; removing it must not take away the only way to switch panes,
 * so `dedicatedTerminalPath` — the one thing that could re-introduce a second picker — must not be
 * called from inside this branch's own JSX any more, only from the OTHER surfaces that navigate
 * INTO it (`rightSlotBar`, `SessionPanel`'s own props) — the same assumption `targetLabel`'s own
 * remaining two call sites already carry (the right slot's Claude Code/Shell headers, untouched).
 */
describe('the dedicated-terminal branch carries no pane switcher of its own (I1)', () => {
  const DEDICATED_IF = 'if (dedicatedTerminal && selected) {'
  const NEXT_BRANCH = "} else if (isMobile && (creating || finishing)) {"

  function dedicatedBody(src: string): string {
    const start = src.indexOf(DEDICATED_IF)
    const end = src.indexOf(NEXT_BRANCH, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  test('no role="tablist" (the removed pane switcher) inside the dedicated-terminal branch', () => {
    expect(dedicatedBody(SRC)).not.toContain('role="tablist"')
  })

  test('the branch never navigates to itself with a different pane — that was the switcher\'s own click', () => {
    expect(dedicatedBody(SRC)).not.toMatch(/dedicatedTerminalPath\(selected\.id, target\)/)
  })

  test('the "which terminal" label is gone with it — only the shell-unavailable sentence remains', () => {
    expect(dedicatedBody(SRC)).not.toMatch(/Qual terminal|Which terminal/)
  })

  test('the shell-unavailable sentence survives the removal — it is not a switcher row', () => {
    expect(dedicatedBody(SRC)).toContain("dedicatedPane === 'shell' && !shellEnabled")
  })

  test('the scan still sees the switcher reintroduced', () => {
    const planted = `${SRC.slice(0, SRC.indexOf(DEDICATED_IF))}${DEDICATED_IF}\n    <div role="tablist">x</div>\n${SRC.slice(SRC.indexOf(DEDICATED_IF) + DEDICATED_IF.length)}`
    expect(dedicatedBody(planted)).toContain('role="tablist"')
  })
})

/**
 * ON DESKTOP THE DEDICATED TERMINAL RESPECTS THE ARTIFACTS ASIDE (change #2) — it falls through to
 * `centre` instead of returning unconditionally, so the shared split/aside composition below can
 * add the aside beside it. `dedicatedRightRedundant` is the one thing that composition must NOT
 * show: the very CLI/Shell pane this screen already fills whole, drawn a second time in the aside.
 */
describe('the dedicated-terminal branch falls through to centre on desktop (I2)', () => {
  test('mobile still returns directly — no room for a companion aside', () => {
    expect(has('if (isMobile) return dedicated')).toBe(true)
  })

  test('desktop assigns centre instead of returning', () => {
    expect(has('centre = dedicated')).toBe(true)
  })

  test('the redundant-pane guard exists and feeds the aside\'s own open condition', () => {
    expect(has('const dedicatedRightRedundant = dedicatedTerminal')).toBe(true)
    expect(has('&& !dedicatedRightRedundant,')).toBe(true)
  })

  test('the scan still sees an unconditional return reintroduced', () => {
    const reverted = SRC.replace('if (isMobile) return dedicated\n    centre = dedicated', 'return dedicated')
    expect(reverted.includes('if (isMobile) return dedicated')).toBe(false)
  })
})

/**
 * THE NARROW-WIDTH OVERLAY'S CLICK-OUTSIDE/ESC EFFECT IS RAIL-ONLY (spec §11 item 4: "the bottom
 * band keeps today's behaviour exactly; nothing there changes"). A unit test cannot mount this page
 * against a real DOM (`packages/web` has no jsdom, same reason every other block in this file is a
 * source scan rather than an interaction test) — so the SHAPE is what is asserted: the effect's own
 * body, sliced out by its two unique anchors, must early-return before doing anything unless
 * `artShell === 'overlay'`, and must never mention the bottom band's own machinery
 * (`bottomOpen`/`setBandOpen`/`ShellBand`/`SessionPanel`) anywhere inside it. That is what makes it
 * structurally impossible for this effect to reach into the bottom band's collapse/minimize path,
 * rather than merely unlikely today.
 */
describe('the narrow-overlay click-outside/Esc effect never touches the bottom band (spec §11 item 4)', () => {
  const START = "if (artShell !== 'overlay') return"
  const END = "}, [artShell, slotLayout.right, closeSlotPanel, setRightOpen])"

  function effectBody(src: string): string {
    const start = src.indexOf(START)
    const end = src.indexOf(END, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  test('the effect exists exactly once', () => {
    expect([...SRC.matchAll(new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]).toHaveLength(1)
  })

  test('the body never mentions the bottom band’s own state or components', () => {
    const body = effectBody(SRC)
    expect(body).not.toMatch(/bottomOpen/)
    expect(body).not.toMatch(/setBandOpen/)
    expect(body).not.toMatch(/ShellBand/)
    expect(body).not.toMatch(/SessionPanel/)
  })

  test('the body decides through the shared pure overlayOutsideAction, never a bespoke inline rule', () => {
    expect(effectBody(SRC)).toContain('overlayOutsideAction(')
  })

  test('both the click and the Esc branch route through the same minimize, gated on the same decision', () => {
    const body = effectBody(SRC)
    expect([...body.matchAll(/overlayOutsideAction\(/g)]).toHaveLength(2)
    expect([...body.matchAll(/minimize\(\)/g)]).toHaveLength(2)
  })

  // PLANTED-REVERT: a version of this effect with the early return removed would run on EVERY
  // shell, including the bottom band's own — exactly what item 4 forbids. Simulating that removal
  // is what this whole describe block would fail to find: the anchor the other tests slice on is
  // gone, so `effectBody` throws rather than silently scanning an empty (falsely "clean") string.
  test('[planted-revert coverage] removing the guard clause is caught — the anchor this block slices on disappears', () => {
    const reverted = SRC.replace(`${START}\n`, '')
    expect(reverted).not.toContain(START)
    expect(SRC).toContain(START) // the real file still has it
  })
})
