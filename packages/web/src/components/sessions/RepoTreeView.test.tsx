/**
 * What THIS component adds to an already-tested model.
 *
 * `repoTreeModel.test.ts` owns the tree arithmetic and `repoApi.test.ts` owns the three outcomes of
 * a call; neither is re-asserted here. What is left is the component's own: which rows it draws for
 * a given model state, the three empty states staying three different sentences, and the one piece
 * of behaviour it contributes — "read a directory the FIRST time it is opened, and only then".
 *
 * Rendering is `renderToStaticMarkup`, the same stack `pages/settings/primitives.test.tsx` uses:
 * this repo has no `@testing-library/react`/jsdom configured (see `ConnectionCard.test.tsx`'s own
 * note), so a CLICK cannot be simulated. `toggleDirectory` is therefore exported and takes its
 * loader as an argument, and the "exactly once" fact is asserted by driving it directly — which is
 * what the component's `onClick` does with the same arguments.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RepoTreeView, toggleDirectory, treeViewState, type TreeOps } from './RepoTreeView'
import {
  applyChildren, applyError, makeRootNode, setLoading, toggleExpanded, type TreeNode,
} from '../../lib/repoTreeModel'
import type { TreeListResult } from '../../lib/repoApi'

/**
 * `useIsMobile` reads `window.innerWidth` in its state initializer. Bun's runtime has no DOM, and
 * this file renders to a string rather than to one — so the width is the only thing that has to
 * exist. `useEffect` (where `matchMedia` lives) never runs under `renderToStaticMarkup`.
 */
const env = globalThis as unknown as { window?: { innerWidth: number } }
const windowIsOurs = env.window === undefined
env.window ??= { innerWidth: 1280 }
const desktop = () => { env.window!.innerWidth = 1280 }
const phone = () => { env.window!.innerWidth = 390 }

/**
 * The width is restored in HOOKS, never at the end of a test body. A `phone()` undone by hand is
 * undone only when the test reaches that line, so a throw — or an early `expect` failure — leaves
 * `innerWidth: 390` set for whatever runs next IN THE SAME PROCESS, which here is someone else's
 * test file. `beforeEach` closes the other direction: the `??=` above adopts a `window` another file
 * already created, width and all.
 */
beforeEach(desktop)
afterEach(desktop)
afterAll(() => { if (windowIsOurs) delete env.window })

function noop() { /* the component never changes the tree in these renders */ }

/** None of the tests below drive a tree operation — this view's own chrome is what is asserted. */
const noopOps: TreeOps = {
  renaming: null,
  onRenameStart: noop,
  onRenameChange: noop,
  onRenameCommit: noop,
  onRenameCancel: noop,
  onNewAt: noop,
  onDelete: noop,
  onMovePicker: noop,
  onCopyRelativePath: noop,
  onCopyPath: noop,
  onDropMove: noop,
}

function loadedRoot(): TreeNode {
  return applyChildren(makeRootNode(), '', [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
  ])
}

function render(tree: TreeNode, lang: 'pt' | 'en' = 'en'): string {
  return renderToStaticMarkup(
    <RepoTreeView sessionId="s1" tree={tree} onTreeChange={noop} onOpenFile={noop} lang={lang} ops={noopOps} />,
  )
}

// --- the four states the root can be in ----------------------------------------------------------

describe('treeViewState', () => {
  test('a root nobody has read yet is LOADING, not empty', () => {
    expect(treeViewState(makeRootNode())).toBe('loading')
  })

  test('a root whose read FAILED is failed, even though it also has no children', () => {
    expect(treeViewState(applyError(makeRootNode(), '', 'nope'))).toBe('failed')
  })

  test('a root read to the end and holding nothing is EMPTY — a different fact from either', () => {
    expect(treeViewState(applyChildren(makeRootNode(), '', []))).toBe('empty')
  })

  test('a root with children has rows', () => {
    expect(treeViewState(loadedRoot())).toBe('rows')
  })
})

// --- the three empty states, three sentences -----------------------------------------------------

