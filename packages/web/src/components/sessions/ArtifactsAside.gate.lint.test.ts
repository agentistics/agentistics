/**
 * THE STUDIO IS ABSENT FROM `ArtifactsAside.tsx` — asserted over its own source.
 *
 * It used to be a MODE of this panel (`studio` state, a `Layer` at the component's root, a `StripId`
 * outside `TabId`) — one open flag shared by two components, so opening the Studio lit the Contents
 * button beside it. The Studio is now its own PANEL (`lib/panelSlots.ts`'s `studio`), rendered by
 * `StudioHost.tsx` and placed independently in the `right` or `bottom` slot. See
 * `docs/superpowers/specs/2026-09-12-studio-slots-and-references-design.md` §1.
 *
 * These are the invariants that can regress silently once the two are separate files nothing else
 * forces to agree — each one WAS the shape of the defect this file used to guard against, read the
 * other way round now that the Studio has left:
 *
 *  1. This component imports neither `Layer` nor `Studio` — reaching for either here is reaching for
 *     the old architecture.
 *  2. `StripId` carries no `'studio'` member: it names exactly what this panel's strip and launcher
 *     grid can select, and the Studio is not one of them any more.
 *  3. Nothing in the tabs array, `pickStrip`, or the `tabRequest` effect ever names `'studio'`.
 *  4. `editorEnabled` / `editorAutosave` are gone from `ArtifactsAsideProps` — they gated the Studio
 *     alone, and this component has nothing left to gate.
 *
 * There is no jsdom and no `@testing-library/react` here, so none of it is reachable by rendering:
 * the source is what there is to assert against, in the shape `monacoEntry.lint.test.ts` and
 * `tokens.lint.test.ts` already use here.
 *
 * **COMMENTS ARE STRIPPED FIRST.** The file names `Studio` and `editorEnabled` in prose throughout —
 * explaining why they are gone — so a raw grep would be satisfied by the very comment recording the
 * fix. `lib/stripComments.ts` is the one stripper this repo trusts for exactly that reason.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const ASIDE = join(import.meta.dir, 'ArtifactsAside.tsx')

const code = stripComments
const raw = readFileSync(ASIDE, 'utf8')
const src = code(raw)

const has = (needle: string) => src.includes(needle)

/** The strip array literal, on its own — so "inside the tabs" is a question with an answer. */
function tabsArray(s: string): string {
  const start = s.indexOf('const tabs:')
  if (start < 0) throw new Error('ArtifactsAside.gate.lint: the tabs array is no longer `const tabs:`')
  const end = s.indexOf('\n  ]\n', start)
  if (end < 0) throw new Error('ArtifactsAside.gate.lint: cannot find the end of the tabs array')
  return s.slice(start, end)
}

/** The declaration of one type alias, as written. */
function alias(s: string, name: string): string {
  const m = new RegExp(`type ${name} =[^\\n]*`).exec(s)
  if (m === null) throw new Error(`ArtifactsAside.gate.lint: no \`type ${name}\` to read`)
  return m[0]
}

describe('the file this reads is the real one', () => {
  it('read something, and read the right thing', () => {
    // An empty or mis-rooted read would make every assertion below pass by examining nothing.
    expect(raw.length).toBeGreaterThan(30_000)
    expect(has('export function ArtifactsAside(')).toBe(true)
    expect(tabsArray(src).length).toBeGreaterThan(300)
  })
})

