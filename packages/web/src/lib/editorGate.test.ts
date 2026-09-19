import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { editorEnabledFor } from './editorGate'
import { stripComments } from './stripComments'

/**
 * THE PROPERTY, EXECUTED — and it is app-wide rather than per page, which is the point.
 *
 * The old assertion pinned "`SessionsPage` reads `ctx.editorEnabled` exactly once and narrows it".
 * True, and it says nothing about the next surface to read the same field. What is worth asserting
 * is the one sentence the whole gate rests on: a central never publishes a true `editorEnabled`.
 */
describe('editorEnabledFor', () => {
  it('is never true on a central, whatever the server said', () => {
    for (const server of [true, false, undefined]) {
      expect(editorEnabledFor(server, true)).toBe(false)
    }
  })

  it('off a central it is the server\'s own answer, and absence reads as OFF', () => {
    expect(editorEnabledFor(true, false)).toBe(true)
    expect(editorEnabledFor(false, false)).toBe(false)
    expect(editorEnabledFor(undefined, false)).toBe(false)
  })

  it('returns a real boolean, never `undefined` leaking through', () => {
    for (const server of [true, false, undefined]) {
      for (const central of [true, false]) {
        expect(typeof editorEnabledFor(server, central)).toBe('boolean')
      }
    }
  })
})

/**
 * AND THE APP PUBLISHES THROUGH IT.
 *
 * The function can only hold the property if it is the one producer. `App.tsx` builds `appCtx` as a
 * single object literal — there is no jsdom here and that component cannot be rendered — so the
 * producer is asserted over its source, with comments stripped (`stripComments`) for the reason that
 * module records: the line's own doc comment names the term it would otherwise be asked to prove.
 */
describe('the one producer is `App.tsx`, and it goes through this module', () => {
  const WEB = join(import.meta.dir, '..')
  const RAW = readFileSync(join(WEB, 'App.tsx'), 'utf8')

  /**
   * THE OBJECT LITERAL, CUT OUT FIRST — and not because it reads more nicely.
   *
   * `stripComments` is a regex, and App.tsx holds the string `'~/.claude/projects/**\/*.jsonl'`: the
   * `/*` inside it opens a comment the stripper then closes at the next real `*\/`, **28.875
   * characters later**, taking `const appCtx` and the whole publish with it. A whole-file strip of
   * THIS file silently deletes the thing being asserted, so the literal is located in the RAW source
   * (where no such sequence lies between its braces) and only then stripped. Same shape as
   * `ArtifactsAside.gate.lint.test.ts`'s `tabsArray`: "inside the gate" is a question with an answer
   * only once the region is cut.
   */
  function appCtx(raw: string): string {
    const start = raw.indexOf('const appCtx: AppContext = {')
    if (start < 0) throw new Error('editorGate.lint: App.tsx no longer builds `const appCtx: AppContext = {`')
    const end = raw.indexOf('\n  }\n', start)
    if (end < 0) throw new Error('editorGate.lint: cannot find the end of the appCtx literal')
    return stripComments(raw.slice(start, end))
  }

  const CTX = appCtx(RAW)
  /**
   * The import lines, taken as LINES rather than as a prefix of the file — for the same reason as
   * above. A comment can never begin with `import `, so this needs no stripping and cannot be
   * swallowed by one.
   */
  const IMPORTS = RAW.split('\n').filter(l => l.startsWith('import ')).join('\n')

  it('the file read is the real one, and the literal was actually found', () => {
    expect(RAW.length).toBeGreaterThan(50_000)
    expect(CTX.length).toBeGreaterThan(500)
    expect(CTX.includes('isCentral,')).toBe(true)
  })

  it('publishes `editorEnabled` through `editorEnabledFor`, and imports it', () => {
    expect(IMPORTS.includes("import { editorEnabledFor } from './lib/editorGate'")).toBe(true)
    expect(CTX.includes('editorEnabled: editorEnabledFor(teamSession?.editorEnabled, isCentral),')).toBe(true)
  })

  it('and nothing else in App re-derives it from the raw server answer', () => {
    // Two readings of `teamSession?.editorEnabled` would be two gates, which is how the mobile entry
    // came to disagree with the desktop one in the first place. Counted over the RAW file: the point
    // is that no SECOND one exists anywhere, comments included — a commented-out one is a leftover.
    expect([...RAW.matchAll(/teamSession\?\.editorEnabled/g)]).toHaveLength(1)
  })

  it('the scan still sees the producer going bare', () => {
    const bare = 'editorEnabled: teamSession?.editorEnabled === true,\n'
    expect(stripComments(bare)).not.toContain('editorEnabledFor')
    // And the three comment forms: prose beside the line may not stand in for the line. The last is
    // the one a reviewer planted against the weaker stripper this file no longer has.
    expect(stripComments(`/** editorEnabledFor(x, isCentral) */\n${bare}`)).not.toContain('editorEnabledFor')
    expect(stripComments(`// editorEnabledFor(x, isCentral)\n${bare}`)).not.toContain('editorEnabledFor')
    expect(stripComments(`${bare.trim()} // editorEnabledFor(x, isCentral)\n`)).not.toContain('editorEnabledFor')
  })

  it('and it sees the literal being cut wrong, rather than passing on an empty region', () => {
    expect(() => appCtx('const nothing = 1\n')).toThrow(/no longer builds/)
  })
})

/**
 * AND THE SWITCH REACHES THIS PUBLISHED VALUE WITHOUT A RELOAD, IN BOTH DIRECTIONS.
 *
 * `App.tsx` used to read `/api/team/session` once, at boot, with `[]` deps — so flipping the
 * preference in `SessionsSettings` (which PUTs `/api/preferences` and only updates its OWN local
 * toggle) never reached `ctx.editorEnabled`: every Studio entry stayed exactly as it was at boot
 * while the settings screen's own sentence claimed the opposite. There is no jsdom here, so what a
 * toggle actually DOES to the published context cannot be rendered — it is asserted the same way the
 * producer above is: over the source, comments stripped.
 */
