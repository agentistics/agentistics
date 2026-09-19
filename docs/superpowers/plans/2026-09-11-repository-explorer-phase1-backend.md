# Repository Explorer — Phase 1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every backend piece of the repository explorer — the two-gate security check, directory
resolution for live and closed sessions, and the seven `/api/fleet/tree*` routes (list, search,
read, write with conflict detection, create, rename, delete) — working and verifiable end-to-end
with `curl`, with no UI yet.

**Architecture:** Six small PURE decision modules (gate, path containment, directory resolution,
tree-listing shape, write-conflict check, search-result shaping) plus one IO module
(`editor-fs.ts`) that does the actual filesystem/git work around them, plus one route module
(`editor-web.ts`) that turns refusal codes into localized sentences — the exact split this
codebase already uses for the per-session shell (`shell-spec.ts` / `shell-gate.ts` /
`shell-backend.ts` / `shell-web.ts`).

**Tech Stack:** Bun, TypeScript (strict), `node:fs/promises`, `Bun.spawn` for `git`, `bun:test`.
No new runtime dependency in this phase.

**Spec:** `docs/superpowers/specs/2026-09-11-repository-explorer-aside-design.md` — directory
resolution, security gating, backend routes, and conflict handling sections.

**Task:** t-9a15db678d — "repositório disponivel no aside da direita" (subtask s-628feee061).

## Why a separate phase, and what Phase 2 depends on

Phase 2 (frontend: tree UI, search box, Monaco editor with multiple tabs, create/rename/delete UI,
conflict prompt, live-agent indicator, mobile layering) is a large, mostly independent unit of work
(it needs a bundler decision for Monaco, a new tab in `ArtifactsAside.tsx`, and hands-on mobile
verification). Splitting mirrors `docs/superpowers/plans/2026-09-03-session-artifacts-aside.md`'s
own Phase A/B split for the *same file* (`ArtifactsAside.tsx`) for the same reason: the backend is
fully testable and mergeable on its own, and the frontend plan can then consume a finished,
frozen API instead of co-evolving with it.

**What Phase 2 will need from here, exactly:**
- Seven routes under `/api/fleet/tree*`, described route-by-route in Task 11.
- `Preferences.editorEnabled` / `Preferences.editorAutosave` (Task 1) — Phase 2 adds the Settings
  toggle that flips them through the existing generic `PUT /api/preferences`; no new preferences
  route is needed, exactly like `shellEnabled`.
- A resolved `editorEnabled: boolean` on `GET /api/team/session` (Task 1, Step 4) — Phase 2 reads
  this directly to decide whether the tab exists at all; it already combines the capability and
  the preference, so the frontend never re-derives `editorAllowed` itself.