describe('the Studio has left this component entirely', () => {
  it('imports neither Layer nor Studio', () => {
    expect(has("from './Studio'")).toBe(false)
    expect(src).not.toMatch(/\bLayer\b/)
  })

  it("'studio' is not a StripId — the type is exactly TabId, no wider", () => {
    expect(alias(src, 'StripId')).toBe('type StripId = TabId')
  })

  it('the tabs array names no studio entry', () => {
    expect(tabsArray(src)).not.toContain("id: 'studio'")
  })

  it('nothing routes a strip id, a tab request or a click to `studio`', () => {
    expect(has("setTab('studio')")).toBe(false)
    expect(has("'studio'")).toBe(false)
  })

  it('the render mounts no Studio and no Layer', () => {
    expect(src).not.toMatch(/<Studio\b/)
    expect(src).not.toMatch(/<Layer\b/)
    expect(has('studioMounted')).toBe(false)
    expect(has('inStudio')).toBe(false)
  })

  it('the props this component no longer needs are gone', () => {
    expect(has('editorEnabled')).toBe(false)
    expect(has('editorAutosave')).toBe(false)
  })

  it('the two file lists are gone from the tabs, not merely hidden', () => {
    const t = alias(src, 'TabId')
    expect(t).not.toContain("'files'")
    expect(t).not.toContain("'docs'")
    expect(has('const fileList =')).toBe(false)
    expect(src).not.toMatch(/const docs = useMemo/)
  })

  it('the scan still sees the defect it exists to catch', () => {
    // The old shape, reintroduced by hand — this is what a regression would look like.
    const widened = "type StripId = TabId | 'studio'\n"
    expect(alias(code(widened), 'StripId')).not.toBe('type StripId = TabId')
    expect(code("import { Layer, Studio } from './Studio'")).toContain("from './Studio'")
    expect(code("<Studio sessionId={sessionId} onExit={onExit} />")).toMatch(/<Studio\b/)
    // The comment form must not satisfy any of the above.
    expect(code("// this panel used to import { Layer, Studio } from './Studio'"))
      .not.toContain("from './Studio'")
    expect(code('/* never write <Studio /> here again */')).not.toMatch(/<Studio\b/)
  })
})

describe('the fourth copy of the empty-region Note is gone', () => {
  it('imports the shared one and declares none of its own', () => {
    expect(has("import { RepoNote as Note } from './repoNote'")).toBe(true)
    expect(src).not.toMatch(/function Note\s*\(/)
  })

  it('the scan still sees a re-declared Note', () => {
    expect(code('function Note({ text }: { text: string }) { return null }')).toMatch(/function Note\s*\(/)
    expect(code('// function Note(...) used to live here')).not.toMatch(/function Note\s*\(/)
  })
})

/**
 * THE HEADER COUNT CARRIES ITS OWN CAVEATS — the other thing in this file that can go dead silently.
 *
 * `N files · M new` is the only surviving statement of how many files a session wrote, and it
 * undercounts twice over: writes whose paths cannot be read at all, and writes outside the session's
 * folder that cannot be OPENED here. Both sentences had surfaces on the Files and Docs tabs, both
 * lost them when those tabs went, and one of the two producers went on computing for a release with
 * nothing reading it. `noUnusedLocals` is off in this package, so a prop that stops being rendered
 * breaks nothing and says nothing.
 *
 * The wording and the ORDER live in `artifactShortfall` (`lib/sessionArtifacts.ts`), which has its
 * own tests; what is asserted here is that this panel still spends it, and spends it in the HEADER —
 * the one piece of chrome every tab shares, which is why it covers the gallery and the live feed too.
 */
describe('the two caveats on the header count are rendered, not merely received', () => {
  it('both props are declared and destructured', () => {
    expect(has('unlistedWrites?: boolean')).toBe(true)
    expect(has('outsideNote?: string')).toBe(true)
    expect(src).toMatch(/export function ArtifactsAside\(\{[\s\S]*?unlistedWrites, outsideNote,[\s\S]*?\}: ArtifactsAsideProps\)/)
  })

  it('the sentences come from `artifactShortfall`, never composed here', () => {
    expect(has("import { artifactShortfall, type Artifact } from '../../lib/sessionArtifacts'")).toBe(true)
    expect(has('const shortfall = artifactShortfall({')).toBe(true)
    // The server's `outside` is passed through, not inspected or reworded.
    expect(has('{ outside: outsideNote }')).toBe(true)
  })

  it('and they are spent INSIDE the header, after the count', () => {
    const headerAt = src.indexOf('const header = (')
    const countAt = src.indexOf('{artifacts.length} {pt ?')
    const linesAt = src.indexOf('{shortfall.map(line => (')
    expect(headerAt).toBeGreaterThan(-1)
    expect(countAt).toBeGreaterThan(headerAt)
    expect(linesAt).toBeGreaterThan(countAt)
    // Inside the header element, not after it: the tab body begins at the tabs array.
    expect(linesAt).toBeLessThan(src.indexOf('const tabs:'))
  })

  it('the scan still sees the render going away', () => {
    expect(code('{/* {shortfall.map(line => (<p>{line}</p>))} */}'))
      .not.toContain('{shortfall.map(line => (')
    expect(code('// const shortfall = artifactShortfall({')).not.toContain('const shortfall =')
  })
})
