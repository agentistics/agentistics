/**
 * repoTreeModel.ts — PURE: the lazy tree's shape, and the open-tabs strip's shape.
 *
 * The tree is a plain recursive structure keyed by PATH (root-relative, '/'-joined, '' for the
 * root itself) — every update below finds a node by walking the tree and replacing the matched
 * node with a new one, which is what keeps the whole thing trivially testable without React.
 *
 * `TreeChild` is redeclared here rather than imported from the server's `editor-list.ts` (same
 * shape: `{ name, kind: 'file' | 'dir' }`) — `packages/web/src/*` may never import
 * `packages/server/server/*` (Vite would try to bundle Node-only code), and this type is too
 * small and too specific to this view model to be worth promoting into `@agentistics/core`.
 *
 * COLLAPSING NEVER DROPS CACHED CHILDREN. A directory's `children` stays populated after it is
 * collapsed; only `expanded` flips. Re-opening it is then instant and costs no fetch — the caller
 * only calls the `/api/fleet/tree` route the FIRST time a directory's `children` is still `null`.
 * That `null` is load-bearing: it is the one thing that tells the caller "never fetched", distinct
 * from a real, loaded, empty directory (`children: []`) — the same N/A-versus-a-confident-0 rule
 * this codebase applies everywhere else, applied here to "has this directory been read yet".
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

/** Finds `path` by walking the tree and replaces just that node — every other update goes through this. */
function updateNode(node: TreeNode, path: string, fn: (n: TreeNode) => TreeNode): TreeNode {
  if (node.path === path) return fn(node)
  if (!node.children) return node
  return { ...node, children: node.children.map(c => updateNode(c, path, fn)) }
}

export function setLoading(root: TreeNode, path: string, loading: boolean): TreeNode {
  return updateNode(root, path, n => ({ ...n, loading }))
}

/**
 * Refreshes ONE directory's own listing, and MERGES it into what was there — never a full rebuild
 * (I3, `session-w1c-tree-ops-review.md`). A tree operation elsewhere (a rename, a drag-move, an
 * undo) refreshes the affected parent's children so its own listing catches up, but every SIBLING
 * that survives the refresh untouched is not the thing that changed: rebuilding every child fresh
 * (`expanded: false, children: null`) collapsed every open folder under whichever parent got
 * refreshed, including a drag to the root collapsing `docs`, an undo collapsing `src`, and a rename
 * at the root collapsing every open top-level folder — the exact thing §5.2 promises a refresh will
 * not do ("reloads only the affected parents").
 *
 * A child SURVIVES (keeps its `expanded` state and its own cached `children`) when its path and kind
 * are unchanged from before; a child new to the listing, or one whose kind changed at the same name
 * (file replaced by a directory or vice versa — its old `children`/`expanded` describe a different
 * kind of thing and cannot be reused), starts fresh. A child no longer in the listing is simply
 * absent from the result, same as before.
 */
export function applyChildren(root: TreeNode, path: string, children: readonly TreeChild[]): TreeNode {
  return updateNode(root, path, n => {
    const prevByPath = new Map((n.children ?? []).map(c => [c.path, c]))
    return {
      ...n,
      loading: false,
      error: undefined,
      children: children.map(c => {
        const childPath = path === '' ? c.name : `${path}/${c.name}`
        const prev = prevByPath.get(childPath)
        if (prev !== undefined && prev.kind === c.kind) return { ...prev, name: c.name }
        return {
          path: childPath,
          name: c.name,
          kind: c.kind,
          expanded: false,
          loading: false,
          children: null,
        }
      }),
    }
  })
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
  /**
   * STABLE across a rename or a move, and NEVER the path — minted once, when the tab is opened, and
   * carried unchanged by `retargetOpenPaths` for as long as the tab stays open. Never shown and never
   * sent to the server. It exists for exactly one reason: the host keys its Monaco instances by it
   * (see `retargetOpenPaths`'s own header) so that renaming an open file changes what the tab is
   * CALLED without tearing down the editor underneath it — a rename is not a new file, so it must not
   * look like one to the one thing that cannot survive being remounted, the undo stack.
   *
   * **It is not `path` (I2, `session-w1c-tree-ops-review.md`).** An id derived from the path a tab
   * was first opened at is unique only until that path is FREED — rename `src/a.ts` to `src/a2.ts`
   * (the tab keeps id `src/a.ts`), then create a new file back at `src/a.ts`: `openTab` used to mint
   * that same id again, so `EditorStack` rendered two tabs sharing one React key, whose reconciliation
   * is undefined, and once C1 is fixed a reused instance could show one file's buffer under the
   * other's path.
   */
  id: string
  path: string
  dirty: boolean
}