describe('the switch reaches `ctx.editorEnabled` live — re-fetch, never re-derive', () => {
  const WEB = join(import.meta.dir, '..')
  const RAW = readFileSync(join(WEB, 'App.tsx'), 'utf8')
  const IMPORTS = RAW.split('\n').filter(l => l.startsWith('import ')).join('\n')
  const CTX = (() => {
    const start = RAW.indexOf('const appCtx: AppContext = {')
    const end = RAW.indexOf('\n  }\n', start)
    return stripComments(RAW.slice(start, end))
  })()
  const SESSIONS_SETTINGS = stripComments(
    readFileSync(join(WEB, 'pages/settings/SessionsSettings.tsx'), 'utf8'),
  )

  it('App builds a reusable refresh and runs it at boot', () => {
    expect(IMPORTS.includes("import { resolveTeamSessionRefresh } from './lib/teamSessionRefresh'")).toBe(true)
    expect(RAW.includes('const refreshTeamSession = useCallback(() => {')).toBe(true)
    expect(RAW.includes('useEffect(() => { void refreshTeamSession() }, [refreshTeamSession])')).toBe(true)
    // A failed re-fetch must not wipe out what is already known (`central`, `capabilities`, …) —
    // `resolveTeamSessionRefresh` is what carries that rule, not a bare fallback object here.
    expect(RAW.includes('setTeamSession(prev => resolveTeamSessionRefresh(prev, s,')).toBe(true)
    expect(RAW.includes('setTeamSession(prev => resolveTeamSessionRefresh(prev, null,')).toBe(true)
  })

  it('App publishes it on the context, so any page can ask for a fresh answer', () => {
    expect(CTX.includes('refreshTeamSession,')).toBe(true)
  })

  it("SessionsSettings' toggle asks for a fresh answer after a successful save — ON and OFF alike", () => {
    // `toggleEditor` computes `next = !editorEnabled` and PUTs it either way, so one call site
    // covers both directions of the switch — there is only one place this could be missing.
    expect(SESSIONS_SETTINGS.includes('const toggleEditor = () => {')).toBe(true)
    expect(SESSIONS_SETTINGS.includes('.then(() => ctx.refreshTeamSession?.())')).toBe(true)
  })

  it('the scan still sees the refresh call going away', () => {
    expect(stripComments('// .then(() => ctx.refreshTeamSession?.())')).not.toContain('ctx.refreshTeamSession?.()')
  })
})

/**
 * AND THE ONE SCREEN THAT CAN TURN IT ON SAYS SO.
 *
 * `SessionsSettings` is where a user flips the switch, so it is the one place a false sentence about
 * the Studio is expensive — and its `editorCapable` reads `CAPS.localShell`, which carries no central
 * term either. On a central under a `local` profile it printed "your profile allows this and you have
 * it ON. Each session gets the Studio in the side panel" over a deployment that refuses every request
 * the Studio makes. It is a rendered component with no jsdom here, so the term is asserted in source.
 */
describe('the settings screen subtracts a central from what it calls capable', () => {
  const SRC = stripComments(readFileSync(join(import.meta.dir, '..', 'pages/settings/SessionsSettings.tsx'), 'utf8'))

  it('reads it, and folds it into `editorCapable`', () => {
    expect(SRC.includes('const editorCentral = ctx.isCentral')).toBe(true)
    expect(SRC.includes("const editorCapable = ctx.capabilities?.localShell !== false && !editorCentral")).toBe(true)
  })

  it('and both unavailable sentences name the central reason apart from the profile one', () => {
    // Two branches, because "this instance cannot" and "a central cannot" send a reader to different
    // places: one is a deployment decision, the other is "go and do this on the machine itself".
    expect([...SRC.matchAll(/editorCentral\s*$/gm)].length + [...SRC.matchAll(/\? editorCentral/g)].length)
      .toBeGreaterThanOrEqual(2)
    expect(SRC.includes('/api/fleet/*')).toBe(true)
  })

  it('the scan still sees the term going away', () => {
    const bare = 'const editorCapable = ctx.capabilities?.localShell !== false\n'
    expect(stripComments(bare).includes('!editorCentral')).toBe(false)
    expect(stripComments(`${bare.trim()} // && !editorCentral\n`).includes('!editorCentral')).toBe(false)
  })
})

/**
 * NO CONSUMER CARRIES THE TERM ANY MORE.
 *
 * A surface that still subtracts a central from a value that has already had one subtracted is
 * harmless arithmetic and a harmful statement: it says the published value cannot be trusted, which
 * is how the per-surface guards got there. This is the shape that shipped, named exactly.
 */
describe('no page re-applies the central term to the published value', () => {
  const WEB = join(import.meta.dir, '..')

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('nobody writes `ctx.editorEnabled === true && !isCentral`', () => {
    const offenders: string[] = []
    for (const file of walk(WEB)) {
      if (/\.test\.tsx?$/.test(file)) continue
      const src = stripComments(readFileSync(file, 'utf8'))
      if (/editorEnabled\s*===\s*true\s*&&\s*!isCentral/.test(src)) offenders.push(file.slice(WEB.length + 1))
    }
    expect(offenders).toEqual([])
  })

  it('the scan still sees that shape', () => {
    expect(/editorEnabled\s*===\s*true\s*&&\s*!isCentral/
      .test(stripComments('const editorEnabled = ctx.editorEnabled === true && !isCentral\n'))).toBe(true)
  })
})