describe('the empty states', () => {
  test('the root nobody has read draws NOTHING — the parent owns that loader', () => {
    expect(render(makeRootNode())).toBe('')
  })

  test('a failed listing shows the sentence it was given, verbatim', () => {
    const html = render(applyError(makeRootNode(), '', 'Esse caminho não existe mais.'))
    expect(html).toContain('Esse caminho não existe mais.')
  })

  test('a genuinely empty folder says so, in each language', () => {
    const en = render(applyChildren(makeRootNode(), '', []), 'en')
    const pt = render(applyChildren(makeRootNode(), '', []), 'pt')
    expect(en).toContain('empty')
    expect(pt).toContain('vazia')
    expect(en).not.toBe(pt)
  })

  test('empty and failed are never the same box', () => {
    const failed = render(applyError(makeRootNode(), '', 'The repository explorer is off on this machine.'))
    const empty = render(applyChildren(makeRootNode(), '', []))
    expect(failed).not.toBe(empty)
    expect(empty).not.toContain('off on this machine')
  })
})

// --- the marks -----------------------------------------------------------------------------------

/**
 * `fileIcon.test.tsx` owns which glyph a name earns; what is asserted here is that the tree actually
 * ASKS — a row drawing the old generic page for every file would pass every test in that file.
 */
describe('each row wears its own mark', () => {
  test('a file gets its language\u2019s mark and a folder keeps the brand orange', () => {
    const html = render(applyChildren(makeRootNode(), '', [
      { name: 'src', kind: 'dir' },
      { name: 'index.ts', kind: 'file' },
      { name: '.env', kind: 'file' },
    ]))
    // TypeScript blue, from `fileIcon.tsx`'s own HUE table, and the letters it draws.
    expect(html).toContain('#3178c6')
    expect(html).toContain('TS')
    // `.env` is the key, in its own hue — the file whose icon matters most to spot. The hue is the
    // one `fileIcon.tsx`'s HUE table actually holds: the contrast pass recorded in that module's own
    // header darkened it (`env #d1a02a → #af8623`) and this expectation was left naming the old one.
    expect(html).toContain('#af8623')
    // The folder's colour is still the row's, which the delegated glyph inherits.
    expect(html).toContain('var(--anthropic-orange)')
  })

  test('a file nothing recognises keeps the NEUTRAL glyph, and no language hue', () => {
    const html = render(applyChildren(makeRootNode(), '', [{ name: 'data.xyz123', kind: 'file' }]))
    expect(html).toContain('var(--text-tertiary)')
    expect(html).not.toContain('#3178c6')
  })
})

// --- the rows ------------------------------------------------------------------------------------

describe('the rows it draws', () => {
  test('one row per visible node, directories before their children only when expanded', () => {
    const html = render(loadedRoot())
    expect(html).toContain('src')
    expect(html).toContain('README.md')
    expect((html.match(/role="listitem"/g) ?? []).length).toBe(2)
  })

  test('a collapsed directory reports aria-expanded="false"; a file carries none', () => {
    const html = render(loadedRoot())
    expect(html).toContain('aria-expanded="false"')
    expect((html.match(/aria-expanded/g) ?? []).length).toBe(1)
  })

  test('expanding a loaded directory draws its children one level deeper', () => {
    let tree = loadedRoot()
    tree = applyChildren(tree, 'src', [{ name: 'index.ts', kind: 'file' }])
    tree = toggleExpanded(tree, 'src')
    const html = render(tree)
    expect(html).toContain('index.ts')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-level="2"')
  })

  test('depth steps the row in — and the step is left PADDING on a border-box row, so nothing widens', () => {
    let tree = loadedRoot()
    tree = applyChildren(tree, 'src', [{ name: 'index.ts', kind: 'file' }])
    tree = toggleExpanded(tree, 'src')
    const pads = [...render(tree).matchAll(/padding-left:(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]))
    expect(pads.length).toBeGreaterThanOrEqual(2)
    expect(pads[1]).toBeGreaterThan(pads[0]!)
    expect(render(tree)).toContain('box-sizing:border-box')
  })

  test('a directory being read shows the spinning class, not a still glyph', () => {
    const html = render(setLoading(loadedRoot(), 'src', true))
    expect(html).toContain('ag-working-spin')
  })

  test('a directory whose listing was refused KEEPS its row and states why under it', () => {
    const html = render(applyError(loadedRoot(), 'src', 'Permissão negada.'))
    expect(html).toContain('src')
    expect(html).toContain('Permissão negada.')
  })

  test('a root error over rows that did load is still said, never swallowed', () => {
    const tree: TreeNode = { ...loadedRoot(), error: 'The server did not answer.' }
    const html = render(tree)
    expect(html).toContain('The server did not answer.')
    expect(html).toContain('README.md')
  })

  test('every scrolling region contains its overscroll, as this panel requires', () => {
    expect(render(loadedRoot())).toContain('overscroll-behavior:contain')
  })
})

