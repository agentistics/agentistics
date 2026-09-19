# Repository Explorer — Phase 2 (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new **Repositório / Repository** tab in `ArtifactsAside.tsx`: a lazy, gitignore-aware
file tree with name/content search, a self-hosted Monaco editor with multiple open tabs, Ctrl+S
save with an opt-in autosave (off by default), create/rename/delete, a conflict prompt that never
lets a save silently clobber an agent's own write, a live-agent badge, and a Settings toggle —
working end to end for both a live session and a closed/historical one, on desktop and at 390px.

**Architecture:** Three PURE client-side modules (language-id mapping, the tree/tabs view model,
nothing else needs to be pure on this side) plus a thin typed fetch layer (`repoApi.ts`) over
Phase 1's seven routes, plus new presentational components composed into a `RepositoryTab` that
plugs into `ArtifactsAside.tsx` exactly where the Files tab's own "list layer, document layer"
pattern already lives.

**Tech Stack:** React 19, TypeScript (strict), Vite 8, `monaco-editor` (new dependency, self-hosted,
no CDN — see Task 4), `bun:test` with a mocked `fetch` for the API layer.

**Spec:** `docs/superpowers/specs/2026-09-11-repository-explorer-aside-design.md` — "Frontend"
section, plus "Live-agent indicator", "Conflict handling", and every "Deferred" / "Out of scope"
bullet, which this plan does **not** implement.

**Depends on:** `docs/superpowers/plans/2026-09-11-repository-explorer-phase1-backend.md`, merged
and deployed on the dev server this plan is verified against. The seven routes, the resolved
`editorEnabled` field on `GET /api/team/session`, and `Preferences.editorEnabled` /
`Preferences.editorAutosave` are all assumed to exist and work exactly as that plan built them.

**Task:** t-9a15db678d — "repositório disponivel no aside da direita" (subtask s-628feee061).

## Global Constraints

- **Language:** code and comments are English; commit messages follow this repo's actual practice — Conventional Commits type prefix in English, description in Portuguese — matching PR #511 and PR #525 for this same task.
- **Worktree:** `.claude/worktrees/repo-explorer`, branch `feat/repo-explorer-aside`, based on `origin/dev` — the same worktree Phase 1 was built in. Do not create a second worktree for this phase.
- **Pre-commit hook runs `bun tsc --noEmit` and the full `bun test`.** Both must pass on every commit.
- **Never stage with `git add -A`.**
- **The tab is ABSENT, not disabled, when the gate is closed.** Read `ctx.editorEnabled` (the RESOLVED flag from `GET /api/team/session`, built in Phase 1 Task 1) — never re-derive capability + preference client-side, and never render a greyed-out tab.
- **No new backend routes or server-side files in this phase.** Everything here consumes the seven routes Phase 1 already built. If a gap is found, it is a Phase 1 defect to fix there, not something to patch around here.
- **Self-hosted, no CDN** — same rule this whole product already follows for every other heavy dependency. Monaco's worker(s) are bundled by Vite, never fetched from a CDN.
- **Monaco loads lazily** — dynamic `import()` the first time the Repository tab is opened, never in the main bundle.
- **Mobile is not a follow-up.** Per this project's own CLAUDE.md: "EVERY new screen and EVERY layout fix MUST also deliver its mobile version — no exceptions." Task 12 builds the "layers, not split" swap for both widths in the same task; Task 13 verifies at 390px before this is called done.
- **Verify with a PROBE session, never the user's own live sessions** — when Task 13 drives the browser, spawn a disposable session to test against (`agentop session new` or equivalent), and never attach Playwright to a session the user is actively using.
- **Touch targets ≥ 44px on the mobile tree/toolbar** — the 44px rule is mobile-only; do not apply it to the desktop tree rows, which are dense by design like every other list in this aside.
- **`overscroll-behavior: contain`** on every new scrolling region inside the tab, matching `ArtifactsAside.tsx`'s own header comment about why every scroller in this panel needs it.

---

## Task 1: `monacoLanguage.ts` — file extension → Monaco language id