- The exact refusal reason codes each route can answer with (Task 11's table), which Phase 2's UI
  renders into sentences already prepared in English/Portuguese, or reads directly from
  `message` for a first pass.

## Global Constraints

- **Language:** code, comments, and this plan are English, matching `docs/superpowers/specs/2026-09-11-repository-explorer-aside-design.md` and this project's own CLAUDE.md rule. **Commit messages follow this repo's actual practice** — Conventional Commits type prefix in English (`feat(server): …`), description in Portuguese — matching the sibling PRs for this same task (#511, #525) and this project's own recent git history.
- **Worktree:** already created at `.claude/worktrees/repo-explorer`, branch `feat/repo-explorer-aside`, based on `origin/dev`. Never `cd` the session into another worktree; use absolute paths from here.
- **Pre-commit hook runs `bun tsc --noEmit` and the full `bun test`.** Both must pass on every commit.
- **Never stage with `git add -A`** — other sessions share this checkout's siblings. Stage the exact paths each step names.
- **Refuse, never repair.** A path that needed fixing is a path nobody meant to send.
- **A pure module names no sentence.** Refusal reasons are language-free codes; the caller (`editor-web.ts`) renders words — same split as `central-runtime.ts` and `shell-spec.ts`.
- **N/A, never a confident empty success.** Every refusal in a route response carries a reason code and a message; no route returns `{ ok: true }`-shaped success where it means "cannot".
- **Reuse `CAPS.localShell`** (`exposure.ts`) — do **not** add a new capability flag. The spec is explicit that this rides the same security answer as the per-session shell.
- **The `/api/fleet` prefix in `capability-guard.ts` already covers every `/api/fleet/tree*` path.** Do not add anything to `capability-guard.ts` in this plan — Task 12's test only *confirms* this, it changes nothing there.
- **Path containment is enforced on every single request**, both lexically (`resolveTreePath`) and after resolving symlinks (`realContained`) — never one without the other.
- **Do not use browser automation for this phase** — there is no UI yet. Verify every route with `curl`, per Task 13.
- **This phase does not touch `ArtifactsAside.tsx` or any other frontend file.**

---

## Task 1: `editor-gate.ts` — the two-gate check, and the preference it reads

**Files:**
- Create: `packages/server/server/sessions/editor-gate.ts`
- Create: `packages/server/server/sessions/editor-gate.test.ts`
- Modify: `packages/server/server/preferences.ts` (add two fields to `Preferences`)
- Modify: `packages/server/server/auth.ts` (expose the RESOLVED `editorEnabled` on `GET /api/team/session`, exactly like `shellEnabled`)
- Modify: `packages/server/server/auth.test.ts` (one assertion, mirroring the existing `shellEnabled` one)

**Interfaces:**
- Consumes: nothing.
- Produces: `editorAllowed(capable: boolean, preference: boolean | undefined): boolean`; and, via
  `auth.ts`, a resolved `editorEnabled: boolean` field on `GET /api/team/session` that Phase 2
  reads directly (mirrors `TeamSessionState.shellEnabled` in `app-context.ts` / `App.tsx`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-gate.test.ts
import { describe, expect, test } from 'bun:test'
import { editorAllowed } from './editor-gate'

describe('editorAllowed', () => {
  test('absent preference reads as OFF', () => {
    expect(editorAllowed(true, undefined)).toBe(false)
  })
  test('preference true but not capable is still OFF — the preference only narrows', () => {
    expect(editorAllowed(false, true)).toBe(false)
  })
  test('capable and explicitly on is ON', () => {
    expect(editorAllowed(true, true)).toBe(true)
  })
  test('preference explicitly false is OFF even when capable', () => {
    expect(editorAllowed(true, false)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/repo-explorer
bun test packages/server/server/sessions/editor-gate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/server/sessions/editor-gate.ts
/**
 * editor-gate.ts — PURE: may this machine serve the repository explorer's read+write routes?
 *
 * Filesystem read+write+create+delete over an arbitrary subtree is at least as powerful as the
 * per-session shell — arguably more directly dangerous, since it needs no command execution at
 * all to do damage. It gets the SAME two-gate model `shell-gate.ts` already established, not a
 * weaker one:
 *
 *  - `capable` is `CAPS.localShell`, decided by the exposure profile in `exposure.ts`. This is
 *    deliberately the SAME capability the shell rides, not a new one — the spec is explicit that
 *    there is no deployment that should expose a shell but not this.
 *  - `preference` is the user's own switch (`Preferences.editorEnabled`), and it may only ever
 *    NARROW `capable`. Absent reads as OFF, for the same reason `shellAllowed` gives: treating
 *    absence as ON would open a read/write file editor in the browser of every machine nobody has
 *    touched since the upgrade.
 *
 * It is a SEPARATE switch from `shellEnabled`, not a reuse of it: a person who wants a shell has
 * not thereby asked for a file editor, or vice versa — folding two distinct grants into one switch
 * is exactly the trap `chat-gate.ts`'s header warns about.
 */
export function editorAllowed(capable: boolean, preference: boolean | undefined): boolean {
  return capable && preference === true
}
```

Modify `packages/server/server/preferences.ts` — add these two fields next to `shellEnabled`
(around line 95):

```ts
  /** Opt-in for the repository explorer's read+write routes (`/api/fleet/tree*`). Absent reads as
   *  OFF, and it can only ever narrow `CAPS.localShell` — the same capability the utility shell
   *  rides; see `sessions/editor-gate.ts`. Separate from `shellEnabled`: wanting a shell is not
   *  the same ask as wanting a file editor. */
  editorEnabled?: boolean
  /** Opt-in autosave inside the repository explorer's editor. Absent reads as OFF — autosave adds
   *  no real performance cost but does raise the window in which this editor's write could race
   *  an agent's own write to the same file, so a person opts in deliberately. Meaningless while
   *  `editorEnabled` is off; not itself security-gated because it can only ever narrow what is
   *  already gated by `editorEnabled`. */
  editorAutosave?: boolean
```

- [ ] **Step 4: Expose the RESOLVED value on `GET /api/team/session`, exactly like `shellEnabled`**

Phase 2's frontend needs to know whether the editor is actually usable — capability AND
preference together — without re-deriving `editorAllowed` client-side. `handleSession` in
`packages/server/server/auth.ts` already does this for the shell; add the same line for the
editor.

Modify the `prefs` catch-fallback type (around line 320):

```ts
  const prefs = await readPreferences().catch(() => ({} as {
    chatEnabled?: boolean; shellEnabled?: boolean; editorEnabled?: boolean
  }))
```

Add the import at the top of `auth.ts`, next to the existing `shellAllowed` import:

```ts
import { editorAllowed } from './sessions/editor-gate'
```

Add the field to the JSON response, next to `shellEnabled` (around line 345):

```ts
      // The same split, for the repository explorer: the capability AND the user's own switch,
      // separate from `capabilities.localShell` (the profile alone) so Settings can say "your
      // profile allows this, you have it off". Rides the SAME capability as the shell — see
      // `sessions/editor-gate.ts` for why there is no dedicated `localEditor` flag.
      editorEnabled: editorAllowed(CAPS.localShell, prefs.editorEnabled),
```

In `packages/server/server/auth.test.ts`, add one assertion next to the existing
`'reports shellEnabled separately from capabilities.localShell'` test:

```ts
  it('reports editorEnabled the same way it reports shellEnabled', async () => {
    const res = await handleSession(new Request('http://x/api/team/session'))
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['editorEnabled']).toBe('boolean')
  })
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-gate.test.ts
bun test packages/server/server/auth.test.ts
bun tsc --noEmit
```

Expected: 4 pass in `editor-gate.test.ts`, the full `auth.test.ts` suite green including the new
assertion, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/server/server/sessions/editor-gate.ts packages/server/server/sessions/editor-gate.test.ts packages/server/server/preferences.ts packages/server/server/auth.ts packages/server/server/auth.test.ts
git commit -m "feat(server): gate para o explorador de repositório (editorEnabled + CAPS.localShell)"
```

---

## Task 2: `editor-path.ts` — path containment

**Files:**
- Create: `packages/server/server/sessions/editor-path.ts`
- Create: `packages/server/server/sessions/editor-path.test.ts`

**Interfaces:**
- Consumes: `withinDirectory` from `./artifact-file` (already exported).
- Produces: `containedInRoot(path: string, root: string): boolean`; `TreePathRefusal = 'escaped'`; `TreePathPlan = { ok: true; abs: string } | { ok: false; reason: TreePathRefusal }`; `resolveTreePath(root: string, requested: string): TreePathPlan`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-path.test.ts
import { describe, expect, test } from 'bun:test'
import { containedInRoot, resolveTreePath } from './editor-path'

describe('containedInRoot', () => {
  test('the root itself counts as contained', () => {
    expect(containedInRoot('/w', '/w')).toBe(true)
  })
  test('a child path is contained', () => {
    expect(containedInRoot('/w/a/b.ts', '/w')).toBe(true)
  })
  test('a sibling directory that merely shares a prefix is NOT contained', () => {
    // /w2 starts with the string "/w" but is not inside it.
    expect(containedInRoot('/w2/a.ts', '/w')).toBe(false)
  })
  test('a parent of root is not contained', () => {
    expect(containedInRoot('/', '/w')).toBe(false)
  })
})

describe('resolveTreePath', () => {
  test('an empty path names the root', () => {
    const r = resolveTreePath('/w', '')
    expect(r).toEqual({ ok: true, abs: '/w' })
  })
  test('a plain relative path resolves inside the root', () => {
    const r = resolveTreePath('/w', 'src/a.ts')
    expect(r).toEqual({ ok: true, abs: '/w/src/a.ts' })
  })
  test('.. is refused once it would leave the root', () => {
    const r = resolveTreePath('/w', '../etc/passwd')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })
  test('.. that stays inside the root is fine', () => {
    const r = resolveTreePath('/w', 'a/../b.ts')
    expect(r).toEqual({ ok: true, abs: '/w/b.ts' })
  })
  test('an absolute path from the client is always refused — there is no route that accepts one', () => {
    const r = resolveTreePath('/w', '/etc/passwd')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })
  test('whitespace around the path is trimmed before resolving', () => {
    const r = resolveTreePath('/w', '  src/a.ts  ')
    expect(r).toEqual({ ok: true, abs: '/w/src/a.ts' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-path.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/server/sessions/editor-path.ts
/**
 * editor-path.ts — PURE: is a client-given path allowed inside a session's directory tree?
 *
 * This generalizes the exact posture `resolveArtifactPath` / `withinDirectory` (`artifact-file.ts`)
 * already take for the Files tab's ALLOWLIST — applied here to the whole subtree instead of a
 * named list, because this feature has no allowlist: every file under the session's directory is
 * fair game, and the only question is containment.
 *
 * This module is the LEXICAL half only (no IO, no symlink resolution) — it catches a `..` escape
 * before anything touches disk. The REAL half (resolving symlinks and re-checking containment on
 * the resolved paths, to catch a symlink INSIDE the tree pointing outside it) lives in
 * `editor-fs.ts`, which is where the filesystem access already is.
 */
import { isAbsolute, resolve } from 'node:path'
import { withinDirectory } from './artifact-file'

/** Is `path` the root itself, or somewhere inside it? `withinDirectory` alone excludes the root. */
export function containedInRoot(path: string, root: string): boolean {
  return path === root || withinDirectory(path, root)
}

export type TreePathRefusal = 'escaped'
export type TreePathPlan =
  | { ok: true; abs: string }
  | { ok: false; reason: TreePathRefusal }

/**
 * Resolve a client-given relative path against `root`. `''` names the root itself (used for
 * listing the top of the tree). There is no route that accepts an absolute path from the client —
 * one is refused exactly like a `..` escape, never silently rebased onto the root.
 */
export function resolveTreePath(root: string, requested: string): TreePathPlan {
  const raw = (requested ?? '').trim()
  if (raw === '') return { ok: true, abs: root }
  if (isAbsolute(raw)) return { ok: false, reason: 'escaped' }
  const abs = resolve(root, raw)
  return containedInRoot(abs, root) ? { ok: true, abs } : { ok: false, reason: 'escaped' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-path.test.ts
bun tsc --noEmit
```

Expected: 10 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-path.ts packages/server/server/sessions/editor-path.test.ts
git commit -m "feat(server): contenção de caminho (lexical) pro explorador de repositório"
```

---

## Task 3: `editor-directory.ts` — which directory a session's tree is rooted at

**Files:**
- Create: `packages/server/server/sessions/editor-directory.ts`
- Create: `packages/server/server/sessions/editor-directory.test.ts`

**Interfaces:**
- Consumes: nothing (pure — the caller in `editor-fs.ts` gathers the facts).
- Produces: `SessionDirFacts`, `SessionDirRefusal`, `SessionDirPlan`, `planSessionDirectory(f: SessionDirFacts): SessionDirPlan`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-directory.test.ts
import { describe, expect, test } from 'bun:test'
import { planSessionDirectory } from './editor-directory'

describe('planSessionDirectory', () => {
  test('a live row wins over the store', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: '/live', storeDir: '/store', dirExists: true,
    })
    expect(r).toEqual({ ok: true, dir: '/live' })
  })
  test('falls back to the store when there is no live row', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: undefined, storeDir: '/store', dirExists: true,
    })
    expect(r).toEqual({ ok: true, dir: '/store' })
  })
  test('a session nobody has ever heard of is unknown-session, not no-cwd', () => {
    const r = planSessionDirectory({
      sessionKnown: false, liveCwd: undefined, storeDir: undefined, dirExists: false,
    })
    expect(r).toEqual({ ok: false, reason: 'unknown-session' })
  })
  test('a known session with no recorded directory anywhere is no-cwd', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: undefined, storeDir: undefined, dirExists: false,
    })
    expect(r).toEqual({ ok: false, reason: 'no-cwd' })
  })
  test('a recorded directory that no longer exists on disk is cwd-missing', () => {
    const r = planSessionDirectory({
      sessionKnown: true, liveCwd: '/gone', storeDir: undefined, dirExists: false,
    })
    expect(r).toEqual({ ok: false, reason: 'cwd-missing' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-directory.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/server/sessions/editor-directory.ts
/**
 * editor-directory.ts — PURE: which directory does a session's repository tree root at?
 *
 * The decision mirrors `sessionGitPaths` (`git.ts`) — "a session's own last directory, project as
 * the fallback" — extended with a LIVE row on top, because a running session's registry `cwd` is
 * more current than anything the consolidate store has written. Order:
 *
 *  1. A live managed/external fleet row's own `cwd` (the same source `readFleetArtifact` /
 *     `readFleetPullRequests` already use).
 *  2. Otherwise the store: `SessionMeta.current_cwd`, then `project_path` — this is what makes the
 *     tab work for a CLOSED session too, which no other aside tab needs to do today.
 *
 * This module takes already-gathered FACTS and decides; the IO that gathers them (`host.sessions()`,
 * `loadConsolidated()`, a `stat`) lives in `editor-fs.ts`. Same split as `shell-spec.ts`'s
 * `ShellOpenFacts` / `planShellOpen`.
 */

export interface SessionDirFacts {
  /** True when the id resolved to SOMETHING — a live fleet row, or a store record — even if that
   *  something records no directory. Distinguishes "this session has no folder" from "this
   *  machine has never heard of this session". */
  sessionKnown: boolean
  /** A live fleet row's `cwd`, when one was found. */
  liveCwd: string | undefined
  /** `SessionMeta.current_cwd || SessionMeta.project_path`, when a store record was found. */
  storeDir: string | undefined
  /** Does the chosen directory (`liveCwd || storeDir`) exist on disk right now? Meaningless when
   *  neither is set. */
  dirExists: boolean
}

export type SessionDirRefusal =
  /** Neither a live row nor a store record names this id at all. */
  | 'unknown-session'
  /** The session is known, but records no directory anywhere. */
  | 'no-cwd'
  /** It records one, and that directory is gone — the removed-worktree case. */
  | 'cwd-missing'

export type SessionDirPlan =
  | { ok: true; dir: string }
  | { ok: false; reason: SessionDirRefusal }

export function planSessionDirectory(f: SessionDirFacts): SessionDirPlan {
  const dir = f.liveCwd || f.storeDir
  if (!dir) return { ok: false, reason: f.sessionKnown ? 'no-cwd' : 'unknown-session' }
  if (!f.dirExists) return { ok: false, reason: 'cwd-missing' }
  return { ok: true, dir }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-directory.test.ts
bun tsc --noEmit
```

Expected: 5 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-directory.ts packages/server/server/sessions/editor-directory.test.ts
git commit -m "feat(server): decisão pura de qual diretório uma sessão usa no explorador"
```

---

## Task 4: `editor-list.ts` — shaping a directory listing into immediate children

**Files:**
- Create: `packages/server/server/sessions/editor-list.ts`
- Create: `packages/server/server/sessions/editor-list.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TreeChild { name: string; kind: 'file' | 'dir' }`; `collapseToChildren(relativePaths: readonly string[]): TreeChild[]`; `childrenFromDirents(entries: readonly { name: string; isDirectory(): boolean }[]): TreeChild[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-list.test.ts
import { describe, expect, test } from 'bun:test'
import { childrenFromDirents, collapseToChildren } from './editor-list'

describe('collapseToChildren', () => {
  test('a flat file at the top is a file child', () => {
    expect(collapseToChildren(['a.ts'])).toEqual([{ name: 'a.ts', kind: 'file' }])
  })
  test('a nested path collapses to its top segment as a directory child, once', () => {
    const out = collapseToChildren(['src/a.ts', 'src/b.ts', 'src/deep/c.ts'])
    expect(out).toEqual([{ name: 'src', kind: 'dir' }])
  })
  test('directories sort before files, each alphabetically', () => {
    const out = collapseToChildren(['b.ts', 'a.ts', 'zdir/x.ts', 'adir/y.ts'])
    expect(out.map(c => c.name)).toEqual(['adir', 'zdir', 'a.ts', 'b.ts'])
  })
  test('a leading slash from a pathspec artifact is tolerated', () => {
    expect(collapseToChildren(['/a.ts'])).toEqual([{ name: 'a.ts', kind: 'file' }])
  })
  test('an empty list is an empty tree, not an error', () => {
    expect(collapseToChildren([])).toEqual([])
  })
})

describe('childrenFromDirents', () => {
  const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir })
  test('directories first, each side alphabetical', () => {
    const out = childrenFromDirents([
      dirent('b.ts', false), dirent('a.ts', false), dirent('zdir', true), dirent('adir', true),
    ])
    expect(out).toEqual([
      { name: 'adir', kind: 'dir' },
      { name: 'zdir', kind: 'dir' },
      { name: 'a.ts', kind: 'file' },
      { name: 'b.ts', kind: 'file' },
    ])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-list.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/server/sessions/editor-list.ts
/**
 * editor-list.ts — PURE: turning a set of paths into the IMMEDIATE children of one directory.
 *
 * The tree is LAZY — one directory per call, never a recursive dump — but `git ls-files` has no
 * concept of "immediate children"; it only ever answers with the full recursive set under a
 * pathspec. `collapseToChildren` is what turns that recursive, gitignore-aware set into exactly
 * the one level the tree UI asked for, which is what keeps the git-aware path lazy too.
 */

export interface TreeChild {
  name: string
  kind: 'file' | 'dir'
}

const byName = (a: string, b: string) => a.localeCompare(b)

/**
 * `relativePaths` are paths relative to the directory being listed (never to its parent), as
 * `editor-fs.ts` produces after stripping the pathspec prefix off `git ls-files`' own output.
 */
export function collapseToChildren(relativePaths: readonly string[]): TreeChild[] {
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const raw of relativePaths) {
    const p = raw.replace(/^\/+/, '')
    if (!p) continue
    const slash = p.indexOf('/')
    if (slash === -1) { files.add(p); continue }
    const head = p.slice(0, slash)
    if (head) dirs.add(head)
  }
  return [
    ...[...dirs].sort(byName).map(name => ({ name, kind: 'dir' as const })),
    ...[...files].sort(byName).map(name => ({ name, kind: 'file' as const })),
  ]
}

/** The non-git fallback: a plain `readdir` has no gitignore to lean on, so nothing is filtered. */
export function childrenFromDirents(
  entries: readonly { name: string; isDirectory(): boolean }[],
): TreeChild[] {
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort(byName)
  const files = entries.filter(e => !e.isDirectory()).map(e => e.name).sort(byName)
  return [
    ...dirs.map(name => ({ name, kind: 'dir' as const })),
    ...files.map(name => ({ name, kind: 'file' as const })),
  ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-list.test.ts
bun tsc --noEmit
```

Expected: 6 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-list.ts packages/server/server/sessions/editor-list.test.ts
git commit -m "feat(server): colapso de listagem git em filhos imediatos de um diretório"
```

---

## Task 5: `editor-conflict.ts` — the save-time conflict check

**Files:**
- Create: `packages/server/server/sessions/editor-conflict.ts`
- Create: `packages/server/server/sessions/editor-conflict.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WriteRefusal = 'conflict'`; `WritePlan = { ok: true } | { ok: false; reason: WriteRefusal; diskMtimeMs: number }`; `planFileWrite(o: { expectedMtimeMs: number; diskMtimeMs: number }): WritePlan`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-conflict.test.ts
import { describe, expect, test } from 'bun:test'
import { planFileWrite } from './editor-conflict'

describe('planFileWrite', () => {
  test('matching mtimes proceed', () => {
    expect(planFileWrite({ expectedMtimeMs: 100, diskMtimeMs: 100 })).toEqual({ ok: true })
  })
  test('a disk mtime newer than what the client last read is a conflict', () => {
    expect(planFileWrite({ expectedMtimeMs: 100, diskMtimeMs: 200 })).toEqual({
      ok: false, reason: 'conflict', diskMtimeMs: 200,
    })
  })
  test('this is the SAME rule regardless of direction — any mismatch is a conflict', () => {
    // A disk mtime OLDER than expected is just as much "not what I last read" as a newer one — the
    // file could have been reverted from a backup, or the clock could be wrong. The rule is never
    // "did it get newer", only "did it change from what I saw".
    expect(planFileWrite({ expectedMtimeMs: 200, diskMtimeMs: 100 })).toEqual({
      ok: false, reason: 'conflict', diskMtimeMs: 100,
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-conflict.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/server/sessions/editor-conflict.ts
/**
 * editor-conflict.ts — PURE: the rule the whole feature's safety promise rests on.
 *
 * A save must NEVER silently clobber a change an agent made on disk while the file was open in the
 * editor. This is a plain mtime check, not a content hash: cheap on every save, and sufficient —
 * the only thing that matters is "did something else touch this file since I read it", not what
 * changed. Nothing is written automatically on a mismatch in either direction; the caller
 * (`editor-fs.ts`) refuses the write and hands the current disk content back so the person can
 * choose, which is the "agent's work always wins the silent case" rule stated in words rather than
 * enforced by picking a winner in code.
 */

export type WriteRefusal = 'conflict'

export type WritePlan =
  | { ok: true }
  | { ok: false; reason: WriteRefusal; diskMtimeMs: number }

export function planFileWrite(o: { expectedMtimeMs: number; diskMtimeMs: number }): WritePlan {
  return o.expectedMtimeMs === o.diskMtimeMs
    ? { ok: true }
    : { ok: false, reason: 'conflict', diskMtimeMs: o.diskMtimeMs }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-conflict.test.ts
bun tsc --noEmit
```

Expected: 3 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-conflict.ts packages/server/server/sessions/editor-conflict.test.ts
git commit -m "feat(server): verificação de conflito por mtime ao salvar no explorador"
```

---

## Task 6: `editor-search.ts` — shaping and capping search results

**Files:**
- Create: `packages/server/server/sessions/editor-search.ts`
- Create: `packages/server/server/sessions/editor-search.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SEARCH_LIMIT`; `NameHit`, `ContentHit`, `SearchHit`; `SearchResult { hits: SearchHit[]; truncated: boolean }`; `capHits(hits, limit?)`; `parseGrepOutput(stdout: string): ContentHit[]`; `matchNames(relativePaths: readonly string[], q: string): NameHit[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-search.test.ts
import { describe, expect, test } from 'bun:test'
import { capHits, matchNames, parseGrepOutput, SEARCH_LIMIT } from './editor-search'

describe('parseGrepOutput', () => {
  test('parses "path:line:text" per line, git grep -n\'s own shape', () => {
    const out = parseGrepOutput('src/a.ts:12:const x = 1\nsrc/b.ts:3:foo')
    expect(out).toEqual([
      { kind: 'content', path: 'src/a.ts', line: 12, text: 'const x = 1' },
      { kind: 'content', path: 'src/b.ts', line: 3, text: 'foo' },
    ])
  })
  test('a matched line whose TEXT contains a colon is still parsed correctly', () => {
    const out = parseGrepOutput('src/a.ts:5:const o = { a: 1 }')
    expect(out).toEqual([{ kind: 'content', path: 'src/a.ts', line: 5, text: 'const o = { a: 1 }' }])
  })
  test('blank lines are skipped', () => {
    expect(parseGrepOutput('\n\n')).toEqual([])
  })
  test('a line that does not match the shape is skipped rather than throwing', () => {
    expect(parseGrepOutput('not the right shape at all')).toEqual([])
  })
})

describe('matchNames', () => {
  test('matches by basename substring, case-insensitively', () => {
    const out = matchNames(['src/Widget.tsx', 'src/other.ts'], 'widget')
    expect(out).toEqual([{ kind: 'name', path: 'src/Widget.tsx' }])
  })
  test('an empty query matches nothing — this is a search box, not a full listing', () => {
    expect(matchNames(['a.ts', 'b.ts'], '   ')).toEqual([])
  })
})

describe('capHits', () => {
  test('under the limit, nothing is truncated', () => {
    const hits = [{ kind: 'name' as const, path: 'a.ts' }]
    expect(capHits(hits, 10)).toEqual({ hits, truncated: false })
  })
  test('over the limit, the list is cut and truncated is reported', () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({ kind: 'name' as const, path: `${i}.ts` }))
    const out = capHits(hits, 3)
    expect(out.hits).toHaveLength(3)
    expect(out.truncated).toBe(true)
  })
  test('the default limit is SEARCH_LIMIT', () => {
    const hits = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => ({ kind: 'name' as const, path: `${i}` }))
    const out = capHits(hits)
    expect(out.hits).toHaveLength(SEARCH_LIMIT)
    expect(out.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-search.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/server/sessions/editor-search.ts
/**
 * editor-search.ts — PURE: shaping the tree search's two kinds of hit, and capping the result.
 *
 * Mirrors `PR_LIMIT`'s pattern (`fleet-web.ts`) — a bounded response that SAYS when it is a
 * partial window, never a silent cutoff a caller could mistake for "that's everything".
 */

/** Mirrors PR_LIMIT's own bound — capped so a huge match set never becomes a huge response. */
export const SEARCH_LIMIT = 200

export interface NameHit { kind: 'name'; path: string }
export interface ContentHit { kind: 'content'; path: string; line: number; text: string }
export type SearchHit = NameHit | ContentHit

export interface SearchResult {
  hits: SearchHit[]
  truncated: boolean
}

export function capHits(hits: readonly SearchHit[], limit: number = SEARCH_LIMIT): SearchResult {
  return { hits: hits.slice(0, limit), truncated: hits.length > limit }
}

/**
 * Parses `git grep -n`'s own line shape: `<path>:<line>:<text>`. The path group stops at the
 * FIRST colon (POSIX paths do not contain one), the line group is digits only, and everything
 * after the second colon — colons included — is the matched text verbatim.
 */
export function parseGrepOutput(stdout: string): ContentHit[] {
  const out: ContentHit[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const m = /^([^:]+):(\d+):(.*)$/.exec(line)
    if (!m) continue
    out.push({ kind: 'content', path: m[1]!, line: Number(m[2]), text: m[3]! })
  }
  return out
}

/** Filename matches: every relative path whose BASENAME contains `q`, case-insensitively. */
export function matchNames(relativePaths: readonly string[], q: string): NameHit[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return relativePaths
    .filter(p => (p.split('/').pop() ?? p).toLowerCase().includes(needle))
    .map(path => ({ kind: 'name' as const, path }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-search.test.ts
bun tsc --noEmit
```

Expected: 9 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-search.ts packages/server/server/sessions/editor-search.test.ts
git commit -m "feat(server): parsing e limite de resultados de busca no explorador"
```

---

## Task 7: `editor-fs.ts`, part 1 — directory resolution and listing

**Files:**
- Create: `packages/server/server/sessions/editor-fs.ts`
- Create: `packages/server/server/sessions/editor-fs.test.ts`
- Modify: `packages/server/server/sessions/artifact-web.ts` (export the existing `looksBinary`)

**Interfaces:**
- Consumes: `StartHost` from `../cli-start`; `loadConsolidated` from `../consolidate`; `planSessionDirectory` from `./editor-directory`; `resolveTreePath`, `containedInRoot` from `./editor-path`; `collapseToChildren`, `childrenFromDirents`, `TreeChild` from `./editor-list`.
- Produces (this task): `resolveSessionDirectory(host: StartHost, id: string): Promise<SessionDirPlan>`; `EntryRefusal` (partial, grows in later tasks); `listChildren(root: string, requestedPath: string): Promise<ListPlan>`.

This task also introduces the shared `realContained` helper every later write/create/rename/delete
task reuses — written now because listing already needs the "does this resolve to a real
directory inside root" check.

**Test fixture note — read before writing the test.** Tests that call real `git` in a temp
directory must strip `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_PREFIX` from the child
environment, exactly like `packages/server/server/backup/repo-probe.test.ts` already does — this
repo's own pre-commit hook runs from a linked worktree and exports those variables pointing at the
OUTER checkout, and without stripping them a `git init` in a temp dir silently operates on the real
repository instead. Copy that file's `git()` helper verbatim into the new test file.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-fs.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listChildren, resolveSessionDirectory } from './editor-fs'
import type { StartHost } from '../cli-start'

// Same reason repo-probe.test.ts strips these: a pre-commit hook running from a linked worktree
// exports GIT_DIR / GIT_INDEX_FILE pointing at the OUTER checkout, and `-C`/`cwd` do not override
// GIT_DIR for repository discovery.
const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_PREFIX
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

let root = ''
let gitRepo = ''
let plainDir = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentistics-editor-'))

  gitRepo = join(root, 'gitrepo')
  mkdirSync(gitRepo)
  git(gitRepo, 'init', '-q', '-b', 'main')
  git(gitRepo, 'config', 'user.email', 't@t')
  git(gitRepo, 'config', 'user.name', 't')
  mkdirSync(join(gitRepo, 'src'))
  writeFileSync(join(gitRepo, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(gitRepo, 'README.md'), '# hi\n')
  writeFileSync(join(gitRepo, '.gitignore'), 'ignored.log\n')
  writeFileSync(join(gitRepo, 'ignored.log'), 'should not appear\n')
  git(gitRepo, 'add', 'src/a.ts', 'README.md', '.gitignore')
  git(gitRepo, 'commit', '-q', '-m', 'init')
  writeFileSync(join(gitRepo, 'src', 'untracked.ts'), 'export const b = 2\n')

  plainDir = join(root, 'plain')
  mkdirSync(plainDir)
  writeFileSync(join(plainDir, 'x.txt'), 'x\n')
  mkdirSync(join(plainDir, 'sub'))
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const noHost: StartHost = {}

describe('resolveSessionDirectory', () => {
  test('an unknown id refuses unknown-session', async () => {
    const r = await resolveSessionDirectory(noHost, 'nope')
    expect(r).toEqual({ ok: false, reason: 'unknown-session' })
  })

  test('a live fleet row wins, and its cwd is checked for existence', async () => {
    const host: StartHost = {
      sessions: async () => ({
        sessions: [{ id: 's1', conversationId: 'c1', cwd: gitRepo } as never],
        rows: [], attention: 0, tasks: [],
      }),
    }
    const r = await resolveSessionDirectory(host, 's1')
    expect(r).toEqual({ ok: true, dir: gitRepo })
  })

  test('a live row naming a directory that does not exist refuses cwd-missing', async () => {
    const host: StartHost = {
      sessions: async () => ({
        sessions: [{ id: 's2', conversationId: 'c2', cwd: join(root, 'gone') } as never],
        rows: [], attention: 0, tasks: [],
      }),
    }
    const r = await resolveSessionDirectory(host, 's2')
    expect(r).toEqual({ ok: false, reason: 'cwd-missing' })
  })
})

describe('listChildren', () => {
  test('a git repo lists tracked + untracked-not-ignored, never the gitignored file', async () => {
    const r = await listChildren(gitRepo, '')
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'src', kind: 'dir' },
        { name: 'README.md', kind: 'file' },
      ],
    })
  })

  test('listing a subdirectory of a git repo strips the parent prefix', async () => {
    const r = await listChildren(gitRepo, 'src')
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'a.ts', kind: 'file' },
        { name: 'untracked.ts', kind: 'file' },
      ],
    })
  })

  test('a plain (non-git) directory falls back to a bare readdir', async () => {
    const r = await listChildren(plainDir, '')
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'sub', kind: 'dir' },
        { name: 'x.txt', kind: 'file' },
      ],
    })
  })

  test('a path that does not exist on disk refuses not-found', async () => {
    const r = await listChildren(gitRepo, 'nope')
    expect(r).toEqual({ ok: false, reason: 'not-found' })
  })

  test('a path that names a FILE, not a directory, refuses not-a-directory', async () => {
    const r = await listChildren(gitRepo, 'README.md')
    expect(r).toEqual({ ok: false, reason: 'not-a-directory' })
  })

  test('a .. escape is refused before anything is read', async () => {
    const r = await listChildren(gitRepo, '../../etc')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })

  test('a symlink INSIDE the tree pointing outside it is refused, not followed', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'nope\n')
    symlinkSync(outside, join(plainDir, 'escape-link'))
    const r = await listChildren(plainDir, 'escape-link')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Export `looksBinary` from `artifact-web.ts`**

In `packages/server/server/sessions/artifact-web.ts`, change the private helper to an export (this
task does not use it yet — Task 8 does — but the change is a one-word diff and belongs with the
first task that touches this file):

```ts
/** A NUL byte in the first chunk. The same test `file(1)` starts from, and enough for this. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}
```

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/server/server/sessions/editor-fs.ts
/**
 * editor-fs.ts — the IO around the repository explorer's PURE decisions.
 *
 * `resolveSessionDirectory` gathers the facts `editor-directory.ts`'s `planSessionDirectory`
 * needs (a live fleet row, a store record, a `stat`) and decides through it. Every other function
 * here takes an already-RESOLVED root directory and a client-given relative path, and re-checks
 * containment on the REAL (symlink-resolved) path before touching anything — `editor-path.ts`'s
 * `resolveTreePath` only catches a LEXICAL `..` escape; this is the other half, the one that
 * catches a symlink INSIDE the tree pointing outside it.
 */
import { dirname } from 'node:path'
import { readdir, realpath, stat } from 'node:fs/promises'
import type { StartHost } from '../cli-start'
import { planSessionDirectory, type SessionDirPlan } from './editor-directory'
import { containedInRoot, resolveTreePath } from './editor-path'
import { childrenFromDirents, collapseToChildren, type TreeChild } from './editor-list'

async function pathIsDirectory(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

export async function resolveSessionDirectory(host: StartHost, id: string): Promise<SessionDirPlan> {
  let sessionKnown = false
  let liveCwd: string | undefined
  if (host.sessions) {
    const fleet = await host.sessions()
    const row = fleet.sessions.find(r => r.id === id || r.conversationId === id)
    if (row) {
      sessionKnown = true
      liveCwd = row.cwd || undefined
    }
  }
  let storeDir: string | undefined
  if (!liveCwd) {
    const { loadConsolidated } = await import('../consolidate')
    const map = await loadConsolidated()
    const meta = map.get(id)
    if (meta) {
      sessionKnown = true
      storeDir = meta.current_cwd || meta.project_path || undefined
    }
  }
  const dir = liveCwd || storeDir
  const dirExists = dir ? await pathIsDirectory(dir) : false
  return planSessionDirectory({ sessionKnown, liveCwd, storeDir, dirExists })
}

/**
 * Everything this module's write/create/rename/delete/list/search functions can refuse with,
 * beyond a directory-resolution failure (which the caller in `editor-web.ts` handles separately,
 * before ever reaching here).
 */
export type EntryRefusal = 'escaped' | 'not-found' | 'not-a-directory'

export type ListPlan =
  | { ok: true; children: TreeChild[] }
  | { ok: false; reason: EntryRefusal }

/**
 * The REAL containment recheck. `resolveTreePath` already refused a lexical `..`; this catches a
 * symlink placed INSIDE the tree that points somewhere else — `realpath` follows every link on
 * both sides, and the containment test runs again on what it actually resolves to.
 *
 * Returns the real, resolved path on success. A target that does not exist YET (a create) has no
 * real path of its own — the caller checks its PARENT instead; see Task 9.
 */
async function realContained(root: string, abs: string): Promise<string | null> {
  try {
    const [realRoot, realAbs] = await Promise.all([realpath(root), realpath(abs)])
    return containedInRoot(realAbs, realRoot) ? realAbs : null
  } catch {
    return null
  }
}

export async function listChildren(root: string, requestedPath: string): Promise<ListPlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }

  const real = await realContained(root, planned.abs)
  if (real === null) {
    // Either it does not exist, or it escaped via a symlink. Either way there is nothing to list.
    try {
      await stat(planned.abs)
    } catch {
      return { ok: false, reason: 'not-found' }
    }
    return { ok: false, reason: 'escaped' }
  }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isDirectory()) return { ok: false, reason: 'not-a-directory' }

  const realRoot = await realpath(root)
  const relDir = real === realRoot ? '' : real.slice(realRoot.length + 1)

  const git = await gitListRecursive(realRoot, relDir)
  if (git !== null) return { ok: true, children: collapseToChildren(git) }

  const entries = await readdir(real, { withFileTypes: true })
  return { ok: true, children: childrenFromDirents(entries) }
}

/**
 * The recursive, gitignore-aware file list under `relDir` (relative to `root`), with paths
 * returned relative to `relDir` itself. `null` when `root` is not a git work tree at all (the
 * command's own exit code says so — no separate "is this a repo" probe is needed).
 */
async function gitListRecursive(root: string, relDir: string): Promise<string[] | null> {
  const pathspec = relDir === '' ? '.' : relDir
  const res = await runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', pathspec])
  if (!res.ok) return null
  const prefix = relDir === '' ? '' : `${relDir}/`
  return res.out.split('\n').filter(Boolean).map(p => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
}

/** One `git` runner for this whole module — mirrors `shell-web.ts`'s own `tmux()` helper. */
async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    return { ok: code === 0, out }
  } catch {
    return { ok: false, out: '' }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
bun tsc --noEmit
```

Expected: all pass (12 tests), typecheck clean. If the symlink test fails on a filesystem without
symlink support, note it and move on — this environment (Linux) supports them.

- [ ] **Step 6: Commit**

```bash
git add packages/server/server/sessions/editor-fs.ts packages/server/server/sessions/editor-fs.test.ts packages/server/server/sessions/artifact-web.ts
git commit -m "feat(server): resolução de diretório e listagem gitignore-aware do explorador"
```

---

## Task 8: `editor-fs.ts`, part 2 — read a file, write a file with conflict detection

**Files:**
- Modify: `packages/server/server/sessions/editor-fs.ts`
- Modify: `packages/server/server/sessions/editor-fs.test.ts`

**Interfaces:**
- Consumes: `looksBinary` from `./artifact-web` (exported in Task 7); `planFileWrite` from `./editor-conflict`.
- Produces: `ReadFilePlan`, `readTreeFile(root, requestedPath)`; `WriteFilePlan`, `writeTreeFile(root, requestedPath, content, expectedMtimeMs)`.

- [ ] **Step 1: Write the failing test**

Append to `editor-fs.test.ts`:

```ts
import { readFileSync, statSync } from 'node:fs'
import { readTreeFile, writeTreeFile } from './editor-fs'

describe('readTreeFile', () => {
  test('reads text content and the file\'s current mtime', async () => {
    const r = await readTreeFile(gitRepo, 'README.md')
    expect(r.ok).toBe(true)
    if (r.ok && !r.binary) {
      expect(r.content).toBe('# hi\n')
      expect(r.mtimeMs).toBe(statSync(join(gitRepo, 'README.md')).mtimeMs)
    }
  })

  test('a binary file is reported as such, never sent as text', async () => {
    const binPath = join(plainDir, 'image.bin')
    writeFileSync(binPath, Buffer.from([0, 1, 2, 3, 0, 5]))
    const r = await readTreeFile(plainDir, 'image.bin')
    expect(r).toEqual({ ok: true, binary: true, name: 'image.bin', size: 6 })
  })

  test('a directory is refused as not-a-file', async () => {
    const r = await readTreeFile(gitRepo, 'src')
    expect(r).toEqual({ ok: false, reason: 'not-a-file' })
  })

  test('a missing file is refused as not-found', async () => {
    const r = await readTreeFile(gitRepo, 'nope.ts')
    expect(r).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('writeTreeFile', () => {
  test('a matching mtime writes, and returns the NEW mtime', async () => {
    const before = statSync(join(gitRepo, 'README.md')).mtimeMs
    const out = await writeTreeFile(gitRepo, 'README.md', '# updated\n', before)
    expect(out.ok).toBe(true)
    expect(readFileSync(join(gitRepo, 'README.md'), 'utf8')).toBe('# updated\n')
    if (out.ok) expect(out.mtimeMs).toBeGreaterThanOrEqual(before)
  })

  test('a stale mtime is refused as a conflict, and the CURRENT disk content is returned', async () => {
    const target = join(gitRepo, 'README.md')
    const current = statSync(target).mtimeMs
    const out = await writeTreeFile(gitRepo, 'README.md', '# my edit\n', current - 999999)
    expect(out).toMatchObject({ ok: false, reason: 'conflict' })
    if (!out.ok && out.reason === 'conflict') {
      expect(out.content).toBe('# updated\n')
    }
    // The file on disk must be UNTOUCHED — this is the whole safety guarantee.
    expect(readFileSync(target, 'utf8')).toBe('# updated\n')
  })

  test('writing a new file under a path that does not exist yet fails not-found — this route never creates', async () => {
    const out = await writeTreeFile(gitRepo, 'brand-new.ts', 'x', 0)
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })

  test('a .. escape is refused before any write is attempted', async () => {
    const out = await writeTreeFile(gitRepo, '../../etc/passwd', 'x', 0)
    expect(out).toEqual({ ok: false, reason: 'escaped' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
```

Expected: FAIL — `readTreeFile` / `writeTreeFile` not exported.

- [ ] **Step 3: Implement**

Append to `editor-fs.ts` (add `looksBinary` and `planFileWrite` to the imports at the top, and add
`readFile`, `writeFile` to the `node:fs/promises` import):

```ts
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
// ...
import { looksBinary } from './artifact-web'
import { planFileWrite } from './editor-conflict'
```

```ts
export type ReadFileRefusal = EntryRefusal | 'not-a-file'

export type ReadFilePlan =
  | { ok: true; content: string; mtimeMs: number }
  | { ok: true; binary: true; name: string; size: number }
  | { ok: false; reason: ReadFileRefusal }

export async function readTreeFile(root: string, requestedPath: string): Promise<ReadFilePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const real = await realContained(root, planned.abs)
  if (real === null) return { ok: false, reason: 'not-found' }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' }

  const buf = await readFile(real)
  if (looksBinary(buf)) {
    return { ok: true, binary: true, name: real.split('/').pop() ?? real, size: st.size }
  }
  return { ok: true, content: buf.toString('utf8'), mtimeMs: st.mtimeMs }
}

export type WriteFileRefusal = EntryRefusal | 'not-a-file'

export type WriteFilePlan =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'conflict'; content: string; mtimeMs: number }
  | { ok: false; reason: WriteFileRefusal }

export async function writeTreeFile(
  root: string, requestedPath: string, content: string, expectedMtimeMs: number,
): Promise<WriteFilePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const real = await realContained(root, planned.abs)
  if (real === null) return { ok: false, reason: 'not-found' }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' }

  const plan = planFileWrite({ expectedMtimeMs, diskMtimeMs: st.mtimeMs })
  if (!plan.ok) {
    // The write is refused BEFORE it happens. What comes back is the CURRENT disk content, read
    // fresh — the caller's editor shows it, and nothing here has touched the file.
    const buf = await readFile(real)
    return { ok: false, reason: 'conflict', content: buf.toString('utf8'), mtimeMs: plan.diskMtimeMs }
  }

  await writeFile(real, content, 'utf8')
  const after = await stat(real)
  return { ok: true, mtimeMs: after.mtimeMs }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
bun tsc --noEmit
```

Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-fs.ts packages/server/server/sessions/editor-fs.test.ts
git commit -m "feat(server): leitura e escrita de arquivo com detecção de conflito por mtime"
```

---

## Task 9: `editor-fs.ts`, part 3 — create, rename, delete

**Files:**
- Modify: `packages/server/server/sessions/editor-fs.ts`
- Modify: `packages/server/server/sessions/editor-fs.test.ts`

**Interfaces:**
- Consumes: `mkdir`, `rename`, `rm`, `writeFile` from `node:fs/promises`.
- Produces: `CreatePlan`, `createTreeEntry(root, requestedPath, kind: 'file' | 'dir')`; `RenamePlan`, `renameTreeEntry(root, fromPath, toPath)`; `DeletePlan`, `deleteTreeEntry(root, requestedPath, recursive: boolean)`.

- [ ] **Step 1: Write the failing test**

Append to `editor-fs.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { createTreeEntry, deleteTreeEntry, renameTreeEntry } from './editor-fs'

describe('createTreeEntry', () => {
  test('creates an empty file', async () => {
    const out = await createTreeEntry(plainDir, 'created.txt', 'file')
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'created.txt'))).toBe(true)
  })

  test('creates a folder', async () => {
    const out = await createTreeEntry(plainDir, 'created-dir', 'dir')
    expect(out).toEqual({ ok: true })
    expect(statSync(join(plainDir, 'created-dir')).isDirectory()).toBe(true)
  })

  test('refuses to overwrite something that already exists', async () => {
    const out = await createTreeEntry(plainDir, 'x.txt', 'file')
    expect(out).toEqual({ ok: false, reason: 'already-exists' })
  })

  test('a .. escape is refused', async () => {
    const out = await createTreeEntry(plainDir, '../escaped.txt', 'file')
    expect(out).toEqual({ ok: false, reason: 'escaped' })
  })

  test('creating inside a directory that does not exist yet fails not-found — no implicit mkdir -p', async () => {
    const out = await createTreeEntry(plainDir, 'nosuch/child.txt', 'file')
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('renameTreeEntry', () => {
  test('renames a file within the tree', async () => {
    writeFileSync(join(plainDir, 'to-rename.txt'), 'x')
    const out = await renameTreeEntry(plainDir, 'to-rename.txt', 'renamed.txt')
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'renamed.txt'))).toBe(true)
    expect(existsSync(join(plainDir, 'to-rename.txt'))).toBe(false)
  })

  test('refuses when the source does not exist', async () => {
    const out = await renameTreeEntry(plainDir, 'nope.txt', 'somewhere.txt')
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })

  test('refuses when the destination already exists', async () => {
    writeFileSync(join(plainDir, 'src-a.txt'), 'a')
    writeFileSync(join(plainDir, 'dst-b.txt'), 'b')
    const out = await renameTreeEntry(plainDir, 'src-a.txt', 'dst-b.txt')
    expect(out).toEqual({ ok: false, reason: 'already-exists' })
  })

  test('an escape on EITHER end is refused', async () => {
    writeFileSync(join(plainDir, 'src-c.txt'), 'c')
    expect(await renameTreeEntry(plainDir, 'src-c.txt', '../out.txt')).toEqual({ ok: false, reason: 'escaped' })
    expect(await renameTreeEntry(plainDir, '../out.txt', 'src-c.txt')).toEqual({ ok: false, reason: 'escaped' })
  })
})

describe('deleteTreeEntry', () => {
  test('deletes a file', async () => {
    writeFileSync(join(plainDir, 'to-delete.txt'), 'x')
    const out = await deleteTreeEntry(plainDir, 'to-delete.txt', false)
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'to-delete.txt'))).toBe(false)
  })

  test('deletes an empty folder without needing recursive', async () => {
    mkdirSync(join(plainDir, 'empty-to-delete'))
    const out = await deleteTreeEntry(plainDir, 'empty-to-delete', false)
    expect(out).toEqual({ ok: true })
  })

  test('refuses a non-empty folder without recursive', async () => {
    mkdirSync(join(plainDir, 'full-to-delete'))
    writeFileSync(join(plainDir, 'full-to-delete', 'inner.txt'), 'x')
    const out = await deleteTreeEntry(plainDir, 'full-to-delete', false)
    expect(out).toEqual({ ok: false, reason: 'not-empty' })
    expect(existsSync(join(plainDir, 'full-to-delete', 'inner.txt'))).toBe(true)
  })

  test('recursive:true deletes a non-empty folder', async () => {
    mkdirSync(join(plainDir, 'full-to-delete-2'))
    writeFileSync(join(plainDir, 'full-to-delete-2', 'inner.txt'), 'x')
    const out = await deleteTreeEntry(plainDir, 'full-to-delete-2', true)
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'full-to-delete-2'))).toBe(false)
  })

  test('refuses when the target does not exist', async () => {
    const out = await deleteTreeEntry(plainDir, 'nope', false)
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })

  test('an escape is refused before any delete is attempted', async () => {
    const out = await deleteTreeEntry(plainDir, '../plain', false)
    expect(out).toEqual({ ok: false, reason: 'escaped' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
```

Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement**

Add `mkdir`, `rename`, `rm` to the `node:fs/promises` import at the top of `editor-fs.ts`, then
append:

```ts
/**
 * A CREATE target has no real path of its own yet — `realContained` alone cannot check it, because
 * `realpath` throws on something that does not exist. So the PARENT is checked instead: it must
 * exist, be a real directory, and be contained in the real root. This is the one place in this
 * module where "does not exist yet" is the SUCCESS case rather than a refusal.
 */
async function realContainedParent(root: string, abs: string): Promise<string | null> {
  const parent = dirname(abs)
  const realParent = await realContained(root, parent)
  if (realParent === null) return null
  // Recompose with the (still unresolved) basename — the child itself is not real yet.
  return `${realParent}/${abs.slice(parent.length + 1)}`
}

export type CreateRefusal = 'escaped' | 'not-found' | 'already-exists'
export type CreatePlan = { ok: true } | { ok: false; reason: CreateRefusal }

export async function createTreeEntry(
  root: string, requestedPath: string, kind: 'file' | 'dir',
): Promise<CreatePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const target = await realContainedParent(root, planned.abs)
  if (target === null) return { ok: false, reason: 'not-found' }

  try {
    await stat(target)
    return { ok: false, reason: 'already-exists' }
  } catch {
    // Good — it must not exist yet.
  }

  if (kind === 'dir') await mkdir(target)
  else await writeFile(target, '', 'utf8')
  return { ok: true }
}

export type RenameRefusal = 'escaped' | 'not-found' | 'already-exists'
export type RenamePlan = { ok: true } | { ok: false; reason: RenameRefusal }

export async function renameTreeEntry(root: string, fromPath: string, toPath: string): Promise<RenamePlan> {
  const from = resolveTreePath(root, fromPath)
  if (!from.ok) return { ok: false, reason: 'escaped' }
  const to = resolveTreePath(root, toPath)
  if (!to.ok) return { ok: false, reason: 'escaped' }

  const realFrom = await realContained(root, from.abs)
  if (realFrom === null) return { ok: false, reason: 'not-found' }

  const realToTarget = await realContainedParent(root, to.abs)
  if (realToTarget === null) return { ok: false, reason: 'escaped' }

  try {
    await stat(realToTarget)
    return { ok: false, reason: 'already-exists' }
  } catch {
    // Good — the destination must be free.
  }

  await rename(realFrom, realToTarget)
  return { ok: true }
}

export type DeleteRefusal = 'escaped' | 'not-found' | 'not-empty'
export type DeletePlan = { ok: true } | { ok: false; reason: DeleteRefusal }

export async function deleteTreeEntry(
  root: string, requestedPath: string, recursive: boolean,
): Promise<DeletePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const real = await realContained(root, planned.abs)
  if (real === null) return { ok: false, reason: 'not-found' }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }

  if (st.isDirectory() && !recursive) {
    const entries = await readdir(real)
    if (entries.length > 0) return { ok: false, reason: 'not-empty' }
  }

  await rm(real, { recursive: true, force: false })
  return { ok: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
bun tsc --noEmit
```

Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-fs.ts packages/server/server/sessions/editor-fs.test.ts
git commit -m "feat(server): criar, renomear e apagar arquivos/pastas no explorador"
```

**Known limitation, stated rather than assumed away (per the spec's own risk list):** a recursive
delete or a rename racing an agent's OWN file creation inside the affected folder is not covered
by any conflict check in this plan — the mtime check in Task 5/8 protects a single file's CONTENT
on save; it says nothing about a directory being removed out from under a write in progress
elsewhere in the tree. Accepted as out of scope for v1, exactly as the spec's risk section frames
it (a narrower edge case than the single-file conflict this feature exists to solve), not silently
designed around. If it becomes a real problem, the fix belongs in a later spec, not a workaround
smuggled into this one.

---

## Task 10: `editor-fs.ts`, part 4 — search

**Files:**
- Modify: `packages/server/server/sessions/editor-fs.ts`
- Modify: `packages/server/server/sessions/editor-fs.test.ts`

**Interfaces:**
- Consumes: `capHits`, `matchNames`, `parseGrepOutput` from `./editor-search`.
- Produces: `searchTree(root: string, q: string): Promise<SearchResult>` (re-exports `SearchResult` from `editor-search`).

- [ ] **Step 1: Write the failing test**

Append to `editor-fs.test.ts`:

```ts
import { searchTree } from './editor-fs'

describe('searchTree', () => {
  test('finds a filename match', async () => {
    const out = await searchTree(gitRepo, 'README')
    expect(out.hits).toContainEqual({ kind: 'name', path: 'README.md' })
  })

  test('finds a content match inside a git repo, and NEVER inside the gitignored file', async () => {
    const out = await searchTree(gitRepo, 'should not appear')
    expect(out.hits.some(h => h.kind === 'content')).toBe(false)
  })

  test('finds a content match in a TRACKED file', async () => {
    const out = await searchTree(gitRepo, 'export const a')
    expect(out.hits).toContainEqual({ kind: 'content', path: 'src/a.ts', line: 1, text: 'export const a = 1' })
  })

  test('finds a content match in an UNTRACKED (but not ignored) file too', async () => {
    const out = await searchTree(gitRepo, 'export const b')
    expect(out.hits).toContainEqual({ kind: 'content', path: 'src/untracked.ts', line: 1, text: 'export const b = 2' })
  })

  test('an empty query returns nothing rather than the whole tree', async () => {
    const out = await searchTree(gitRepo, '  ')
    expect(out.hits).toEqual([])
  })

  test('search works in a non-git directory too, bounded, without hanging', async () => {
    const out = await searchTree(plainDir, 'x')
    expect(out.hits.some(h => h.kind === 'name' && h.path === 'x.txt')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
```

Expected: FAIL — `searchTree` not exported.

- [ ] **Step 3: Implement**

Add the import at the top of `editor-fs.ts`:

```ts
import { capHits, matchNames, parseGrepOutput, type SearchResult } from './editor-search'
```

Append:

```ts
export type { SearchResult }

/**
 * Filename matches always run (fast, no process). Content matches run through `git grep` in a git
 * repo; a NON-git directory gets a bounded plain walk instead — capped by FILE COUNT, not depth,
 * so a huge `node_modules`-shaped folder with no git repo behind it cannot make this hang, which
 * is the exact risk the spec calls out.
 */
export async function searchTree(root: string, q: string): Promise<SearchResult> {
  const query = q.trim()
  if (!query) return { hits: [], truncated: false }

  const files = await gitListRecursive(root, '')
  const nameHits = matchNames(files ?? await walkPlain(root), query)

  const contentHits = files !== null
    ? await gitGrepContent(root, query)
    : await grepPlain(root, query)

  return capHits([...nameHits, ...contentHits])
}

async function gitGrepContent(root: string, query: string) {
  const res = await runGit(root, ['grep', '-n', '--untracked', '-I', '-e', query, '--', '.'])
  // Exit code 1 from `git grep` means "ran fine, found nothing" — not a failure to fall back from.
  if (!res.ok && res.out === '') return []
  return parseGrepOutput(res.out)
}

/** Bounded so a directory with no `.gitignore` to lean on cannot make search feel like it hangs. */
const PLAIN_WALK_FILE_LIMIT = 5000

async function walkPlain(root: string): Promise<string[]> {
  const out: string[] = []
  const stack = ['']
  while (stack.length > 0 && out.length < PLAIN_WALK_FILE_LIMIT) {
    const rel = stack.pop()!
    const abs = rel === '' ? root : `${root}/${rel}`
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) stack.push(childRel)
      else out.push(childRel)
      if (out.length >= PLAIN_WALK_FILE_LIMIT) break
    }
  }
  return out
}

async function grepPlain(root: string, query: string) {
  const files = await walkPlain(root)
  const needle = query.toLowerCase()
  const hits: ReturnType<typeof parseGrepOutput> = []
  for (const rel of files) {
    if (hits.length >= 200) break
    let buf
    try {
      buf = await readFile(`${root}/${rel}`)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) {
        hits.push({ kind: 'content', path: rel, line: i + 1, text: lines[i]! })
      }
    }
  }
  return hits
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-fs.test.ts
bun tsc --noEmit
```

Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-fs.ts packages/server/server/sessions/editor-fs.test.ts
git commit -m "feat(server): busca por nome e conteúdo no explorador, com fallback sem git"
```

---

## Task 11: `editor-web.ts` — the routes

**Files:**
- Create: `packages/server/server/sessions/editor-web.ts`
- Create: `packages/server/server/sessions/editor-web.test.ts`

**Interfaces:**
- Consumes: every `editor-fs.ts` function from Tasks 7–10; `StartHost` from `../cli-start`; `CliLang` from `../cli-lang`.
- Produces: `handleEditorTreeRoute(req: Request, url: URL, host: StartHost, lang: CliLang): Promise<Response | null>`.

**Route table** (all under `/api/fleet/tree*`, all guarded by the `/api/fleet` prefix already in
`capability-guard.ts` plus the `editorAllowed` gate added in Task 12):

| Method | Path | Query / Body | Success | Refusal reasons |
|---|---|---|---|---|
| GET | `/api/fleet/tree` | `id`, `path` | `{ ok: true; children }` | session dir refusals, `escaped`, `not-found`, `not-a-directory` |
| GET | `/api/fleet/tree/search` | `id`, `q` | `{ ok: true; hits; truncated }` | session dir refusals |
| GET | `/api/fleet/tree/file` | `id`, `path` | `{ ok: true; content; mtimeMs }` or `{ ok: true; binary; name; size }` | session dir refusals, `escaped`, `not-found`, `not-a-file` |
| PUT | `/api/fleet/tree/file` | `id`, `path`; body `{ content, mtimeMs }` | `{ ok: true; mtimeMs }` | + `conflict` (carries `content`, `mtimeMs`) |
| POST | `/api/fleet/tree/entry` | body `{ id, path, kind }` | `{ ok: true }` | + `already-exists` |
| PATCH | `/api/fleet/tree/entry` | body `{ id, from, to }` | `{ ok: true }` | + `already-exists` |
| DELETE | `/api/fleet/tree/entry` | `id`, `path`, `recursive` | `{ ok: true }` | + `not-empty` |

Every response also carries a localized `message` alongside `reason` — Phase 2 can render either.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/editor-web.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEditorTreeRoute } from './editor-web'
import type { StartHost } from '../cli-start'

const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_PREFIX
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

let root = ''
let repo = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentistics-editor-web-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
  git(repo, 'add', 'a.ts')
  git(repo, 'commit', '-q', '-m', 'init')
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const hostWith = (id: string, cwd: string): StartHost => ({
  sessions: async () => ({
    sessions: [{ id, conversationId: `${id}-conv`, cwd } as never],
    rows: [], attention: 0, tasks: [],
  }),
})

const noHost: StartHost = {}

async function call(req: Request, host: StartHost) {
  const url = new URL(req.url)
  const res = await handleEditorTreeRoute(req, url, host, 'en')
  expect(res).not.toBeNull()
  return { status: res!.status, body: await res!.json() }
}

describe('handleEditorTreeRoute', () => {
  test('an unknown route under the prefix falls through as null, so index.ts can keep looking', async () => {
    const req = new Request('http://x/api/fleet/tree/not-a-real-subroute')
    const res = await handleEditorTreeRoute(req, new URL(req.url), noHost, 'en')
    expect(res).toBeNull()
  })

  test('GET /api/fleet/tree with an unknown session id refuses with a sentence', async () => {
    const req = new Request('http://x/api/fleet/tree?id=nope&path=')
    const { body } = await call(req, noHost)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('unknown-session')
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })

  test('GET /api/fleet/tree lists the root', async () => {
    const req = new Request('http://x/api/fleet/tree?id=s1&path=')
    const { body } = await call(req, hostWith('s1', repo))
    expect(body).toEqual({ ok: true, children: [{ name: 'a.ts', kind: 'file' }] })
  })

  test('GET /api/fleet/tree/file reads a file', async () => {
    const req = new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts')
    const { body } = await call(req, hostWith('s1', repo))
    expect(body.ok).toBe(true)
    expect(body.content).toBe('export const a = 1\n')
    expect(typeof body.mtimeMs).toBe('number')
  })

  test('PUT /api/fleet/tree/file writes, then a stale write is refused as a conflict', async () => {
    const read = await call(new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts'), hostWith('s1', repo))
    const put1 = await call(new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts', {
      method: 'PUT', body: JSON.stringify({ content: 'export const a = 2\n', mtimeMs: read.body.mtimeMs }),
    }), hostWith('s1', repo))
    expect(put1.body.ok).toBe(true)

    const put2 = await call(new Request('http://x/api/fleet/tree/file?id=s1&path=a.ts', {
      method: 'PUT', body: JSON.stringify({ content: 'export const a = 3\n', mtimeMs: read.body.mtimeMs }),
    }), hostWith('s1', repo))
    expect(put2.status).toBe(409)
    expect(put2.body).toMatchObject({ ok: false, reason: 'conflict', content: 'export const a = 2\n' })
  })

  test('POST /api/fleet/tree/entry creates a file, GET /api/fleet/tree/search finds it by name', async () => {
    const post = await call(new Request('http://x/api/fleet/tree/entry', {
      method: 'POST', body: JSON.stringify({ id: 's1', path: 'brand-new.md', kind: 'file' }),
    }), hostWith('s1', repo))
    expect(post.body).toEqual({ ok: true })

    const search = await call(new Request('http://x/api/fleet/tree/search?id=s1&q=brand-new'), hostWith('s1', repo))
    expect(search.body.hits).toContainEqual({ kind: 'name', path: 'brand-new.md' })
  })

  test('PATCH /api/fleet/tree/entry renames', async () => {
    const patch = await call(new Request('http://x/api/fleet/tree/entry', {
      method: 'PATCH', body: JSON.stringify({ id: 's1', from: 'brand-new.md', to: 'renamed.md' }),
    }), hostWith('s1', repo))
    expect(patch.body).toEqual({ ok: true })
  })

  test('DELETE /api/fleet/tree/entry deletes', async () => {
    const del = await call(new Request('http://x/api/fleet/tree/entry?id=s1&path=renamed.md', {
      method: 'DELETE',
    }), hostWith('s1', repo))
    expect(del.body).toEqual({ ok: true })
  })

  test('a well-formed request with a missing required parameter is a 400, never a 500', async () => {
    const req = new Request('http://x/api/fleet/tree?path=x')
    const { status, body } = await call(req, hostWith('s1', repo))
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/editor-web.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/server/sessions/editor-web.ts
/**
 * editor-web.ts — the routes behind the repository explorer.
 *
 * `capability-guard.ts` has already refused these paths where the exposure profile forbids them
 * (the `/api/fleet` prefix), and `index.ts` applies the user's own `editorEnabled` switch on top
 * before this is ever reached (Task 12). What is left here is resolving the session's directory
 * once per request and turning each `editor-fs.ts` refusal code into a localized sentence — the
 * modules themselves stay language-free, like `shell-web.ts` does for `ShellRefusal`.
 */
import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import {
  createTreeEntry, deleteTreeEntry, listChildren, readTreeFile, renameTreeEntry,
  resolveSessionDirectory, searchTree, writeTreeFile,
} from './editor-fs'
import type { SessionDirRefusal } from './editor-directory'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const DIR_REFUSAL: Record<SessionDirRefusal, { en: string; pt: string }> = {
  'unknown-session': {
    en: 'That session is not in this machine’s list.',
    pt: 'Essa sessão não está na lista desta máquina.',
  },
  'no-cwd': {
    en: 'This session records no folder, so there is nothing to open here.',
    pt: 'Esta sessão não tem uma pasta registrada, então não há o que abrir aqui.',
  },
  'cwd-missing': {
    en: 'This session’s folder no longer exists on disk.',
    pt: 'A pasta desta sessão não existe mais no disco.',
  },
}

const GENERIC_REFUSAL: Record<string, { en: string; pt: string }> = {
  escaped: {
    en: 'That path is outside this session’s folder.',
    pt: 'Esse caminho está fora da pasta desta sessão.',
  },
  'not-found': {
    en: 'That path does not exist.',
    pt: 'Esse caminho não existe.',
  },
  'not-a-directory': {
    en: 'That path is a file, not a folder.',
    pt: 'Esse caminho é um arquivo, não uma pasta.',
  },
  'not-a-file': {
    en: 'That path is a folder, not a file.',
    pt: 'Esse caminho é uma pasta, não um arquivo.',
  },
  'already-exists': {
    en: 'Something is already there.',
    pt: 'Já existe algo nesse caminho.',
  },
  'not-empty': {
    en: 'That folder is not empty. Delete it recursively to remove everything inside it.',
    pt: 'Essa pasta não está vazia. Apague recursivamente para remover tudo dentro dela.',
  },
  conflict: {
    en: 'This file changed on disk since it was opened. Review the current version before saving over it.',
    pt: 'Este arquivo mudou no disco desde que foi aberto. Revise a versão atual antes de salvar sobre ela.',
  },
}

function sentence(reason: string, lang: CliLang): string {
  const dir = DIR_REFUSAL[reason as SessionDirRefusal]
  if (dir) return dir[lang]
  const generic = GENERIC_REFUSAL[reason]
  return generic ? generic[lang] : reason
}

/** `null` when the path is not ours, so `index.ts` falls through to its next route. */
export async function handleEditorTreeRoute(
  req: Request, url: URL, host: StartHost, lang: CliLang,
): Promise<Response | null> {
  const { pathname } = url

  if (pathname === '/api/fleet/tree' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    if (!id) return json({ ok: false, reason: 'bad_request', message: 'id is required' }, 400)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const listed = await listChildren(dir.dir, url.searchParams.get('path') ?? '')
    if (!listed.ok) return json({ ok: false, reason: listed.reason, message: sentence(listed.reason, lang) }, 404)
    return json({ ok: true, children: listed.children })
  }

  if (pathname === '/api/fleet/tree/search' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    if (!id) return json({ ok: false, reason: 'bad_request', message: 'id is required' }, 400)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const result = await searchTree(dir.dir, url.searchParams.get('q') ?? '')
    return json({ ok: true, ...result })
  }

  if (pathname === '/api/fleet/tree/file' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    const path = url.searchParams.get('path')
    if (!id || path === null) return json({ ok: false, reason: 'bad_request', message: 'id and path are required' }, 400)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const file = await readTreeFile(dir.dir, path)
    if (!file.ok) return json({ ok: false, reason: file.reason, message: sentence(file.reason, lang) }, 404)
    return json(file)
  }

  if (pathname === '/api/fleet/tree/file' && req.method === 'PUT') {
    const id = url.searchParams.get('id')
    const path = url.searchParams.get('path')
    if (!id || path === null) return json({ ok: false, reason: 'bad_request', message: 'id and path are required' }, 400)
    const body = await req.json().catch(() => null) as { content?: string; mtimeMs?: number } | null
    if (!body || typeof body.content !== 'string' || typeof body.mtimeMs !== 'number') {
      return json({ ok: false, reason: 'bad_request', message: 'content and mtimeMs are required' }, 400)
    }
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const out = await writeTreeFile(dir.dir, path, body.content, body.mtimeMs)
    if (!out.ok) {
      const status = out.reason === 'conflict' ? 409 : 404
      return json({ ok: false, ...out, message: sentence(out.reason, lang) }, status)
    }
    return json(out)
  }

  if (pathname === '/api/fleet/tree/entry' && req.method === 'POST') {
    const body = await req.json().catch(() => null) as { id?: string; path?: string; kind?: string } | null
    if (!body?.id || !body.path || (body.kind !== 'file' && body.kind !== 'dir')) {
      return json({ ok: false, reason: 'bad_request', message: 'id, path and kind are required' }, 400)
    }
    const dir = await resolveSessionDirectory(host, body.id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const out = await createTreeEntry(dir.dir, body.path, body.kind)
    if (!out.ok) return json({ ok: false, reason: out.reason, message: sentence(out.reason, lang) }, 409)
    return json(out)
  }

  if (pathname === '/api/fleet/tree/entry' && req.method === 'PATCH') {
    const body = await req.json().catch(() => null) as { id?: string; from?: string; to?: string } | null
    if (!body?.id || !body.from || !body.to) {
      return json({ ok: false, reason: 'bad_request', message: 'id, from and to are required' }, 400)
    }
    const dir = await resolveSessionDirectory(host, body.id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const out = await renameTreeEntry(dir.dir, body.from, body.to)
    if (!out.ok) return json({ ok: false, reason: out.reason, message: sentence(out.reason, lang) }, 409)
    return json(out)
  }

  if (pathname === '/api/fleet/tree/entry' && req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    const path = url.searchParams.get('path')
    if (!id || path === null) return json({ ok: false, reason: 'bad_request', message: 'id and path are required' }, 400)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const recursive = url.searchParams.get('recursive') === '1'
    const out = await deleteTreeEntry(dir.dir, path, recursive)
    if (!out.ok) return json({ ok: false, reason: out.reason, message: sentence(out.reason, lang) }, 409)
    return json(out)
  }

  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/editor-web.test.ts
bun tsc --noEmit
```

Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/editor-web.ts packages/server/server/sessions/editor-web.test.ts
git commit -m "feat(server): rotas do explorador de repositório (/api/fleet/tree*)"
```

---

## Task 12: Wire the routes into `index.ts`, and confirm the capability guard

**Files:**
- Modify: `packages/server/server/index.ts`
- Modify: `packages/server/server/sessions/editor-gate.test.ts`

**Interfaces:**
- Consumes: `editorAllowed` from `./sessions/editor-gate`; `handleEditorTreeRoute` from `./sessions/editor-web`; `readPreferences` (already imported in `index.ts`); `routeCapability` from `../capability-guard`.

- [ ] **Step 1: Write the failing test**

Append to `editor-gate.test.ts`:

```ts
import { routeCapability } from '../capability-guard'

describe('the /api/fleet/tree routes ride the existing /api/fleet prefix', () => {
  test('every route this feature defines is guarded', () => {
    expect(routeCapability('/api/fleet/tree')).toBe('localShell')
    expect(routeCapability('/api/fleet/tree/search')).toBe('localShell')
    expect(routeCapability('/api/fleet/tree/file')).toBe('localShell')
    expect(routeCapability('/api/fleet/tree/entry')).toBe('localShell')
  })
  test('and so is a fleet-tree route that does not exist yet — the PREFIX is what guards it', () => {
    expect(routeCapability('/api/fleet/tree/whatever-comes-next')).toBe('localShell')
  })
})
```

- [ ] **Step 2: Run it and confirm it ALREADY passes**

```bash
bun test packages/server/server/sessions/editor-gate.test.ts
```

Expected: PASS immediately — `capability-guard.ts` needs no change, because the `/api/fleet`
prefix registered there already covers `/api/fleet/tree*`. This step exists to make that fact a
test rather than an assumption, per the spec: "Every route in `capability-guard.ts` rides the
existing `/api/fleet` prefix registration; nothing new to add there beyond the routes themselves."

- [ ] **Step 3: Wire the gate and the dispatcher into `index.ts`**

Add the import near the other `sessions/*-gate` imports (next to `import { shellAllowed } from
'./sessions/shell-gate'`, around line 61):

```ts
import { editorAllowed } from './sessions/editor-gate'
```

Add the gate + dispatch block in the big request handler, immediately after the existing
`/api/fleet` TEAM_CENTRAL block (around line 1549, right after its closing `}`):

```ts
    // THE REPOSITORY EXPLORER. Same shape as the utility shell's own gate a few lines up: two
    // gates, enforced HERE and not only in the UI, because these routes read and write arbitrary
    // files on the host — a hidden tab is not a closed door.
    if (url.pathname === '/api/fleet/tree' || url.pathname.startsWith('/api/fleet/tree/')) {
      if (!editorAllowed(CAPS.localShell, (await readPreferences()).editorEnabled)) {
        return new Response(JSON.stringify({ error: 'editor_disabled' }), {
          status: 403,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
      const { handleEditorTreeRoute } = await import('./sessions/editor-web')
      const { hostForFleet, fleetLang } = await import('./sessions/fleet-web')
      const editorLang = fleetLang(url.searchParams.get('lang'))
      const res = await handleEditorTreeRoute(req, url, await hostForFleet(editorLang), editorLang)
      if (res) {
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
        return res
      }
    }
```

- [ ] **Step 4: Run the full suite**

```bash
bun test
bun tsc --noEmit
```

Expected: every test passes (the full suite, not just this feature's files — this is what the
pre-commit hook runs), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/index.ts packages/server/server/sessions/editor-gate.test.ts
git commit -m "feat(server): liga as rotas do explorador de repositório no index.ts"
```

---

## Task 13: Manual `curl` verification against a running dev server

No browser automation for this phase — there is no UI yet. This task is not a code change; it is
the check that everything wired above actually behaves through the real HTTP server, not only
through direct function calls in tests.

- [ ] **Step 1: Start the dev server**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/repo-explorer
bun run dev
```

Leave it running in the background; use a second terminal (or `run_in_background` +
`curl`) for the rest of this task. Note the machine's actual API port from the startup log
(default `47291`).

- [ ] **Step 2: Confirm the gate refuses while `editorEnabled` is unset**

```bash
curl -s http://localhost:47291/api/fleet/tree?id=x&path= | head -c 300
```

Expected: `{"error":"editor_disabled"}` with a `403` (check with `-i` if the body alone is
ambiguous). `editorEnabled` is absent from a fresh `~/.agentistics/preferences.json`, so this must
refuse — the same "absent reads as OFF" rule `shellEnabled` follows.

- [ ] **Step 3: Turn the preference on and confirm the gate opens**

```bash
curl -s -X PUT http://localhost:47291/api/preferences \
  -H 'Content-Type: application/json' \
  -d '{"editorEnabled": true}'
curl -s -i http://localhost:47291/api/fleet/tree?id=nonexistent&path= | head -20
```

Expected: no longer `403`. Instead a `404` with `{"ok":false,"reason":"unknown-session",...}` —
the gate is open, and this specific session id does not resolve to anything.

- [ ] **Step 4: Exercise every route against this checkout itself**

Find a real, currently-running session id from `agentop session ls` or the `/api/fleet` payload,
or use this very worktree's own directory as a manual test by temporarily pointing at a session
you control. At minimum, verify:

```bash
# List the worktree's own root (substitute a real session id):
curl -s "http://localhost:47291/api/fleet/tree?id=<id>&path=" | head -c 500

# List a subdirectory:
curl -s "http://localhost:47291/api/fleet/tree?id=<id>&path=packages/server/server/sessions" | head -c 500

# Search by filename:
curl -s "http://localhost:47291/api/fleet/tree/search?id=<id>&q=editor-gate" | head -c 500

# Search by content:
curl -s "http://localhost:47291/api/fleet/tree/search?id=<id>&q=editorAllowed" | head -c 500

# Read a file (note the returned mtimeMs for the next step):
curl -s "http://localhost:47291/api/fleet/tree/file?id=<id>&path=packages/server/server/sessions/editor-gate.ts" | head -c 300

# Attempt a .. escape — must be refused:
curl -s -i "http://localhost:47291/api/fleet/tree?id=<id>&path=../../etc" | head -20
```

Expected: every call returns a well-formed JSON body, the escape attempt is refused with a `404`
and `reason":"escaped"`, and nothing in `~/.agentistics` or outside the tested directory is ever
touched by a read-only call.

- [ ] **Step 5: Exercise create / write-with-conflict / rename / delete in a throwaway subdirectory**

Do this against a scratch directory inside a session you control (e.g. this worktree's own
`/tmp`-adjacent scratch, or create a temp subfolder under the worktree and remove it afterward) —
never against a file this plan or another session actually needs.

```bash
# Create:
curl -s -X POST http://localhost:47291/api/fleet/tree/entry \
  -H 'Content-Type: application/json' \
  -d '{"id":"<id>","path":"scratch-verify.txt","kind":"file"}'

# Read it back to get its mtimeMs, then write with that mtimeMs (should succeed):
curl -s "http://localhost:47291/api/fleet/tree/file?id=<id>&path=scratch-verify.txt"
curl -s -i -X PUT "http://localhost:47291/api/fleet/tree/file?id=<id>&path=scratch-verify.txt" \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello\n","mtimeMs": <the mtimeMs just read>}'

# Write again with a STALE mtimeMs — must be 409 with the current content attached:
curl -s -i -X PUT "http://localhost:47291/api/fleet/tree/file?id=<id>&path=scratch-verify.txt" \
  -H 'Content-Type: application/json' \
  -d '{"content":"stale write\n","mtimeMs": 0}'

# Rename:
curl -s -X PATCH http://localhost:47291/api/fleet/tree/entry \
  -H 'Content-Type: application/json' \
  -d '{"id":"<id>","from":"scratch-verify.txt","to":"scratch-verify-renamed.txt"}'

# Delete:
curl -s -X DELETE "http://localhost:47291/api/fleet/tree/entry?id=<id>&path=scratch-verify-renamed.txt"

# Confirm it is gone:
curl -s "http://localhost:47291/api/fleet/tree?id=<id>&path=" | grep scratch-verify || echo "gone, as expected"
```

Expected: create succeeds, the first write succeeds, the stale write is refused with `409` and the
CURRENT content in the body (never the stale content the caller tried to write), rename succeeds,
delete succeeds, and the final listing shows nothing left behind.

- [ ] **Step 6: Restore the preference and report**

```bash
curl -s -X PUT http://localhost:47291/api/preferences \
  -H 'Content-Type: application/json' \
  -d '{"editorEnabled": false}'
```

Turning it back off is a courtesy for whoever's dev server this is running against next, not a
requirement of the feature — leave it on if this machine is meant to keep testing Phase 2 against
it.

Report the outcome of every step above (pass/fail, with the exact response bodies for anything
unexpected) before this phase is considered done.

---

## Self-Review Checklist (for whoever executes this plan)

Before moving to Phase 2:
- [ ] Every route in the table under Task 11 has been exercised by an automated test AND by `curl` in Task 13.
- [ ] `bun test` (full suite) and `bun tsc --noEmit` are clean on the final commit of this phase.
- [ ] `editorEnabled` absent → every `/api/fleet/tree*` call is refused with `editor_disabled`, verified live (Task 13, Step 2).
- [ ] A `..` escape and a from-inside symlink escape are both refused, verified by both the unit tests (Task 7) and `curl` (Task 13, Step 4).
- [ ] A stale-mtime write never touches the file on disk, verified by both the unit test (Task 8) and `curl` (Task 13, Step 5).
- [ ] No change was made to `capability-guard.ts`, `exposure.ts`, or any frontend file.