// --- what the container claims, and what it therefore owns ---------------------------------------

/**
 * Where the `<div …>` that opens at `start` closes. These divs NEST — an item holds a row and, when
 * that row's listing failed, the sentence saying so — and the whole point of the assertions below is
 * telling a nested element from a sibling, which no `toContain` on a flat string can do.
 */
function divEnd(html: string, start: number): number {
  let depth = 0
  let i = start
  for (;;) {
    const open = html.indexOf('<div', i)
    const close = html.indexOf('</div>', i)
    if (close === -1) throw new Error('unclosed <div>')
    if (open !== -1 && open < close) { depth++; i = open + 4; continue }
    depth--
    if (depth === 0) return close
    i = close + 6
  }
}

/** Each item's inner HTML, plus everything else the list contains — which must be nothing. */
function listStructure(html: string): { items: string[]; outside: string } {
  const at = html.indexOf('<div role="list"')
  if (at === -1) throw new Error('no role="list" container')
  const items: string[] = []
  let rest = html.slice(html.indexOf('>', at) + 1, divEnd(html, at))
  for (;;) {
    const m = /<div role="listitem"[^>]*>/.exec(rest)
    if (m === null) return { items, outside: rest }
    const end = divEnd(rest, m.index)
    items.push(rest.slice(m.index + m[0].length, end))
    rest = rest.slice(0, m.index) + rest.slice(end + '</div>'.length)
  }
}

describe('the ARIA container owns every child it has', () => {
  test('no `tree` role is claimed — arrow-key tree navigation is not implemented here', () => {
    const html = render(loadedRoot())
    expect(html).not.toContain('role="tree"')
    expect(html).not.toContain('role="treeitem"')
    expect(html).toContain('<div role="list"')
  })

  test('a list holds ONLY listitems — nothing sits inside it that the role does not own', () => {
    const { items, outside } = listStructure(render(loadedRoot()))
    expect(items.length).toBe(2)
    expect(outside.trim()).toBe('')
  })

  test('a row’s failure sentence lives INSIDE that row’s own item, never beside it', () => {
    const { items, outside } = listStructure(render(applyError(loadedRoot(), 'src', 'Permissão negada.')))
    const src = items.find(item => item.includes('>src<'))
    expect(src).toContain('Permissão negada.')
    // Not a stray child of the list, which is the defect the nesting above exists to prevent.
    expect(outside).not.toContain('Permissão negada.')
    expect(items.length).toBe(2)
  })

  test('the root-level banner is said, and is not a child of the list either', () => {
    const tree: TreeNode = { ...loadedRoot(), error: 'The server did not answer.' }
    const html = render(tree)
    expect(html).toContain('The server did not answer.')
    const { outside, items } = listStructure(html)
    expect(outside.trim()).toBe('')
    expect(items.some(item => item.includes('The server did not answer.'))).toBe(false)
  })

  test('depth is carried by the item, which may hold a level — the button may not', () => {
    let tree = loadedRoot()
    tree = applyChildren(tree, 'src', [{ name: 'index.ts', kind: 'file' }])
    tree = toggleExpanded(tree, 'src')
    const html = render(tree)
    expect(/<div role="listitem" aria-level="2"/.test(html)).toBe(true)
    // `aria-level` is not a property the `button` role supports; `aria-expanded` is.
    expect(/<button[^>]*aria-level/.test(html)).toBe(false)
    expect(/<button[^>]*aria-expanded="true"/.test(html)).toBe(true)
  })
})

// --- mobile --------------------------------------------------------------------------------------

describe('mobile', () => {
  test('a row is at least 44px tall on a phone and stays dense on a desktop', () => {
    phone()
    expect(render(loadedRoot())).toContain('min-height:44px')
    desktop()
    expect(render(loadedRoot())).not.toContain('min-height:44px')
  })

  test('the row never sets a width that could exceed its column', () => {
    // The row's own button used to be `width:100%` directly inside the listitem; it is now a
    // `flex:1` sibling of the "⋯" button inside a `.ag-tree-row` wrapper (see the file header's note
    // on why they may never nest) — `flex:1` fills exactly the space the wrapper leaves it and
    // cannot exceed the column any more than `width:100%` could, so this asserts the NEW shape of
    // the same guarantee rather than the literal string the old layout happened to produce.
    phone()
    const html = render(loadedRoot())
    expect(html).toContain('flex:1')
    expect(html).toContain('min-width:0')
    expect(html).toContain('box-sizing:border-box')
    expect(html).toContain('overflow-x:hidden')
  })
})