**Files:**
- Create: `packages/web/src/lib/monacoLanguage.ts`
- Create: `packages/web/src/lib/monacoLanguage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `languageForPath(path: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/monacoLanguage.test.ts
import { describe, expect, test } from 'bun:test'
import { languageForPath } from './monacoLanguage'

describe('languageForPath', () => {
  test('maps common extensions to Monaco language ids', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript')
    expect(languageForPath('src/a.tsx')).toBe('typescript')
    expect(languageForPath('src/a.js')).toBe('javascript')
    expect(languageForPath('a.json')).toBe('json')
    expect(languageForPath('README.md')).toBe('markdown')
    expect(languageForPath('style.css')).toBe('css')
    expect(languageForPath('index.html')).toBe('html')
    expect(languageForPath('script.py')).toBe('python')
    expect(languageForPath('main.go')).toBe('go')
    expect(languageForPath('lib.rs')).toBe('rust')
  })
  test('is case-insensitive on the extension', () => {
    expect(languageForPath('A.TS')).toBe('typescript')
  })
  test('Dockerfile has no extension and is matched by its bare name', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('deploy/Dockerfile')).toBe('dockerfile')
  })
  test('an unknown extension falls back to plaintext, never throws', () => {
    expect(languageForPath('data.xyz123')).toBe('plaintext')
  })
  test('a file with no extension at all is plaintext', () => {
    expect(languageForPath('LICENSE')).toBe('plaintext')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/repo-explorer
bun test packages/web/src/lib/monacoLanguage.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/lib/monacoLanguage.ts
/**
 * monacoLanguage.ts — PURE: which Monaco language id a file's own name implies.
 *
 * v1 deliberately runs Monaco with NO language services (no TypeScript/JS type-checking, no
 * inline diagnostics — see the design spec's "Deferred" list), so this mapping only has to name a
 * language Monaco's bundled Monarch grammars can tokenize for syntax highlighting; it does not
 * need to distinguish "has a language service" from "syntax only".
 */

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html',
  yml: 'yaml', yaml: 'yaml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', xml: 'xml', toml: 'toml',
  graphql: 'graphql', vue: 'vue', svelte: 'plaintext',
}

const NAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

export function languageForPath(path: string): string {
  const base = (path.split('/').pop() ?? path).toLowerCase()
  const byName = NAME_LANGUAGE[base]
  if (byName) return byName
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  const ext = base.slice(dot + 1)
  return EXT_LANGUAGE[ext] ?? 'plaintext'
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/web/src/lib/monacoLanguage.test.ts
bun tsc --noEmit
```

Expected: 5 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/monacoLanguage.ts packages/web/src/lib/monacoLanguage.test.ts
git commit -m "feat(web): mapeamento de extensão de arquivo pra linguagem do Monaco"
```

---

## Task 2: `repoTreeModel.ts` — the tree and open-tabs view model

**Files:**
- Create: `packages/web/src/lib/repoTreeModel.ts`
- Create: `packages/web/src/lib/repoTreeModel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TreeChild`, `TreeNode`, `FlatRow`, `makeRootNode()`, `setLoading`, `applyChildren`, `applyError`, `toggleExpanded`, `flattenVisible`; `OpenTab`, `openTab`, `closeTab`, `markDirty`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/repoTreeModel.test.ts
import { describe, expect, test } from 'bun:test'
import {
  applyChildren, applyError, closeTab, flattenVisible, makeRootNode, markDirty, openTab,
  setLoading, toggleExpanded, type TreeChild,
} from './repoTreeModel'

describe('the tree model', () => {
  test('a fresh root has no children and nothing visible', () => {
    expect(flattenVisible(makeRootNode())).toEqual([])
  })

  test('applying children at the root makes them visible, in the order given', () => {
    const kids: TreeChild[] = [{ name: 'src', kind: 'dir' }, { name: 'a.ts', kind: 'file' }]
    const root = applyChildren(makeRootNode(), '', kids)
    expect(flattenVisible(root)).toEqual([
      { path: 'src', name: 'src', kind: 'dir', depth: 0, expanded: false, loading: false },
      { path: 'a.ts', name: 'a.ts', kind: 'file', depth: 0, expanded: false, loading: false },
    ])
  })

  test('an unexpanded directory shows no children even after they are loaded', () => {
    let root = applyChildren(makeRootNode(), '', [{ name: 'src', kind: 'dir' }])
    root = applyChildren(root, 'src', [{ name: 'a.ts', kind: 'file' }])
    expect(flattenVisible(root).map(r => r.path)).toEqual(['src'])
  })

  test('expanding a directory reveals its already-loaded children, nested one level deeper', () => {
    let root = applyChildren(makeRootNode(), '', [{ name: 'src', kind: 'dir' }])
    root = applyChildren(root, 'src', [{ name: 'a.ts', kind: 'file' }])
    root = toggleExpanded(root, 'src')
    expect(flattenVisible(root)).toEqual([
      { path: 'src', name: 'src', kind: 'dir', depth: 0, expanded: true, loading: false },
      { path: 'src/a.ts', name: 'a.ts', kind: 'file', depth: 1, expanded: false, loading: false },
    ])
  })

  test('collapsing does not throw away the cached children — re-expanding needs no fetch', () => {
    let root = applyChildren(makeRootNode(), '', [{ name: 'src', kind: 'dir' }])
    root = applyChildren(root, 'src', [{ name: 'a.ts', kind: 'file' }])
    root = toggleExpanded(root, 'src') // open
    root = toggleExpanded(root, 'src') // close
    root = toggleExpanded(root, 'src') // open again — no applyChildren call between these
    expect(flattenVisible(root).map(r => r.path)).toEqual(['src', 'src/a.ts'])
  })

  test('setLoading marks one node without disturbing its siblings', () => {
    let root = applyChildren(makeRootNode(), '', [{ name: 'src', kind: 'dir' }, { name: 'b.ts', kind: 'file' }])
    root = setLoading(root, 'src', true)
    const rows = flattenVisible(root)
    expect(rows.find(r => r.path === 'src')?.loading).toBe(true)
    expect(rows.find(r => r.path === 'b.ts')?.loading).toBe(false)
  })

  test('applyError records a message on the node and clears loading', () => {
    let root = applyChildren(makeRootNode(), '', [{ name: 'src', kind: 'dir' }])
    root = setLoading(root, 'src', true)
    root = applyError(root, 'src', 'refused')
    const row = flattenVisible(root).find(r => r.path === 'src')!
    expect(row.loading).toBe(false)
    expect(row.error).toBe('refused')
  })

  test('a nested path is built by joining segments with "/"', () => {
    let root = applyChildren(makeRootNode(), '', [{ name: 'src', kind: 'dir' }])
    root = toggleExpanded(root, 'src')
    root = applyChildren(root, 'src', [{ name: 'deep', kind: 'dir' }])
    root = toggleExpanded(root, 'src/deep')
    root = applyChildren(root, 'src/deep', [{ name: 'x.ts', kind: 'file' }])
    expect(flattenVisible(root).map(r => r.path)).toEqual(['src', 'src/deep', 'src/deep/x.ts'])
  })
})

describe('the open-tabs model', () => {
  test('opening a new path appends it', () => {
    expect(openTab([], 'a.ts')).toEqual([{ path: 'a.ts', dirty: false }])
  })
  test('opening an already-open path is a no-op — the caller just activates it', () => {
    const tabs = openTab([], 'a.ts')
    expect(openTab(tabs, 'a.ts')).toEqual(tabs)
  })
  test('closeTab removes exactly the named tab', () => {
    const tabs = openTab(openTab([], 'a.ts'), 'b.ts')
    expect(closeTab(tabs, 'a.ts')).toEqual([{ path: 'b.ts', dirty: false }])
  })
  test('markDirty flips one tab without touching the others', () => {
    const tabs = openTab(openTab([], 'a.ts'), 'b.ts')
    const out = markDirty(tabs, 'a.ts', true)
    expect(out).toEqual([{ path: 'a.ts', dirty: true }, { path: 'b.ts', dirty: false }])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/web/src/lib/repoTreeModel.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/lib/repoTreeModel.ts
/**
 * repoTreeModel.ts — PURE: the lazy tree's shape, and the open-tabs strip's shape.
 *
 * The tree is a plain recursive structure keyed by PATH (root-relative, '/'-joined, '' for the
 * root itself) — every update below finds a node by walking the tree and replacing the matched
 * node with a new one, which is what keeps the whole thing trivially testable without React.
 *
 * COLLAPSING NEVER DROPS CACHED CHILDREN. A directory's `children` stays populated after it is
 * collapsed; only `expanded` flips. Re-opening it is then instant and costs no fetch — the caller
 * only calls the `/api/fleet/tree` route the FIRST time a directory's `children` is still `null`.
 */

export interface TreeChild {
  name: string
  kind: 'file' | 'dir'
}

export interface TreeNode {
  path: string
  name: string
  kind: 'file' | 'dir'
  expanded: boolean
  loading: boolean
  /** `null` = never loaded. An empty array is a real, loaded, empty directory. */
  children: TreeNode[] | null
  error?: string
}

export function makeRootNode(): TreeNode {
  return { path: '', name: '', kind: 'dir', expanded: true, loading: false, children: null }
}

function updateNode(node: TreeNode, path: string, fn: (n: TreeNode) => TreeNode): TreeNode {
  if (node.path === path) return fn(node)
  if (!node.children) return node
  return { ...node, children: node.children.map(c => updateNode(c, path, fn)) }
}

export function setLoading(root: TreeNode, path: string, loading: boolean): TreeNode {
  return updateNode(root, path, n => ({ ...n, loading }))
}

export function applyChildren(root: TreeNode, path: string, children: readonly TreeChild[]): TreeNode {
  return updateNode(root, path, n => ({
    ...n,
    loading: false,
    error: undefined,
    children: children.map(c => ({
      path: path === '' ? c.name : `${path}/${c.name}`,
      name: c.name,
      kind: c.kind,
      expanded: false,
      loading: false,
      children: null,
    })),
  }))
}

export function applyError(root: TreeNode, path: string, error: string): TreeNode {
  return updateNode(root, path, n => ({ ...n, loading: false, error }))
}

export function toggleExpanded(root: TreeNode, path: string): TreeNode {
  return updateNode(root, path, n => ({ ...n, expanded: !n.expanded }))
}

export interface FlatRow {
  path: string
  name: string
  kind: 'file' | 'dir'
  depth: number
  expanded: boolean
  loading: boolean
  error?: string
}

/** Depth-first, only what is currently EXPANDED — this is what the virtualized list renders. */
export function flattenVisible(root: TreeNode): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (node: TreeNode, depth: number) => {
    const row: FlatRow = {
      path: node.path, name: node.name, kind: node.kind, depth,
      expanded: node.expanded, loading: node.loading,
    }
    if (node.error !== undefined) row.error = node.error
    out.push(row)
    if (node.kind === 'dir' && node.expanded && node.children) {
      for (const c of node.children) walk(c, depth + 1)
    }
  }
  if (root.children) for (const c of root.children) walk(c, 0)
  return out
}

export interface OpenTab {
  path: string
  dirty: boolean
}

export function openTab(tabs: readonly OpenTab[], path: string): OpenTab[] {
  if (tabs.some(t => t.path === path)) return [...tabs]
  return [...tabs, { path, dirty: false }]
}

export function closeTab(tabs: readonly OpenTab[], path: string): OpenTab[] {
  return tabs.filter(t => t.path !== path)
}

export function markDirty(tabs: readonly OpenTab[], path: string, dirty: boolean): OpenTab[] {
  return tabs.map(t => (t.path === path ? { ...t, dirty } : t))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/web/src/lib/repoTreeModel.test.ts
bun tsc --noEmit
```

Expected: 12 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/repoTreeModel.ts packages/web/src/lib/repoTreeModel.test.ts
git commit -m "feat(web): modelo puro da árvore preguiçosa e das abas abertas do editor"
```

---

## Task 3: `repoApi.ts` — typed fetch wrappers over Phase 1's routes

**Files:**
- Create: `packages/web/src/lib/repoApi.ts`
- Create: `packages/web/src/lib/repoApi.test.ts`

**Interfaces:**
- Consumes: `fetch` (global, mocked in tests).
- Produces: `fetchTree`, `searchRepo`, `readRepoFile`, `writeRepoFile`, `createRepoEntry`, `renameRepoEntry`, `deleteRepoEntry`, and their result types (`TreeListResult`, `SearchHit`, `SearchResult`, `ReadFileResult`, `WriteFileResult`, `EntryResult`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/repoApi.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  createRepoEntry, deleteRepoEntry, fetchTree, readRepoFile, renameRepoEntry, searchRepo, writeRepoFile,
} from './repoApi'

const originalFetch = globalThis.fetch

function mockJson(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

describe('repoApi', () => {
  afterEach(() => { globalThis.fetch = originalFetch })

  test('fetchTree calls GET /api/fleet/tree with id and path, encoded', async () => {
    let seenUrl = ''
    globalThis.fetch = mock((url: string) => { seenUrl = url; return mockJson({ ok: true, children: [] }) }) as never
    const out = await fetchTree('s 1', 'a b/c')
    expect(seenUrl).toBe('/api/fleet/tree?id=s%201&path=a%20b%2Fc')
    expect(out).toEqual({ ok: true, children: [] })
  })

  test('searchRepo calls GET /api/fleet/tree/search with id and q', async () => {
    let seenUrl = ''
    globalThis.fetch = mock((url: string) => { seenUrl = url; return mockJson({ ok: true, hits: [], truncated: false }) }) as never
    await searchRepo('s1', 'needle')
    expect(seenUrl).toBe('/api/fleet/tree/search?id=s1&q=needle')
  })

  test('readRepoFile calls GET /api/fleet/tree/file', async () => {
    globalThis.fetch = mock(() => mockJson({ ok: true, content: 'x', mtimeMs: 1 })) as never
    const out = await readRepoFile('s1', 'a.ts')
    expect(out).toEqual({ ok: true, content: 'x', mtimeMs: 1 })
  })

  test('writeRepoFile PUTs content and mtimeMs as JSON', async () => {
    let seenInit: RequestInit | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => { seenInit = init; return mockJson({ ok: true, mtimeMs: 2 }) }) as never
    const out = await writeRepoFile('s1', 'a.ts', 'new content', 1)
    expect(seenInit?.method).toBe('PUT')
    expect(JSON.parse(String(seenInit?.body))).toEqual({ content: 'new content', mtimeMs: 1 })
    expect(out).toEqual({ ok: true, mtimeMs: 2 })
  })

  test('writeRepoFile surfaces a conflict result verbatim, including the current disk content', async () => {
    globalThis.fetch = mock(() => mockJson(
      { ok: false, reason: 'conflict', content: 'on disk now', mtimeMs: 9, message: 'changed' }, 409,
    )) as never
    const out = await writeRepoFile('s1', 'a.ts', 'my edit', 1)
    expect(out).toEqual({ ok: false, reason: 'conflict', content: 'on disk now', mtimeMs: 9, message: 'changed' })
  })

  test('createRepoEntry POSTs id, path and kind', async () => {
    let seenInit: RequestInit | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => { seenInit = init; return mockJson({ ok: true }) }) as never
    await createRepoEntry('s1', 'new.txt', 'file')
    expect(seenInit?.method).toBe('POST')
    expect(JSON.parse(String(seenInit?.body))).toEqual({ id: 's1', path: 'new.txt', kind: 'file' })
  })

  test('renameRepoEntry PATCHes id, from and to', async () => {
    let seenInit: RequestInit | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => { seenInit = init; return mockJson({ ok: true }) }) as never
    await renameRepoEntry('s1', 'a.txt', 'b.txt')
    expect(seenInit?.method).toBe('PATCH')
    expect(JSON.parse(String(seenInit?.body))).toEqual({ id: 's1', from: 'a.txt', to: 'b.txt' })
  })

  test('deleteRepoEntry DELETEs with recursive as a query flag', async () => {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    globalThis.fetch = mock((url: string, init: RequestInit) => { seenUrl = url; seenInit = init; return mockJson({ ok: true }) }) as never
    await deleteRepoEntry('s1', 'dir', true)
    expect(seenUrl).toBe('/api/fleet/tree/entry?id=s1&path=dir&recursive=1')
    expect(seenInit?.method).toBe('DELETE')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/web/src/lib/repoApi.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/lib/repoApi.ts
/**
 * repoApi.ts — typed fetch wrappers over the repository explorer's backend routes
 * (`docs/superpowers/plans/2026-09-11-repository-explorer-phase1-backend.md`, Task 11's table).
 *
 * Every result type mirrors the server's own JSON shape verbatim — never re-shaped here — so a
 * refusal's `reason` and `message` reach the UI exactly as the server decided them.
 */

export interface TreeChild { name: string; kind: 'file' | 'dir' }

export type TreeListResult =
  | { ok: true; children: TreeChild[] }
  | { ok: false; reason: string; message: string }

export async function fetchTree(sessionId: string, path: string): Promise<TreeListResult> {
  const url = `/api/fleet/tree?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
  const res = await fetch(url)
  return res.json()
}

export interface NameHit { kind: 'name'; path: string }
export interface ContentHit { kind: 'content'; path: string; line: number; text: string }
export type SearchHit = NameHit | ContentHit

export type SearchResult =
  | { ok: true; hits: SearchHit[]; truncated: boolean }
  | { ok: false; reason: string; message: string }

export async function searchRepo(sessionId: string, q: string): Promise<SearchResult> {
  const url = `/api/fleet/tree/search?id=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}`
  const res = await fetch(url)
  return res.json()
}

export type ReadFileResult =
  | { ok: true; content: string; mtimeMs: number }
  | { ok: true; binary: true; name: string; size: number }
  | { ok: false; reason: string; message: string }

export async function readRepoFile(sessionId: string, path: string): Promise<ReadFileResult> {
  const url = `/api/fleet/tree/file?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
  const res = await fetch(url)
  return res.json()
}

export type WriteFileResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'conflict'; content: string; mtimeMs: number; message: string }
  | { ok: false; reason: string; message: string }

export async function writeRepoFile(
  sessionId: string, path: string, content: string, mtimeMs: number,
): Promise<WriteFileResult> {
  const url = `/api/fleet/tree/file?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, mtimeMs }),
  })
  return res.json()
}

export type EntryResult = { ok: true } | { ok: false; reason: string; message: string }

export async function createRepoEntry(sessionId: string, path: string, kind: 'file' | 'dir'): Promise<EntryResult> {
  const res = await fetch('/api/fleet/tree/entry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionId, path, kind }),
  })
  return res.json()
}

export async function renameRepoEntry(sessionId: string, from: string, to: string): Promise<EntryResult> {
  const res = await fetch('/api/fleet/tree/entry', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionId, from, to }),
  })
  return res.json()
}

export async function deleteRepoEntry(sessionId: string, path: string, recursive: boolean): Promise<EntryResult> {
  const url = `/api/fleet/tree/entry?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
    + (recursive ? '&recursive=1' : '')
  const res = await fetch(url, { method: 'DELETE' })
  return res.json()
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/web/src/lib/repoApi.test.ts
bun tsc --noEmit
```

Expected: 8 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/repoApi.ts packages/web/src/lib/repoApi.test.ts
git commit -m "feat(web): cliente HTTP tipado pras rotas do explorador de repositório"
```

---

## Task 4: Monaco + Vite — the self-hosted, lazy-loaded editor engine

**Files:**
- Modify: `packages/web/package.json` (add `monaco-editor`)
- Modify: `packages/web/vite.config.ts`
- Create: `packages/web/src/lib/monacoSetup.ts`

No unit test in this task — it is build/runtime wiring with no pure logic of its own. It is
verified by Task 13's manual pass (an editor that actually renders and highlights syntax) and,
more immediately, by the production build succeeding in Step 4 below.

- [ ] **Step 1: Add the dependency**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/repo-explorer
bun add monaco-editor --cwd packages/web
```

- [ ] **Step 2: Tell Vite to bundle workers as ES modules**

Monaco's worker entry points are ES modules; Vite's default worker output format needs to be set
explicitly for `?worker` imports to resolve correctly. Modify `packages/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const apiPort = process.env.PORT ?? '47291'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: false, suppressWarnings: true, type: 'module' },
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  // Monaco's own worker entry points (`editor.worker.js` and friends) are ES modules; Vite's
  // `?worker` import needs this set explicitly to bundle them correctly rather than falling back
  // to its 'iife' default, which Monaco's workers are not written to support.
  worker: {
    format: 'es',
  },
  server: {
    allowedHosts: true,
    host: true,
    port: Number(process.env.WEB_PORT ?? 47292),
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
```

- [ ] **Step 3: Write `monacoSetup.ts`**

```ts
// packages/web/src/lib/monacoSetup.ts
/**
 * monacoSetup.ts — self-hosted Monaco, no CDN, loaded only when the Repository tab is opened.
 *
 * v1 deliberately runs Monaco with NO LANGUAGE SERVICES (no TypeScript/JS type-checking, no
 * inline diagnostics — see the design spec's "Deferred" list), which is why the only worker this
 * app bundles is the base editor worker: every language still gets Monarch-grammar syntax
 * highlighting (bundled with `monaco-editor` for ~60 languages, see `monacoLanguage.ts`) with no
 * worker of its own. Without SOME `MonacoEnvironment.getWorker`, Monaco falls back to fetching a
 * worker script from a CDN — the one thing this product refuses everywhere — so this file exists
 * even though it wires up exactly one worker type.
 *
 * When language services are added later (the follow-up this spec explicitly defers), this is the
 * one place to add `json.worker` / `css.worker` / `html.worker` / `ts.worker` to the label switch
 * below — each is loaded with its own `?worker` import, exactly like `EditorWorker`, and the whole
 * point of that pattern is that importing the WRAPPER costs nothing: Vite fetches the actual heavy
 * worker bundle only the moment something calls `new XWorker()`, never at import time.
 */
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

let armed = false

function arm() {
  if (armed) return
  armed = true
  ;(self as unknown as { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = {
    getWorker() {
      return new EditorWorker()
    },
  }
}

/**
 * Call before the first `monaco.editor.create`. The dynamic `import('monaco-editor')` is what
 * keeps the ~2 MB library out of the main bundle — it is only ever fetched once the Repository
 * tab's editor actually mounts.
 */
export async function loadMonaco() {
  arm()
  return import('monaco-editor')
}
```

- [ ] **Step 4: Confirm the production build still succeeds**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/repo-explorer
bun run build
```

Expected: the Vite build completes without error. Nothing imports `monacoSetup.ts` yet (Task 8
does), so this step is only confirming the config change itself does not break the build — a
broken `worker: { format: 'es' }` setting or a missing dependency would fail here immediately,
before any component code depends on it.

- [ ] **Step 5: Commit**

```bash
git add packages/web/package.json packages/web/vite.config.ts packages/web/src/lib/monacoSetup.ts packages/server/server/embedded-dist.generated.ts
git commit -m "feat(web): monaco self-hospedado e preguiçoso, sem CDN, via workers do vite"
```

Note: `packages/server/server/embedded-dist.generated.ts` is gitignored (per this project's own
CLAUDE.md) and should not actually be staged — if `git add -A` habits sneak it in, drop it from
the commit; it is listed here only in case `bun run build` regenerated it and a diff tool flags it.

---

## Task 5: The Settings toggle, and threading `editorEnabled` / `editorAutosave` to the aside

**Files:**
- Modify: `packages/web/src/lib/app-context.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/pages/settings/SessionsSettings.tsx`
- Modify: `packages/web/src/pages/SessionsPage.tsx`

No new pure logic here — this task is wiring, mirrored line-for-line from the existing
`shellEnabled` plumbing. It is verified by Task 13's manual pass (toggle off → no tab; toggle on
→ tab appears) rather than a unit test, matching how `shellEnabled`'s own threading has none
either.

- [ ] **Step 1: Add the two fields to `AppContext`**

In `packages/web/src/lib/app-context.ts`, next to the existing `shellEnabled?: boolean` (around
line 191):

```ts
  /** What `/api/fleet/tree*` will ACTUALLY answer: the capability AND the user's switch — the
   *  resolved value from `GET /api/team/session`. The Repository tab is absent, not disabled,
   *  when this is not `true`. See `sessions/editor-gate.ts` on the server. */
  editorEnabled?: boolean
  /** The user's own autosave preference for the Repository tab's editor. Off by default. */
  editorAutosave?: boolean
```

- [ ] **Step 2: Thread it through `App.tsx`**

Add the same two fields to the local `capabilities`-adjacent type in `App.tsx` (around line 137,
next to `shellEnabled?: boolean`):

```ts
  editorEnabled?: boolean
  editorAutosave?: boolean
```

At the `teamSession` fetch/state population (around line 3013, next to `shellEnabled:
teamSession?.shellEnabled === true`):

```ts
    editorEnabled: teamSession?.editorEnabled === true,
```

`editorAutosave` is a plain user preference, not a resolved capability, so it is fetched the same
way `SessionsSettings.tsx` already fetches `shellEnabled` from `GET /api/preferences` (Step 3
below) rather than from `teamSession` — it does not need `App.tsx` threading beyond making the
field's TYPE available; `SessionsSettings.tsx` and `SessionsPage.tsx` each read it from
`GET /api/preferences` directly, matching how `chatSoundEnabled` and other plain preferences are
already read in this codebase. Pass it down to `ArtifactsAside` from `SessionsPage.tsx` (Step 4)
using a small local `useState` seeded from `GET /api/preferences`, exactly like
`SessionsSettings.tsx`'s own `shellEnabled` state is seeded.

- [ ] **Step 3: Add the Settings toggles**

In `packages/web/src/pages/settings/SessionsSettings.tsx`, add state next to the existing shell
state (around line 19-23):

```ts
  const [editorEnabled, setEditorEnabled] = useState<boolean | null>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorAutosave, setEditorAutosave] = useState<boolean | null>(null)
  const [autosaveSaving, setAutosaveSaving] = useState(false)
  // Rides the SAME capability as the shell — see `sessions/editor-gate.ts` for why there is no
  // separate `localEditor` flag.
  const editorCapable = ctx.capabilities?.localShell !== false
```

Extend the `GET /api/preferences` effect (around line 25-36) to also read the two new fields:

```ts
  useEffect(() => {
    fetch('/api/preferences')
      .then(r => (r.ok ? r.json() : null))
      .then((p: {
        archiveMode?: ArchiveMode; archiveSessions?: boolean
        shellEnabled?: boolean; editorEnabled?: boolean; editorAutosave?: boolean
      } | null) => {
        const m: ArchiveMode =
          p?.archiveMode ?? (p?.archiveSessions === true ? 'full' : p?.archiveSessions === false ? 'off' : 'off')
        setMode(m)
        setShellEnabled(p?.shellEnabled === true)
        setEditorEnabled(p?.editorEnabled === true)
        setEditorAutosave(p?.editorAutosave === true)
      })
      .catch(() => { setMode('off'); setShellEnabled(false); setEditorEnabled(false); setEditorAutosave(false) })
  }, [])
```

Add the two toggle handlers, next to `toggleShell`:

```ts
  const toggleEditor = () => {
    if (editorEnabled === null || !editorCapable || editorSaving) return
    const next = !editorEnabled
    setEditorSaving(true)
    setEditorEnabled(next)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editorEnabled: next }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed') })
      .catch(() => setEditorEnabled(!next))
      .finally(() => setEditorSaving(false))
  }

  const toggleAutosave = () => {
    // Meaningless while the editor itself is off, and while its own read has not landed yet.
    if (editorAutosave === null || editorEnabled !== true || autosaveSaving) return
    const next = !editorAutosave
    setAutosaveSaving(true)
    setEditorAutosave(next)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editorAutosave: next }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed') })
      .catch(() => setEditorAutosave(!next))
      .finally(() => setAutosaveSaving(false))
  }
```

Add the section to the JSX, right after the existing shell `PrefRow` block and before the
`<Divider />` that precedes "History preservation":

```tsx
      <PrefRow
        label={pt ? 'Habilitar o explorador de repositório' : 'Enable the repository explorer'}
        sub={editorCapable
          ? (pt
            ? 'Desligado por padrão. Ligar mostra a aba "Repositório" com a árvore de arquivos e um editor de verdade, direto no painel.'
            : 'Off by default. Turning it on shows the "Repository" tab with the file tree and a real editor, from the dashboard.')
          : (pt
            ? 'Indisponível: o perfil de exposição desta instância não permite ler nem escrever arquivos do host.'
            : 'Unavailable: this instance’s exposure profile does not allow reading or writing host files.')}
      >
        <Toggle
          on={editorEnabled === true}
          onToggle={toggleEditor}
          disabled={!editorCapable || editorEnabled === null || editorSaving}
        />
      </PrefRow>

      <PrefRow
        label={pt ? 'Salvar automaticamente' : 'Autosave'}
        sub={pt
          ? 'Desligado por padrão. Ligar salva sozinho ~1–2s depois da última tecla — o custo é uma janela maior pra colidir com uma escrita do agente no mesmo arquivo.'
          : 'Off by default. Turning it on saves on its own ~1–2s after the last keystroke — the cost is a wider window to collide with an agent’s own write to the same file.'}
      >
        <Toggle
          on={editorAutosave === true}
          onToggle={toggleAutosave}
          disabled={editorEnabled !== true || editorAutosave === null || autosaveSaving}
        />
      </PrefRow>
```

- [ ] **Step 4: Pass both down from `SessionsPage.tsx`**

Add local state fetching `editorAutosave` (the `editorEnabled` half already arrives resolved via
`ctx.editorEnabled`, per Step 2) — next to the existing `const shellEnabled = ctx.shellEnabled ===
true` (around line 129):

```ts
  const editorEnabled = ctx.editorEnabled === true
  const [editorAutosave, setEditorAutosave] = useState(false)
  useEffect(() => {
    fetch('/api/preferences')
      .then(r => (r.ok ? r.json() : null))
      .then((p: { editorAutosave?: boolean } | null) => setEditorAutosave(p?.editorAutosave === true))
      .catch(() => setEditorAutosave(false))
  }, [])
```

Pass both to `ArtifactsAside` (around line 503-519, alongside the existing `turns={artifactTurns}`
line):

```tsx
      editorEnabled={editorEnabled}
      editorAutosave={editorAutosave}
```

- [ ] **Step 5: Typecheck**

```bash
bun tsc --noEmit
```

Expected: clean. (`ArtifactsAsideProps` does not have these fields yet — that lands in Task 12 —
so this step is expected to show exactly two new errors, "Property does not exist on type
ArtifactsAsideProps", nowhere else. If it shows anything else, stop and investigate before
continuing.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/app-context.ts packages/web/src/App.tsx packages/web/src/pages/settings/SessionsSettings.tsx packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): interruptores de Settings pro explorador de repositório e autosave"
```

---

## Task 6: `RepoTreeView` — the tree list

**Files:**
- Create: `packages/web/src/components/sessions/RepoTreeView.tsx`

No unit test — this is a presentational component over the already-tested `repoTreeModel.ts` and
`repoApi.ts`; its correctness is exercised by Task 13's manual pass. Its OWN logic is limited to
"call `fetchTree` the first time a directory with `children === null` is expanded", which is a
thin wrapper the tests in Task 2 already cover at the model level.

**Interfaces:**
- Consumes: `TreeNode`, `FlatRow`, `applyChildren`, `applyError`, `setLoading`, `toggleExpanded`, `flattenVisible` from `../../lib/repoTreeModel`; `fetchTree` from `../../lib/repoApi`.
- Produces: `RepoTreeView` component with props `{ sessionId: string; tree: TreeNode; onTreeChange: (updater: (prev: TreeNode) => TreeNode) => void; onOpenFile: (path: string) => void; lang: 'pt' | 'en' }`.

**Why `onTreeChange` takes an updater function, not a plain `TreeNode`:** this component's actual
tree state lives in its PARENT (`RepositoryTab`, Task 9), which owns it via `useState<TreeNode>`.
`RepositoryTab` passes its `setTree` React state setter directly as `onTreeChange` — `setTree`
already has this exact signature (`Dispatch<SetStateAction<TreeNode>>` accepts an updater), so
`applyChildren`/`applyError`/`setLoading`/`toggleExpanded` always run against the LATEST tree,
never a stale one captured by a closure from before an earlier `await`.

- [ ] **Step 1: Write the component**

```tsx
// packages/web/src/components/sessions/RepoTreeView.tsx
/**
 * RepoTreeView — the lazy, gitignore-aware file tree.
 *
 * Expand-on-click, one `GET /api/fleet/tree` call per directory the FIRST time it is opened
 * (`children === null` is the signal — `repoTreeModel.ts`'s own header explains why collapsing
 * never clears the cache). This is a plain list rather than a virtualized one for now: the row
 * count in a typical session's directory is in the hundreds, not the tens of thousands a
 * virtualization pass would be justified by, and windowing can be added later without touching
 * the model — `flattenVisible` already returns exactly what a windowed renderer would slice.
 */
import { ChevronDown, ChevronRight, File, Folder, Loader } from 'lucide-react'
import {
  applyChildren, applyError, flattenVisible, setLoading, toggleExpanded, type TreeNode,
} from '../../lib/repoTreeModel'
import { fetchTree } from '../../lib/repoApi'

export interface RepoTreeViewProps {
  sessionId: string
  tree: TreeNode
  onTreeChange: (updater: (prev: TreeNode) => TreeNode) => void
  onOpenFile: (path: string) => void
  lang: 'pt' | 'en'
}

export function RepoTreeView({ sessionId, tree, onTreeChange, onOpenFile, lang }: RepoTreeViewProps) {
  const pt = lang === 'pt'
  const rows = flattenVisible(tree)

  const findNode = (path: string, node: TreeNode): TreeNode | null => {
    if (node.path === path) return node
    for (const c of node.children ?? []) {
      const hit = findNode(path, c)
      if (hit) return hit
    }
    return null
  }

  const handleToggle = async (path: string) => {
    const node = findNode(path, tree)
    const willExpand = node ? !node.expanded : true
    onTreeChange(prev => toggleExpanded(prev, path))
    if (!willExpand || (node && node.children !== null)) return
    onTreeChange(prev => setLoading(prev, path, true))
    const res = await fetchTree(sessionId, path)
    if (res.ok) onTreeChange(prev => applyChildren(prev, path, res.children))
    else onTreeChange(prev => applyError(prev, path, res.message))
  }

  if (tree.children === null) {
    return null // the root has not loaded yet — the parent shows its own loading state
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
        {pt ? 'Pasta vazia.' : 'Empty folder.'}
      </div>
    )
  }

  return (
    <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', flex: 1, padding: '4px 0' }}>
      {rows.map(row => (
        <button
          key={row.path}
          onClick={() => (row.kind === 'dir' ? handleToggle(row.path) : onOpenFile(row.path))}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, width: '100%', textAlign: 'left',
            padding: '4px 10px', paddingLeft: 10 + row.depth * 14,
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 12.5, color: row.error ? 'var(--accent-red, #ef4444)' : 'var(--text-primary)',
            fontFamily: 'inherit',
          }}
        >
          {row.kind === 'dir' ? (
            row.loading
              ? <Loader size={12} className="ag-spin" style={{ flexShrink: 0 }} />
              : row.expanded
                ? <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                : <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
          ) : (
            <File size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)', marginLeft: 12 }} />
          )}
          {row.kind === 'dir' && !row.loading && (
            <Folder size={12} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
          {row.error && <span style={{ fontSize: 10.5, marginLeft: 4 }}>{row.error}</span>}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
bun tsc --noEmit
```

Expected: this file typechecks in isolation once its parent passes a matching setter — full
green confirmation happens at the end of Task 9, once `RepositoryTab` exists and wires it up. For
now, confirm there is no NEW error attributable to this file beyond "declared but never used"
(the component is not imported anywhere yet).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/sessions/RepoTreeView.tsx
git commit -m "feat(web): árvore de arquivos preguiçosa (RepoTreeView)"
```

---

## Task 7: Search — the flattened results view

**Files:**
- Create: `packages/web/src/components/sessions/RepoSearchView.tsx`

**Interfaces:**
- Consumes: `SearchHit` from `../../lib/repoApi`; `searchRepo` from `../../lib/repoApi`.
- Produces: `RepoSearchView` component with props `{ sessionId: string; onOpenFile: (path: string, line?: number) => void; onBack: () => void; lang: 'pt' | 'en' }`.

- [ ] **Step 1: Write the component**

```tsx
// packages/web/src/components/sessions/RepoSearchView.tsx
/**
 * RepoSearchView — the tree's search box, switched to a flattened result list.
 *
 * Debounced ~250ms, per the spec. Two result kinds render differently: a NAME hit is just a path;
 * a CONTENT hit carries the line and the matched text, which is what makes it worth opening at
 * that exact line rather than at the top of the file.
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, FileText, Search } from 'lucide-react'
import { searchRepo, type SearchHit } from '../../lib/repoApi'

export interface RepoSearchViewProps {
  sessionId: string
  onOpenFile: (path: string, line?: number) => void
  onBack: () => void
  lang: 'pt' | 'en'
}

const DEBOUNCE_MS = 250

export function RepoSearchView({ sessionId, onOpenFile, onBack, lang }: RepoSearchViewProps) {
  const pt = lang === 'pt'
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestId = useRef(0)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!q.trim()) { setHits([]); setTruncated(false); setLoading(false); return }
    setLoading(true)
    const myId = ++requestId.current
    timer.current = setTimeout(async () => {
      const res = await searchRepo(sessionId, q)
      // A later keystroke may have started a NEWER request; an older one landing after it must not
      // overwrite the fresher result.
      if (myId !== requestId.current) return
      if (res.ok) { setHits(res.hits); setTruncated(res.truncated) } else { setHits([]); setTruncated(false) }
      setLoading(false)
    }, DEBOUNCE_MS)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q, sessionId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <button onClick={onBack} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}>
          <ArrowLeft size={14} style={{ color: 'var(--text-tertiary)' }} />
        </button>
        <Search size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={pt ? 'Buscar por nome ou conteúdo…' : 'Search by name or content…'}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            fontSize: 13, color: 'var(--text-primary)', minWidth: 0,
          }}
        />
      </div>

      <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', flex: 1 }}>
        {loading && (
          <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-tertiary)' }}>
            {pt ? 'Buscando…' : 'Searching…'}
          </div>
        )}
        {!loading && q.trim() && hits.length === 0 && (
          <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-tertiary)' }}>
            {pt ? 'Nada encontrado.' : 'Nothing found.'}
          </div>
        )}
        {hits.map((h, i) => (
          <button
            key={`${h.kind}-${h.path}-${i}`}
            onClick={() => onOpenFile(h.path, h.kind === 'content' ? h.line : undefined)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px',
              background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-subtle)',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-primary)' }}>
              <FileText size={11} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.path}</span>
              {h.kind === 'content' && (
                <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>:{h.line}</span>
              )}
            </div>
            {h.kind === 'content' && (
              <div style={{
                fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, fontFamily: 'monospace',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{h.text}</div>
            )}
          </button>
        ))}
        {truncated && (
          <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-tertiary)' }}>
            {pt ? 'Mostrando os primeiros resultados — refine a busca.' : 'Showing the first results — narrow your search.'}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
bun tsc --noEmit
```

Expected: no new errors (unused-component warnings aside — it is wired in Task 9).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/sessions/RepoSearchView.tsx
git commit -m "feat(web): busca por nome/conteúdo no explorador (RepoSearchView)"
```

---

## Task 8: `RepoFileEditor` — Monaco for one file, save, and the conflict prompt

**Files:**
- Create: `packages/web/src/components/sessions/RepoFileEditor.tsx`

**Interfaces:**
- Consumes: `loadMonaco` from `../../lib/monacoSetup`; `languageForPath` from `../../lib/monacoLanguage`; `readRepoFile`, `writeRepoFile` from `../../lib/repoApi`.
- Produces: `RepoFileEditor` component with props `{ sessionId: string; path: string; autosave: boolean; onDirtyChange: (dirty: boolean) => void; lang: 'pt' | 'en'; gotoLine?: number }`.

This is the task where Monaco is actually mounted for the first time — the riskiest single step
in this plan. Do not skip Step 5's manual check; a `bun tsc --noEmit` pass does not prove an
`editor.create` call actually renders anything.

- [ ] **Step 1: Write the component — load, mount, read-only-until-loaded states**

```tsx
// packages/web/src/components/sessions/RepoFileEditor.tsx
/**
 * RepoFileEditor — one open file: load its content and mtime, mount Monaco over it, save on
 * Ctrl+S (and, opt-in, on a debounce), and refuse to let a save silently clobber a change that
 * landed on disk while the file was open — the whole reason this feature exists.
 *
 * THREE STATES, THREE SENTENCES, same rule this whole product already follows: loading, a binary
 * file (never sent as editable text), and a refusal from the server (escaped / not-found / …).
 * The fourth state — an open conflict — is its own modal, not a fourth sentence in this list,
 * because it needs the person to make a choice rather than just read something.
 */
import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { loadMonaco } from '../../lib/monacoSetup'
import { languageForPath } from '../../lib/monacoLanguage'
import { readRepoFile, writeRepoFile } from '../../lib/repoApi'

export interface RepoFileEditorProps {
  sessionId: string
  path: string
  /** The user's own autosave preference — off by default; see `Preferences.editorAutosave`. */
  autosave: boolean
  onDirtyChange: (dirty: boolean) => void
  lang: 'pt' | 'en'
  /** Set once, on open, when the file was opened FROM a content search hit. */
  gotoLine?: number
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'binary'; name: string; size: number }
  | { kind: 'refused'; message: string }
  | { kind: 'ready'; mtimeMs: number }

const AUTOSAVE_DEBOUNCE_MS = 1500

export function RepoFileEditor({ sessionId, path, autosave, onDirtyChange, lang, gotoLine }: RepoFileEditorProps) {
  const pt = lang === 'pt'
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [conflict, setConflict] = useState<{ content: string; mtimeMs: number } | null>(null)
  const [saveNotice, setSaveNotice] = useState<'idle' | 'saving' | 'saved'>('idle')
  const mtimeRef = useRef<number>(0)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load the file once per (sessionId, path). Mounting Monaco happens in a SEPARATE effect below,
  // gated on `state.kind === 'ready'`, so the two concerns — "do we have text to show" and "is an
  // editor instance attached to the DOM" — cannot race each other.
  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    readRepoFile(sessionId, path).then(res => {
      if (cancelled) return
      if (!res.ok) { setState({ kind: 'refused', message: res.message }); return }
      if ('binary' in res && res.binary) { setState({ kind: 'binary', name: res.name, size: res.size }); return }
      mtimeRef.current = res.mtimeMs
      setState({ kind: 'ready', mtimeMs: res.mtimeMs })
      // The MODEL is created in the mount effect below, once the DOM host exists; stash the text
      // where that effect can read it without a second fetch.
      pendingContent.current = res.content
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, path])

  const pendingContent = useRef<string>('')

  // Mount Monaco once the content has arrived and the host div exists. Disposed on unmount OR on
  // a path/session change — a stale editor instance pointed at the wrong file is worse than a
  // brief blank pane while the next one mounts.
  useEffect(() => {
    if (state.kind !== 'ready' || !hostRef.current) return
    let disposed = false
    let model: Monaco.editor.ITextModel | null = null

    loadMonaco().then(monaco => {
      if (disposed || !hostRef.current) return
      model = monaco.editor.createModel(pendingContent.current, languageForPath(path))
      const ed = monaco.editor.create(hostRef.current, {
        model,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        theme: 'vs-dark',
      })
      editorRef.current = ed

      if (gotoLine) {
        ed.revealLineInCenter(gotoLine)
        ed.setPosition({ lineNumber: gotoLine, column: 1 })
      }

      ed.onDidChangeModelContent(() => {
        onDirtyChange(true)
        if (autosave) {
          if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
          autosaveTimer.current = setTimeout(() => { void save() }, AUTOSAVE_DEBOUNCE_MS)
        }
      })

      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void save() })
    })

    return () => {
      disposed = true
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      editorRef.current?.dispose()
      model?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, path])

  async function save() {
    const ed = editorRef.current
    if (!ed) return
    setSaveNotice('saving')
    const content = ed.getValue()
    const res = await writeRepoFile(sessionId, path, content, mtimeRef.current)
    if (!res.ok) {
      if (res.reason === 'conflict') {
        setConflict({ content: res.content, mtimeMs: res.mtimeMs })
        setSaveNotice('idle')
        return
      }
      setSaveNotice('idle')
      return
    }
    mtimeRef.current = res.mtimeMs
    onDirtyChange(false)
    setSaveNotice('saved')
    setTimeout(() => setSaveNotice('idle'), 1500)
  }

  // ... conflict modal and the three empty states render in Step 2.
  return null
}
```

- [ ] **Step 2: Render the three load states and the conflict modal**

Replace the `return null` placeholder with:

```tsx
  if (state.kind === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
        {pt ? 'Carregando…' : 'Loading…'}
      </div>
    )
  }
  if (state.kind === 'binary') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 6, color: 'var(--text-tertiary)', fontSize: 12.5 }}>
        <div>{state.name}</div>
        <div>{pt ? 'Arquivo binário — sem visualização aqui.' : 'Binary file — no preview here.'}</div>
        <div>{(state.size / 1024).toFixed(1)} KB</div>
      </div>
    )
  }
  if (state.kind === 'refused') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', fontSize: 12.5, padding: 16, textAlign: 'center' }}>
        {state.message}
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />

      {saveNotice !== 'idle' && (
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 11, color: saveNotice === 'saved' ? 'var(--accent-green, #22c55e)' : 'var(--text-tertiary)' }}>
          {saveNotice === 'saving' ? (pt ? 'Salvando…' : 'Saving…') : (pt ? 'Salvo' : 'Saved')}
        </div>
      )}

      {conflict && (
        <div style={{
          position: 'absolute', inset: 0, background: 'var(--bg-overlay, rgba(0,0,0,0.55))',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
        }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 18, maxWidth: 420 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>
              {pt ? 'Este arquivo mudou' : 'This file changed'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 14 }}>
              {pt
                ? 'Algo escreveu neste arquivo — provavelmente um agente — desde que ele foi aberto aqui. Nada foi salvo. Escolha: continuar editando (você pode tentar salvar de novo por cima da versão atual) ou descartar sua edição e recarregar o que está no disco agora.'
                : 'Something wrote to this file — most likely an agent — since it was opened here. Nothing was saved. Choose: keep editing (you can try saving again over the current version) or discard your edit and reload what is on disk right now.'}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConflict(null)}
                style={{ padding: '7px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 12.5, cursor: 'pointer' }}
              >
                {pt ? 'Continuar editando' : 'Keep editing'}
              </button>
              <button
                onClick={() => {
                  editorRef.current?.setValue(conflict.content)
                  mtimeRef.current = conflict.mtimeMs
                  onDirtyChange(false)
                  setConflict(null)
                }}
                style={{ padding: '7px 12px', borderRadius: 7, border: 'none', background: 'var(--anthropic-orange)', color: '#fff', fontSize: 12.5, cursor: 'pointer' }}
              >
                {pt ? 'Descartar e recarregar' : 'Discard and reload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
```

- [ ] **Step 3: Typecheck**

```bash
bun tsc --noEmit
```

Expected: clean, aside from the component not being imported anywhere yet.

- [ ] **Step 4: Verify Monaco actually mounts, by hand**

This cannot be proven by `tsc`. Temporarily render `<RepoFileEditor sessionId="…" path="…"
autosave={false} onDirtyChange={() => {}} lang="en" />` inside any already-routed page (or wire it
straight into `RepositoryTab` a task early, if that is faster — Task 9 does this permanently), run
`bun run dev`, open it in a browser against a session with `editorEnabled: true` (Task 5's toggle),
and confirm:
- the editor renders with syntax-highlighted text for a real file,
- typing marks the tab dirty (watch `onDirtyChange` fire, e.g. via a `console.log`),
- Ctrl+S saves and the "Saved" notice appears,
- editing the SAME file from a terminal (`echo appended >> path/to/file`) and then pressing Ctrl+S
  in the browser shows the conflict modal, and "Discard and reload" replaces the editor's content
  with the terminal's write.

Remove any temporary wiring used only for this check before committing, if `RepositoryTab` is not
being built in the same sitting.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sessions/RepoFileEditor.tsx
git commit -m "feat(web): editor Monaco de um arquivo, salvar e prompt de conflito"
```

---

## Task 9: `RepositoryTab` — composing the tree, search, and multi-tab editor

**Files:**
- Create: `packages/web/src/components/sessions/RepositoryTab.tsx`

**Interfaces:**
- Consumes: `RepoTreeView` (Task 6), `RepoSearchView` (Task 7), `RepoFileEditor` (Task 8); `TreeNode`, `makeRootNode`, `OpenTab`, `openTab`, `closeTab`, `markDirty` from `../../lib/repoTreeModel`; `fetchTree` from `../../lib/repoApi`; `ConfirmModal` from `../../pages/settings/primitives`; `useIsMobile` from `../../hooks/useIsMobile`; `liveEvents`, `LiveTurn` from `../../lib/artifactTabs`.
- Produces: `RepositoryTab` component, the thing `ArtifactsAside.tsx` mounts for the `repo` tab.

This is the composition root: it owns the tree's React state (the piece `RepoTreeView` only
reads/updates through props), the open-tabs strip, and which of "tree", "search", or "editor" is
showing — the exact "layers, not a split" rule this file's own comment states, mirrored from
`ArtifactsAside.tsx`'s own header for the Files tab.

- [ ] **Step 1: Root the tree, load it on mount**

```tsx
// packages/web/src/components/sessions/RepositoryTab.tsx
/**
 * RepositoryTab — the Repository tab's own root: tree, search, and a multi-tab Monaco editor,
 * as LAYERS over one panel rather than a split — the exact reason `ArtifactsAside.tsx`'s own
 * header gives for the Files tab: a list and a document sharing this column would give the
 * document less room than the conversation it was opened from. Opening a file REPLACES the tree
 * with the editor; a back control returns to it. One rule for desktop and mobile, no separate
 * split-view to keep in sync — the Files tab already sets this precedent.
 *
 * A LIVE-AGENT BADGE reuses the SAME `turns` feed the Live tab already polls — no new polling
 * loop, per the design spec. The general badge is "the session's most recent live event is still
 * pending"; the STRONGER, file-specific one additionally checks that event's path against the
 * file currently open.
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, FolderTree, Plus, Search, Trash2, X } from 'lucide-react'
import {
  applyChildren, closeTab, makeRootNode, markDirty, openTab, type OpenTab, type TreeNode,
} from '../../lib/repoTreeModel'
import { fetchTree, createRepoEntry, deleteRepoEntry, renameRepoEntry } from '../../lib/repoApi'
import { RepoTreeView } from './RepoTreeView'
import { RepoSearchView } from './RepoSearchView'
import { RepoFileEditor } from './RepoFileEditor'
import { ConfirmModal } from '../../pages/settings/primitives'
import { liveEvents, type LiveTurn } from '../../lib/artifactTabs'

export interface RepositoryTabProps {
  sessionId: string
  lang: 'pt' | 'en'
  autosave: boolean
  turns: readonly LiveTurn[]
}

type View = { kind: 'tree' } | { kind: 'search' }

export function RepositoryTab({ sessionId, lang, autosave, turns }: RepositoryTabProps) {
  const pt = lang === 'pt'
  const [tree, setTree] = useState<TreeNode>(makeRootNode())
  const [rootError, setRootError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'tree' })
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [gotoLine, setGotoLine] = useState<number | undefined>(undefined)
  const [pendingClose, setPendingClose] = useState<string | null>(null)

  // The root loads exactly like any other node — reusing `applyChildren` rather than a
  // special-cased root path is what keeps the root from drifting out of sync with the rest of
  // the tree's own update rules.
  useEffect(() => {
    let cancelled = false
    setTree(makeRootNode())
    setRootError(null)
    fetchTree(sessionId, '').then(res => {
      if (cancelled) return
      if (!res.ok) { setRootError(res.message); return }
      setTree(prev => applyChildren(prev, '', res.children))
    })
    return () => { cancelled = true }
  }, [sessionId])
```

- [ ] **Step 2: Wire opening a file, the tabs strip, and the live-agent badge**

Append to the component body:

```tsx
  const openFile = (path: string, line?: number) => {
    setTabs(prev => openTab(prev, path))
    setActivePath(path)
    setGotoLine(line)
    setView({ kind: 'tree' }) // leaving search view lands on the editor, not back on the tree
  }

  const requestClose = (path: string) => {
    const tab = tabs.find(t => t.path === path)
    if (tab?.dirty) { setPendingClose(path); return }
    doClose(path)
  }

  const doClose = (path: string) => {
    setTabs(prev => closeTab(prev, path))
    setPendingClose(null)
    if (activePath === path) {
      const remaining = tabs.filter(t => t.path !== path)
      setActivePath(remaining.length > 0 ? remaining[remaining.length - 1]!.path : null)
    }
  }

  // The general "agent working" badge: the most recent live event is still PENDING. The
  // file-specific one additionally matches that event's own path against the open editor.
  const feed = liveEvents(turns)
  const lastLive = feed.length > 0 ? feed[feed.length - 1] : undefined
  const agentWorking = lastLive?.live === true
  const agentWorkingHere = agentWorking && lastLive?.ref !== undefined && activePath !== null
    && String(lastLive.ref).endsWith(activePath)
```

- [ ] **Step 3: Render — tree/search layer, tabs strip, editor layer**

```tsx
  if (rootError) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', fontSize: 12.5, padding: 16, textAlign: 'center' }}>
        {rootError}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {activePath === null ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
            {agentWorking && (
              <span title={pt ? 'O agente está trabalhando' : 'The agent is working'} style={{
                width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-green, #22c55e)', flexShrink: 0,
              }} />
            )}
            <button
              onClick={() => setView({ kind: 'search' })}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
            >
              <Search size={12} /> {pt ? 'Buscar' : 'Search'}
            </button>
            <button
              onClick={async () => {
                const name = window.prompt(pt ? 'Nome do novo arquivo:' : 'New file name:')
                if (!name) return
                const out = await createRepoEntry(sessionId, name, 'file')
                if (out.ok) {
                  // Re-fetch the root rather than inserting the new entry client-side: the real
                  // listing is gitignore-aware and sorted by the server, and duplicating that
                  // logic here would be a second place it could disagree with what actually got
                  // created.
                  const res = await fetchTree(sessionId, '')
                  if (res.ok) setTree(prev => applyChildren(prev, '', res.children))
                  openFile(name)
                } else {
                  window.alert(out.message)
                }
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
            >
              <Plus size={12} /> {pt ? 'Novo' : 'New'}
            </button>
          </div>

          {view.kind === 'search' ? (
            <RepoSearchView sessionId={sessionId} onOpenFile={openFile} onBack={() => setView({ kind: 'tree' })} lang={lang} />
          ) : (
            <RepoTreeView sessionId={sessionId} tree={tree} onTreeChange={setTree} onOpenFile={openFile} lang={lang} />
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', borderBottom: '1px solid var(--border-subtle)', overflowX: 'auto' }}>
            <button
              onClick={() => setActivePath(null)}
              style={{ display: 'flex', alignItems: 'center', padding: 6, background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
              title={pt ? 'Voltar pra árvore' : 'Back to the tree'}
            >
              <ArrowLeft size={13} style={{ color: 'var(--text-tertiary)' }} />
            </button>
            {tabs.map(t => (
              <div
                key={t.path}
                onClick={() => setActivePath(t.path)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 6,
                  background: t.path === activePath ? 'var(--bg-hover)' : 'transparent', cursor: 'pointer',
                  fontSize: 11.5, color: 'var(--text-primary)', flexShrink: 0, whiteSpace: 'nowrap',
                }}
              >
                {t.dirty && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--anthropic-orange)' }} />}
                {t.path.split('/').pop()}
                {agentWorkingHere && t.path === activePath && (
                  <span title={pt ? 'O agente está editando este arquivo agora' : 'The agent is editing this file right now'} style={{
                    width: 5, height: 5, borderRadius: '50%', background: 'var(--accent-green, #22c55e)',
                  }} />
                )}
                <X
                  size={11}
                  onClick={e => { e.stopPropagation(); requestClose(t.path) }}
                  style={{ color: 'var(--text-tertiary)', marginLeft: 2 }}
                />
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <RepoFileEditor
              key={activePath}
              sessionId={sessionId}
              path={activePath}
              autosave={autosave}
              onDirtyChange={dirty => setTabs(prev => markDirty(prev, activePath, dirty))}
              lang={lang}
              {...(gotoLine !== undefined ? { gotoLine } : {})}
            />
          </div>
        </>
      )}

      {pendingClose && (
        <ConfirmModal
          title={pt ? 'Fechar sem salvar?' : 'Close without saving?'}
          body={pt
            ? 'Este arquivo tem mudanças não salvas. Fechar descarta o que ainda não foi salvo.'
            : 'This file has unsaved changes. Closing discards what has not been saved.'}
          confirmLabel={pt ? 'Fechar mesmo assim' : 'Close anyway'}
          onConfirm={() => doClose(pendingClose)}
          onCancel={() => setPendingClose(null)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Confirm `ConfirmModal`'s actual prop names**

The props used above (`title`, `body`, `confirmLabel`, `onConfirm`, `onCancel`) are a best guess
from this component's own usage pattern in `ArtifactsAside.tsx` (search that file for
`<ConfirmModal` — it is already imported and used there for the artifact-removal flow near the
end of the file). Before this task is committed, open `packages/web/src/pages/settings/
primitives.tsx` and `ArtifactsAside.tsx`'s own `<ConfirmModal` call site, and correct the prop
names here to match EXACTLY — do not guess a second time; read the component's actual prop type.

- [ ] **Step 5: Typecheck**

```bash
bun tsc --noEmit
```

Expected: clean, once Step 4's correction is applied.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/sessions/RepositoryTab.tsx
git commit -m "feat(web): compõe árvore, busca e editor multi-aba (RepositoryTab)"
```

---

## Task 10: Rename and delete — the tree's own context menu

**Files:**
- Modify: `packages/web/src/components/sessions/RepoTreeView.tsx`
- Modify: `packages/web/src/components/sessions/RepositoryTab.tsx`

Create was already wired in Task 9 (the toolbar's "New" button). This task adds rename and
delete, both reachable per-row, and both requiring a real IO round trip before the tree reflects
the change — there is no optimistic update, so a refusal (e.g. `already-exists`) never has to be
silently rolled back.

- [ ] **Step 1: Add per-row actions to `RepoTreeView`**

Modify `RepoTreeViewProps` in `RepoTreeView.tsx` to add two callbacks:

```ts
export interface RepoTreeViewProps {
  sessionId: string
  tree: TreeNode
  onTreeChange: (updater: (prev: TreeNode) => TreeNode) => void
  onOpenFile: (path: string) => void
  onRename: (path: string) => void
  onDelete: (path: string, kind: 'file' | 'dir') => void
  lang: 'pt' | 'en'
}
```

Add a small actions cluster to each row, shown on hover (desktop) and always-visible (mobile, per
the 44px touch-target rule — a hover-only control is unreachable on a phone). Replace the row
`<button>`'s closing tag with a wrapping `<div>` that holds both the row button and the actions:

```tsx
        <div key={row.path} style={{ display: 'flex', alignItems: 'center' }}>
          <button
            onClick={() => (row.kind === 'dir' ? handleToggle(row.path) : onOpenFile(row.path))}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 0, textAlign: 'left',
              padding: '4px 10px', paddingLeft: 10 + row.depth * 14,
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: 12.5, color: row.error ? 'var(--accent-red, #ef4444)' : 'var(--text-primary)',
              fontFamily: 'inherit',
            }}
          >
            {row.kind === 'dir' ? (
              row.loading
                ? <Loader size={12} className="ag-spin" style={{ flexShrink: 0 }} />
                : row.expanded
                  ? <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                  : <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
            ) : (
              <File size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)', marginLeft: 12 }} />
            )}
            {row.kind === 'dir' && !row.loading && (
              <Folder size={12} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
            {row.error && <span style={{ fontSize: 10.5, marginLeft: 4 }}>{row.error}</span>}
          </button>
          <button
            onClick={() => onRename(row.path)}
            title={pt ? 'Renomear' : 'Rename'}
            style={{ padding: 6, minWidth: 28, minHeight: 28, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', flexShrink: 0 }}
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={() => onDelete(row.path, row.kind)}
            title={pt ? 'Apagar' : 'Delete'}
            style={{ padding: 6, minWidth: 28, minHeight: 28, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', flexShrink: 0 }}
          >
            <Trash2 size={11} />
          </button>
        </div>
```

Add `Pencil` to the `lucide-react` import at the top of the file.

- [ ] **Step 2: Wire the two actions in `RepositoryTab`**

Add to `RepositoryTab.tsx`, alongside the existing toolbar's "New" handler:

```ts
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null)

  const reloadRoot = () => {
    fetchTree(sessionId, '').then(res => { if (res.ok) setTree(prev => applyChildren(prev, '', res.children)) })
  }

  const doRename = async (from: string) => {
    const to = window.prompt(pt ? 'Novo nome:' : 'New name:', from.split('/').pop())
    if (!to) return
    const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    const out = await renameRepoEntry(sessionId, from, `${parent}${to}`)
    if (out.ok) {
      reloadRoot()
      setTabs(prev => prev.map(t => (t.path === from ? { ...t, path: `${parent}${to}` } : t)))
      if (activePath === from) setActivePath(`${parent}${to}`)
    } else {
      window.alert(out.message)
    }
  }

  const doDelete = async (path: string, recursive: boolean) => {
    const out = await deleteRepoEntry(sessionId, path, recursive)
    setDeleting(null)
    if (out.ok) {
      reloadRoot()
      setTabs(prev => closeTab(prev, path))
      if (activePath === path) setActivePath(null)
    } else {
      window.alert(out.message)
    }
  }
```

Pass the two handlers into `<RepoTreeView>`'s call site:

```tsx
            <RepoTreeView
              sessionId={sessionId}
              tree={tree}
              onTreeChange={setTree}
              onOpenFile={openFile}
              onRename={doRename}
              onDelete={(path, kind) => setDeleting({ path, kind })}
              lang={lang}
            />
```

Add the delete confirmation, next to the existing `pendingClose` `ConfirmModal`:

```tsx
      {deleting && (
        <ConfirmModal
          title={pt ? `Apagar "${deleting.path.split('/').pop()}"?` : `Delete "${deleting.path.split('/').pop()}"?`}
          body={deleting.kind === 'dir'
            ? (pt
              ? 'Isso apaga a pasta e TUDO dentro dela, permanentemente.'
              : 'This deletes the folder and EVERYTHING inside it, permanently.')
            : (pt ? 'Isso apaga o arquivo permanentemente.' : 'This deletes the file permanently.')}
          confirmLabel={pt ? 'Apagar' : 'Delete'}
          onConfirm={() => doDelete(deleting.path, deleting.kind === 'dir')}
          onCancel={() => setDeleting(null)}
        />
      )}
```

Note: a non-empty folder deleted without `recursive: true` refuses with `not-empty` (Phase 1,
Task 9) — `window.alert(out.message)` surfaces that refusal today. If manual verification (Task
13) finds this too easy to trigger by accident, upgrade it to a second confirmation offering
"delete everything inside it too" rather than a bare alert — noted here rather than guessed at,
since the spec leaves the exact UX of that escalation unspecified.

- [ ] **Step 3: Typecheck**

```bash
bun tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/sessions/RepoTreeView.tsx packages/web/src/components/sessions/RepositoryTab.tsx
git commit -m "feat(web): renomear e apagar arquivos/pastas na árvore do explorador"
```

---

## Task 11: Plug `RepositoryTab` into `ArtifactsAside.tsx`

**Files:**
- Modify: `packages/web/src/components/sessions/ArtifactsAside.tsx`

- [ ] **Step 1: Add `'repo'` to `TabId`, and the two new props**

```ts
type TabId = 'files' | 'docs' | 'live' | 'gallery' | 'skills' | 'agents' | 'forks' | 'workflows' | 'mcps' | 'prs' | 'tasks' | 'metrics' | 'repo'
```

Add to `ArtifactsAsideProps` (near `cwd?: string`, since this tab is the SECOND consumer of the
session's directory after the MCP tab):

```ts
  /** What `/api/fleet/tree*` will actually answer — resolved capability AND preference. Absent or
   *  false means the tab does not exist at all, never a disabled one. */
  editorEnabled?: boolean
  /** The user's autosave preference for the Repository tab. */
  editorAutosave?: boolean
```

- [ ] **Step 2: Import `RepositoryTab`, `FolderTree`**

Add `FolderTree` to the existing `lucide-react` import list, and add:

```ts
import { RepositoryTab } from './RepositoryTab'
```

- [ ] **Step 3: Honor a tab request for `'repo'`, and add it to the tabs array**

Extend the `tabRequest` effect's allowed-tab check (around line 416):

```ts
    if (t === 'files' || t === 'docs' || t === 'live' || t === 'gallery' || t === 'skills'
      || t === 'agents' || t === 'forks' || t === 'workflows' || t === 'mcps' || t === 'prs' || t === 'tasks'
      || t === 'repo'
      || (t === 'metrics' && metrics !== undefined)) setTab(t)
```

Add the tab entry to the tabs array (near the existing `{ id: 'files', … }` entry around line
663), GATED on `editorEnabled` — this is the "absent, not disabled" rule, enforced by simply not
pushing the object when the gate is closed:

```ts
    ...(editorEnabled ? [{ id: 'repo' as const, label: pt ? 'Repositório' : 'Repository', icon: <FolderTree size={12} />, count: null }] : []),
```

(Insert this spread into whatever array-literal expression currently builds the tabs list — read
the surrounding code first; it may be a plain array literal rather than one built with
intermediate variables, in which case the spread goes inline exactly where any other entry would.)

- [ ] **Step 4: Render the tab's body**

Find where the existing tabs render their body content (each `tab === 'x' && <Something/>`
branch) and add:

```tsx
      {tab === 'repo' && editorEnabled && (
        <RepositoryTab sessionId={sessionId} lang={lang} autosave={editorAutosave === true} turns={turns ?? []} />
      )}
```

The `editorEnabled` check here is a second, redundant guard on top of Task 3's — deliberately so:
a `tab` value can outlive the moment the gate closes (the preference toggled off in another tab
while this one still has `'repo'` selected in its `useState`), and rendering nothing rather than
a half-built panel is the correct response to that, not a bug to route around.

- [ ] **Step 5: Typecheck**

```bash
bun tsc --noEmit
```

Expected: clean — this is also the point where Task 5's two deliberately-left type errors
(`editorEnabled` / `editorAutosave` not existing on `ArtifactsAsideProps`) finally resolve.

- [ ] **Step 6: Run the full test suite**

```bash
bun test
```

Expected: every test passes, including every test written across both phases of this plan.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/sessions/ArtifactsAside.tsx
git commit -m "feat(web): liga a aba Repositório no ArtifactsAside"
```

---

## Task 12: Mobile — verify the "layers, not split" rule holds at 390px

**Files:** none new — this task is a targeted review pass plus fixes, not a fresh feature.

Per this project's own CLAUDE.md, mobile is not a follow-up: it ships in the same change. The
components built in Tasks 6-9 were already written using the SAME single-column, layer-swapping
structure at every width (no `useIsMobile()` branch anywhere in them) — which is deliberately the
same choice the Files tab already made, per its own header comment. This task is the check that
holds up, not new width-specific code, unless the check finds otherwise.

- [ ] **Step 1: Resize the browser (or the dev tools device toolbar) to 390px width**

With `bun run dev` running and a session open with the Repository tab enabled, open the Sessions
workspace at 390px and open the Repository tab.

- [ ] **Step 2: Walk the checklist**

- [ ] The tree fills the full panel width; no horizontal scroll on the page body (`document.documentElement.scrollWidth <= window.innerWidth`, checked in the browser console).
- [ ] Every row's rename/delete buttons are reachable by touch — they are always-visible (Task 10 built them that way deliberately, not hover-only) and each hit target is at least 44×44 (measure in dev tools; `minWidth: 28, minHeight: 28` from Task 10's draft is a DESKTOP-appropriate size and must be widened for mobile — see Step 3).
- [ ] Opening a file swaps the tree for the editor FULL-SCREEN within the panel — no split view attempted.
- [ ] The tabs strip scrolls horizontally without breaking the "back to tree" arrow's position.
- [ ] The search box's `autoFocus` does not fight the on-screen keyboard in a way that hides the input (compare against how `SessionChat`'s own composer already handles this, per `lib/mobileViewport.ts`).
- [ ] The conflict modal and the delete/close confirmations are fully visible and centered, not clipped by the panel's edges.
- [ ] Any `<input>` in this feature (the search box, none other — rename/create use `window.prompt`, which is the OS's own dialog and is exempt) computes to at least 16px font size, or iOS Safari will zoom the viewport. Check `RepoSearchView`'s input against `index.css`'s global guard rather than trusting the `fontSize: 13` set in Task 7 — that guard is supposed to override it, but confirm rather than assume.

- [ ] **Step 3: Fix what the checklist finds**

The one item flagged in advance: widen Task 10's row action buttons for mobile. Since this
component has no existing `useIsMobile()` branch, follow the pattern used elsewhere in
`ArtifactsAside.tsx` for mobile-sized touch targets (search that file for `useIsMobile` — it is
already imported there) rather than inventing a new one; import and use the same hook inside
`RepoTreeView`, and size the action buttons to at least 44×44 only when it reports mobile,
keeping the current dense desktop sizing otherwise.

Record any OTHER fix this checklist required — do not skip recording it even if the fix was
trivial; a plan that says "mobile: fine" with no evidence is exactly the gap CLAUDE.md's rule
exists to close.

- [ ] **Step 4: Typecheck and full suite once more**

```bash
bun tsc --noEmit
bun test
```

- [ ] **Step 5: Commit**

```bash
git add -A -- packages/web/src/components/sessions/
git commit -m "fix(web): alvos de toque de 44px no explorador de repositório em mobile"
```

(`git add -A -- <path>` rather than a bare `git add -A`, per this plan's own global constraint —
scoped to exactly the directory this task touched.)

---

## Task 13: End-to-end verification on a real, disposable session

No new code in this task unless it uncovers a defect. This is the check that everything built
across both phases actually works together, against a real running dev server and a real
session — never the user's own live one.

- [ ] **Step 1: Spawn a probe session**

Per this project's own established practice for verifying web UI changes: spawn a throwaway
session to drive, rather than attaching automation to a session the user is actively working in.

```bash
agentop session new --harness claude --prompt "idle — used as a UI verification target, safe to kill" .
```

(Adjust the exact invocation to whatever this machine's `agentop session` subcommand actually
accepts — check `agentop session new --help` first if the flags above do not match; the point is a
disposable session in a real, git-tracked directory, not the exact flags.)

- [ ] **Step 2: Confirm the gate**

With `editorEnabled` OFF (Settings toggle from Task 5), open the probe session in the Sessions
workspace and confirm the **Repository** tab does not appear in the tab bar at all — not a greyed
control, absent entirely. Turn it on; confirm the tab appears without a reload (re-fetch
`/api/team/session` if the app does not do this automatically on a preference change — note
whether it does, since that is itself worth knowing).

- [ ] **Step 3: Walk the whole feature once, end to end**

- [ ] Open the tab: the root of the probe session's own directory lists, gitignored files absent.
- [ ] Expand a subdirectory; expand a second one; collapse and re-expand the first — confirm (via the Network tab) that re-expanding costs no new request.
- [ ] Search by filename; search by content; confirm a content hit opens the file at the matched line.
- [ ] Open two different files; confirm both appear as tabs and switching between them is instant (no flash of "Loading…" on the second visit — Task 8's per-mount fetch means switching AWAY and BACK does currently refetch; if that reads as a real papercut during this check, note it as a candidate follow-up rather than fixing it silently here, since caching a model across tab switches was explicitly named as v1 scope in the spec's own "Multiple tabs" paragraph and deserves a deliberate look rather than a same-day patch).
- [ ] Edit a file, watch the tab gain a dirty dot, press Ctrl+S, watch it clear.
- [ ] With autosave ON (Settings), edit a file and wait ~2s without pressing Ctrl+S; confirm it saved on its own.
- [ ] With the probe session's own terminal, edit the SAME open file directly (`echo x >> file`), then try to save from the browser — confirm the conflict modal appears with the terminal's content, and that "Discard and reload" replaces the editor with it.
- [ ] Create a new file via the toolbar; confirm it appears in the tree and opens.
- [ ] Rename it; confirm the tree, the open tab's label, and a subsequent read of the OLD name all agree it moved.
- [ ] Delete it; confirm it is gone from the tree and its tab closed.
- [ ] Create a folder with a file inside it; attempt to delete the folder; confirm the confirmation names it as removing everything inside; confirm it is actually gone afterward.
- [ ] Ask the probe session's own agent to edit a file that is currently open in the browser's editor (a real prompt, not a simulated write) — confirm the general "agent working" badge appears, and, once the agent's edit targets that exact file, the stronger per-file badge appears too; confirm attempting to save afterward correctly produces the conflict modal (this is the feature's core promise, exercised against a REAL concurrent writer rather than a shell command standing in for one).
- [ ] Kill the probe session once done: `agentop session kill <id>` (or the equivalent this machine's CLI actually exposes).

- [ ] **Step 4: Report**

Report the outcome of every checklist item above — pass/fail, with a screenshot or the exact
observed behavior for anything unexpected — before this plan is considered complete. Anything that
fails goes back to the relevant task above as a fix, not forward as a footnote.

---

## Self-Review Checklist (for whoever executes this plan)

Before opening the PR:
- [ ] Every bullet under the spec's "What this covers (v1)" section has a task above that implements it: tree (6), search (7), Monaco + multiple tabs (8, 9), save + autosave off-by-default (8), create/rename/delete (9, 10), conflict detection (8), live indicator (9), works for live AND closed sessions (Phase 1, unchanged by this phase).
- [ ] Nothing in the spec's "Deferred" or "Out of scope" lists was built — in particular, no TypeScript/JS language-service worker, no linting, no git status/diff/stage/commit UI.
- [ ] `bun test` (full suite) and `bun tsc --noEmit` are clean on the final commit.
- [ ] The tab is verified ABSENT (not disabled) with the preference off, live, in Task 13.
- [ ] The conflict flow was verified against a REAL concurrent writer (a live agent, not just a manual terminal edit) at least once, in Task 13.
- [ ] Mobile was verified at 390px in Task 12, with fixes recorded, not merely asserted.
- [ ] No backend file was touched in this phase — everything here consumes Phase 1's routes as they already exist.