/**
 * A fresh id, unique for the life of the tab. `crypto.randomUUID` when it exists; the fallback is
 * good enough for a value that is never shown, never sent to the server and only ever compared
 * against other ids minted in this same browser tab.
 */
function newTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function openTab(tabs: readonly OpenTab[], path: string): OpenTab[] {
  if (tabs.some(t => t.path === path)) return [...tabs]
  return [...tabs, { id: newTabId(), path, dirty: false }]
}

export function closeTab(tabs: readonly OpenTab[], path: string): OpenTab[] {
  return tabs.filter(t => t.path !== path)
}

export function markDirty(tabs: readonly OpenTab[], path: string, dirty: boolean): OpenTab[] {
  return tabs.map(t => (t.path === path ? { ...t, dirty } : t))
}

// --- path arithmetic shared by the tree operations (rename, move, delete) -------------------------

/** `''` for a root-level entry — mirrors the tree model's own root-relative paths. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** The basename — the part a rename, unlike a move, is free to change. */
export function baseNameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * Is `path` `ancestor` itself, or somewhere inside it? Mirrors the SERVER's own
 * `containedInRoot`/`withinDirectory` (`editor-path.ts`) — the shape of "is X under Y" is the same
 * question asked of a different root, and the two must agree on what counts as a nested path.
 */
export function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/**
 * Where `itemPath` lands if it is moved into the folder `targetDir` (`''` for the tree's root),
 * keeping its own basename — exactly what a drag-and-drop move and the "Mover para…" picker both
 * need before they can ask the server to rename anything.
 */
export function destinationPath(itemPath: string, targetDir: string): string {
  const base = baseNameOf(itemPath)
  return targetDir === '' ? base : `${targetDir}/${base}`
}

/**
 * Is moving `itemPath` into `targetDir` something worth ASKING the server to do?
 *
 * Two refusals, and neither needs a round trip to discover: moving a folder into ITSELF or into one
 * of its own descendants (the server's own `renameTreeEntry` refuses this lexically too — see its
 * `into-itself` reason — but the drop target's outline and the picker's own folder list must already
 * agree before a request is ever sent, or a reader sees an "illegal" target highlighted as a legal
 * one for the one frame before the refusal comes back), and moving something into the folder it is
 * ALREADY in — not wrong, merely nothing: the server would answer this `already-exists` (true, and
 * unhelpful, since "there is already a file there" describes the move's own source).
 */
export function canMoveInto(itemPath: string, targetDir: string): boolean {
  if (isSelfOrDescendant(targetDir, itemPath)) return false
  return parentOf(itemPath) !== targetDir
}

/**
 * Where `path` lands after `from` is renamed or moved to `to` — `null` when `path` is untouched by
 * that change at all.
 *
 * Exact equality retargets a renamed FILE (a tab is always a file; nothing here ever opens a
 * directory). The prefix case retargets every file a MOVED DIRECTORY was carrying — `${from}/` is
 * what keeps a rename of `src2` from also retargeting `src` and its children; a bare `startsWith`
 * with no separator would.
 */
export function retargetPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  const prefix = `${from}/`
  return path.startsWith(prefix) ? `${to}/${path.slice(prefix.length)}` : null
}

/**
 * Every OPEN tab, re-keyed the same way: a rename or a move of `from` to `to` is applied to every
 * tab it touches and leaves every other tab exactly as it was — `id` included, since the host's
 * whole reason for keeping one is to survive precisely this call unchanged.
 *
 * `retargetPath` returning `null` for "untouched" is why this is a `map` and not a `filter`-then-map:
 * a tab this rename does not concern must come back byte-for-byte identical, not merely
 * path-for-path identical, or a caller comparing object IDENTITY (React does, via `===`, before ever
 * reaching a key) would see every tab as "changed" on every unrelated rename.
 */
export function retargetOpenPaths(tabs: readonly OpenTab[], from: string, to: string): OpenTab[] {
  return tabs.map(t => {
    const moved = retargetPath(t.path, from, to)
    return moved === null ? t : { ...t, path: moved }
  })
}