// --- the one behaviour this component adds -------------------------------------------------------

/** Drives `toggleDirectory` the way the component's `onClick` does, against a tree it keeps. */
function driver(initial: TreeNode, load: (path: string) => Promise<TreeListResult>) {
  let tree = initial
  return {
    get tree() { return tree },
    async toggle(path: string, lang: 'pt' | 'en' = 'en') {
      await toggleDirectory(tree, path, lang, updater => { tree = updater(tree) }, load)
    },
  }
}

function ok(children: { name: string; kind: 'file' | 'dir' }[]): Promise<TreeListResult> {
  return Promise.resolve({ ok: true, children })
}

describe('toggleDirectory', () => {
  test('reads a directory the FIRST time it is opened, and never again', async () => {
    const calls: string[] = []
    const d = driver(loadedRoot(), path => { calls.push(path); return ok([{ name: 'index.ts', kind: 'file' }]) })

    await d.toggle('src')
    expect(calls).toEqual(['src'])

    await d.toggle('src') // collapse
    await d.toggle('src') // open again — the cached children survived the collapse
    expect(calls).toEqual(['src'])
    expect(d.tree.children?.[0]?.children?.map(c => c.name)).toEqual(['index.ts'])
  })

  test('a directory already being read is not read a second time', async () => {
    const calls: string[] = []
    // Collapsed AND loading: the state a second click lands in while the first request is in flight.
    const busy = setLoading(loadedRoot(), 'src', true)
    const d = driver(busy, path => { calls.push(path); return ok([]) })
    await d.toggle('src')
    expect(calls).toEqual([])
  })

  test('collapsing reads nothing', async () => {
    const calls: string[] = []
    const open = toggleExpanded(applyChildren(loadedRoot(), 'src', []), 'src')
    const d = driver(open, path => { calls.push(path); return ok([]) })
    await d.toggle('src')
    expect(calls).toEqual([])
  })

  test('a path that is not in the tree reads nothing and changes nothing', async () => {
    const calls: string[] = []
    const before = loadedRoot()
    const d = driver(before, path => { calls.push(path); return ok([]) })
    await d.toggle('nowhere')
    expect(calls).toEqual([])
    expect(d.tree).toBe(before)
  })

  test('an empty directory loads as EMPTY, not as never-read — re-opening it costs no second call', async () => {
    const calls: string[] = []
    const d = driver(loadedRoot(), path => { calls.push(path); return ok([]) })
    await d.toggle('src')
    expect(d.tree.children?.[0]?.children).toEqual([])
    await d.toggle('src')
    await d.toggle('src')
    expect(calls).toEqual(['src'])
  })

  test('a refusal the server worded lands on the row verbatim', async () => {
    const d = driver(loadedRoot(), () => Promise.resolve({
      ok: false, failure: 'refused', status: 404, reason: 'not-found',
      message: 'Esse diretório não existe mais.',
    } as TreeListResult))
    await d.toggle('src', 'pt')
    expect(d.tree.children?.[0]?.error).toBe('Esse diretório não existe mais.')
    expect(d.tree.children?.[0]?.loading).toBe(false)
  })

  test('a gate refusal carries no sentence, so the UI supplies one in the reader’s language', async () => {
    const gate = () => Promise.resolve({
      ok: false, failure: 'refused', status: 403, reason: 'editor_disabled',
    } as TreeListResult)

    const en = driver(loadedRoot(), gate)
    await en.toggle('src', 'en')
    expect(en.tree.children?.[0]?.error).toContain('Settings → Sessions')

    const pt = driver(loadedRoot(), gate)
    await pt.toggle('src', 'pt')
    expect(pt.tree.children?.[0]?.error).toContain('Configurações → Sessões')
  })

  test('an unreachable server is said too — never a silently empty folder', async () => {
    const d = driver(loadedRoot(), () => Promise.resolve({
      ok: false, failure: 'unreachable', cause: 'network',
    } as TreeListResult))
    await d.toggle('src')
    expect(d.tree.children?.[0]?.error).toBeTruthy()
    // The distinction the whole model rests on: a failed read is NOT a loaded empty directory.
    expect(d.tree.children?.[0]?.children).toBe(null)
  })
})
