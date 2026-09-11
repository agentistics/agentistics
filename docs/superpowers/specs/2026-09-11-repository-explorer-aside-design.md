# Repository explorer — a VS Code-style file tree + Monaco editor in the aside

Task: t-9a15db678d — "repositório disponivel no aside da direita".

## Problem

The right aside (`ArtifactsAside.tsx`) shows what a session's *conversation* touched (the Files
tab, sourced from the transcript) but there is no way to browse the session's actual working
directory on disk — the whole tree, including files the conversation never mentioned — let alone
open, edit and save one. The request is explicitly "like the view that exists in VS Code": a real
file explorer plus a real code editor (Monaco), not another read-only viewer.

This is a materially different capability from every other aside tab: every existing reader
(Files, PRs, MCPs, Skills…) either reads a fixed allowlist (files the transcript names) or shells
out for a read-only answer (`gh pr list`). This feature reads *and writes* arbitrary files inside
the session's directory tree, which puts it in the same power class as the per-session utility
shell (`shell-gate.ts`) — the most powerful thing this server does today — and it must be gated
the same way.

## What this covers (v1)

A new **Repositório / Repository** tab in `ArtifactsAside`:

1. A lazy, `.gitignore`-aware directory tree rooted at the session's own working directory.
2. Full-text + filename search across that tree.
3. Opening a file in a Monaco editor, with **multiple tabs** open at once.
4. Saving (Ctrl+S) and an opt-in autosave (**off by default**).
5. Create / rename / delete for files and folders.
6. Conflict detection on save: if the file changed on disk since it was opened (most likely
   because an agent — this session's own, or another one in the same directory — wrote to it),
   the save is refused rather than silently overwriting, and the person is asked. The agent's
   work is never clobbered without an explicit choice.
7. A live indicator that this session's own agent is actively working, reusing the same signal
   the Live tab and the terminal already have — no new polling loop.
8. Works for both **live and closed/historical** sessions, using the same directory-resolution
   order the git-stats code already established ("read where it worked, not where it is filed").

Deferred, explicitly out of v1 (the user asked for these to be named rather than silently
dropped, so they are recorded here as follow-up work, not forgotten):

- **Monaco language services / linting** (TypeScript/JS type-checking, inline diagnostics). This
  is the heaviest and riskiest piece technically (language-service workers, memory) and was
  explicitly deferred.
- Central/relay access — this tab is a **local-machine-only** capability, exactly like the
  per-session shell. A central never gets filesystem access to a member's machine through it.
  Extending it to the machine-relay verbs (`machineActions.ts`) is a separate, later decision.

## Out of scope entirely (not follow-up, just not this feature)

- Replacing the existing Files tab's lightweight, hand-rolled highlighter (`codeHighlight.ts`)
  with Monaco. That component's whole reason for existing — a read-only viewer with no grammar
  engine to fight for colours — still holds; Monaco is scoped to this new, editable tab only.
- Git status/diff/stage/commit (the "Source Control" view). The user's actual ask, confirmed in
  brainstorming, is the Explorer + editor, not a git client. If wanted later, it is a separate
  spec.
- Any change to how the Files/Docs/Live/etc. tabs resolve their data.

## Directory resolution — works for live and closed sessions alike

New function, `resolveSessionDirectory(lang, id)` in `fleet-web.ts`, used by every route below:

1. If the id is a **live** managed/external row (`host.sessions()`), use `row.cwd` — the same
   source `readFleetPullRequests` / `readFleetArtifact` already use.
2. Otherwise fall back to the **store**: `SessionMeta.current_cwd`, then `project_path`, in that
   order — the same order `sessionGitPaths` (`git.ts`) already established for git stats, for the
   same reason ("a session's own last directory, project as the fallback"). Each candidate is
   checked with a `stat` and the first that exists and is a directory wins.
3. If neither resolves to a directory that exists on disk right now, the tab reports that in a
   sentence instead of rendering an empty tree — the same N/A-vs-confident-empty-list rule every
   other tab in this file already follows.

This is a genuinely new data path for this aside: every other tab that reads `cwd` today only
works while the session is live. Recording it here explicitly because it is the one piece of this
feature that changes an existing assumption rather than adding beside it.

## Security gating — a new capability, gated like the shell

Filesystem read+write+create+delete over an arbitrary subtree is at least as powerful as the
per-session shell (arguably more directly dangerous, since it needs no command execution at all
to do damage). It gets the **same two-gate model** `shell-gate.ts` already established, not a
weaker one:

- `CAPS.localShell` (from `exposure.ts`) — available only on the `local` profile. Never `lan`,
  never `public`, never on a central (which has no filesystem access to a member's machine to
  begin with).
- A **new**, separate preference switch, `preferences.editorEnabled` — absent reads as **off**,
  same rule as `shellEnabled`. Deliberately its own switch and not reusing `shellEnabled`: a
  person may want a read/write shell without a file editor, or vice versa, and folding two
  distinct grants into one switch is exactly the trap `chat-gate.ts`'s header warns about.

Enforced in `index.ts` **before** the route handlers, not only hidden in the UI — same rule as
every other host-touching capability in this codebase. The tab itself is **absent** (not a
disabled button) when the gate is closed, matching how the Services screen treats an offer that
cannot work here.

Every route in `capability-guard.ts` rides the existing `/api/fleet` prefix registration; nothing
new to add there beyond the routes themselves.

**Path containment is enforced on every single request.** A requested relative path is resolved
against the session directory (`path.resolve(root, requested)`) and refused unless the result is
still inside `root` — blocking `..` traversal and symlinks that point outside the tree. There is
no route that accepts an absolute path from the client. This is the same posture
`resolveArtifactPath` already takes for the Files tab's allowlist, applied here to the whole
subtree instead of a named list.

## Backend routes (new, under `/api/fleet`)

- `GET /api/fleet/tree?id=&path=` — lists the immediate children of `path` (root = `''`). Uses
  `git ls-files` semantics (tracked + `--others --exclude-standard` for untracked-but-not-ignored,
  mirroring `listUntracked` in `repo-probe.ts`) when the directory is a git repository; a plain
  `readdir` when it is not. Lazy: one directory per call, never a recursive dump.
- `GET /api/fleet/tree/search?id=&q=` — filename matches against the same gitignore-aware file
  set, plus content matches via `git grep -n --untracked -I` (git repos) or a capped plain walk
  (non-git directories). Results are capped (mirrors `PR_LIMIT`'s pattern) and the response says
  when it is a partial window ("first N of more").
- `GET /api/fleet/tree/file?id=&path=` — file content plus its `mtimeMs`, which the client holds
  onto for the conflict check. Binary files are reported as such (name + size), not sent as text.
- `PUT /api/fleet/tree/file?id=&path=` — body carries the new content and the `mtimeMs` the client
  last saw. If the file's current `mtimeMs` on disk differs, the write is refused with `409` and
  the current content, rather than applied — see Conflict handling below. On success, returns the
  new `mtimeMs` so the client's next save is checked against it.
- `POST /api/fleet/tree/entry` — create a file or folder at a path.
- `PATCH /api/fleet/tree/entry` — rename/move (old path → new path, still containment-checked on
  both ends).
- `DELETE /api/fleet/tree/entry?id=&path=` — delete a file or an empty-or-not folder (recursive
  delete requires the same explicit confirmation the UI already asks for before the request is
  even sent).

All of them 404/403 with a stated reason when the gate is closed, the session cannot be resolved
to a directory, or the path fails containment — never a silent empty response.

## Conflict handling — the agent's work always wins the silent case

The rule the user set explicitly: a save must **never** silently clobber a change an agent made
on disk while the file was open in the editor. Mechanism:

1. Reading a file records its `mtimeMs`.
2. Saving sends that `mtimeMs` back. The server compares it to the file's current `mtimeMs` right
   before writing.
3. If they match, the write proceeds normally.
4. If they don't, the server refuses (`409`) and returns the on-disk content. The client shows a
   conflict prompt: keep editing and re-save over the new version (explicit, informed choice), or
   discard the local edit and reload what's on disk. **Nothing is written automatically in this
   case** — the "agent's work wins" rule is enforced by never auto-applying the person's version
   over a change that appeared after they started editing, not by picking a winner in code.

This is a plain mtime check, not a content hash — cheap on every save, and sufficient: the only
thing that matters is "did something else touch this file since I read it", not what changed.

## Live-agent indicator — reuses what the Live tab already has

No new polling. `ArtifactsAside` already receives `turns` (this session's live feed) and can be
given the session's `state` the way `SessionsPage` already tracks it for the row. Two signals,
both already available:

- A general **"agent working"** badge on the Repository tab (and inside the editor once open)
  whenever the session's own state is `working` — same `RunningDot` component every other tab in
  this file already uses for "something is live behind this tab".
- A **stronger, specific** highlight when the most recent live event (`liveEvents(turns)`, same
  feed the Live tab draws) is an edit/write whose path matches the file currently open — "the
  agent is editing this file right now", not just "the agent is doing something".

This only ever describes **this session's own** agent. Detecting a *different* session editing
the same directory is a real scenario (this product's whole "concurrent work" section documents
it) but needs cross-session directory matching that does not exist yet for this purpose — noted
as a natural follow-up, not silently promised here.

## Frontend

**Tab.** `Repositório` / `Repository`, its own icon (e.g. `FolderTree`), placed in the existing
tab bar / overflow grid exactly like every other tab — no special-casing in `splitAsideTabs`.

**Tree.** Virtualized list (windowed rendering) so a large, gitignore-filtered tree does not cost
a heavy DOM. Expand-on-click, one `GET /api/fleet/tree` call per opened folder — never the whole
tree at once. A search box above it switches the list to flattened search results (debounced
~250ms), with a clear way back to the tree view.

**Editor.** Monaco, loaded via a dynamic `import()` the first time the tab is opened — not in the
main bundle. Self-hosted (no CDN), and only the language worker for the file type actually opened
is loaded (ts/json/css/html/md/…), not the full set up front. Opening a file **replaces the tree
with the editor**, same layers-not-split pattern this file's own header already documents for the
Files tab ("a list and a document sharing 440px would give the document less room than the
conversation it was opened from") — an open-tabs strip sits above the editor and a back control
returns to the tree, on both desktop and mobile. One rule for both widths, no separate desktop
split-view to build, test and keep in sync.

**Multiple tabs.** Each open file gets a Monaco text model, cached for the life of the panel
session so switching between open tabs is instant with no refetch; a tab's model is disposed when
its tab is closed, to avoid unbounded memory growth over a long session with many files opened.
Unsaved changes are marked on the tab (dot/asterisk) and a close on a dirty tab asks for
confirmation, same spirit as the delete confirmation.

**Save.** Ctrl+S triggers `PUT`. A preference (own toggle, not tied to `editorEnabled`) turns on
autosave — debounced ~1–2s after the last keystroke — **off by default**, per the explicit
decision that autosave adds no real performance cost but does raise the collision window with an
agent, so a person opts in deliberately.

**Create/rename/delete.** Context menu on tree rows and a toolbar action for "new file"/"new
folder" at the current selection. Delete always goes through `ConfirmModal` (already used
elsewhere in this file) before the request is sent — no fire-and-forget deletes.

**Mobile.** The aside already goes near-full-width on a phone; the tree takes the full panel and
opening a file swaps it for the editor (back button returns to the tree) — same "layers, not
split" pattern the top-of-file doc comment already states for the Files tab. Monaco's own
touch/virtual-keyboard behavior is the main open risk here and needs hands-on verification during
implementation, not just a layout check — recorded as a required verification step in the plan.

## Testing

- Pure logic gets unit tests as usual in this codebase: `resolveSessionDirectory`'s directory
  fallback order, the containment check, the gitignore-aware listing decision, the conflict
  mtime comparison, the search result capping/pagination.
- The gate (`editorEnabled` absent → off, wrong profile → off, both on → routes reachable) gets
  the same kind of test `shell-isolation.test.ts` runs for the shell, asserting the module's own
  source never imports the live-fleet resolver in a way that would leak scope.
- End-to-end verification (open a real session, browse, edit, save, hit a conflict, hit mobile
  width) happens by hand against the running app before this is called done, same as every UI
  change in this repo — this is not something unit tests alone can certify.

## Risks / things the plan needs to solve carefully

- **Monaco bundle size and worker setup under Vite** — needs a concrete build-time approach
  (self-hosted workers, not CDN, consistent with this product's CDN-avoidance elsewhere) decided
  during planning, not improvised during implementation.
- **Recursive delete and rename on a directory an agent is mid-write to** — the mtime conflict
  check covers single-file writes; a rename/delete racing an agent's own file creation inside a
  folder being deleted is a narrower edge case the plan should call out explicitly rather than
  assume away.
- **Search performance on very large non-git directories** (no `.gitignore` to lean on) — the
  capped plain walk needs a real time/file-count bound, or a huge `node_modules`-shaped folder
  with no git repo behind it could make search feel like it hangs, which directly contradicts the
  "nothing should freeze" requirement this spec is built around.
