# Agentistics Studio — slots, references, rendered documents, tree operations

Status: approved for implementation by the coordinator session, 2026-09-12. Branch base:
`feat/repo-explorer-aside` (the PR #544 stack). Commit messages in ENGLISH.

This batch answers one user message (quoted, abridged) plus the still-open Filtros request:

> drag folders and files into each other · drag a file into the input to reference it · select a
> stretch of code and get a "mention" option · see markdown rendered (docker, mermaid, the standard
> files of our niche) · the Studio opens together with the aside content — they are different
> components · when the Studio is open its button is ORANGE, without the beta/new marks inside it,
> "only better" · open the Studio at the BOTTOM too (the terminal band), but in ONE place at a time ·
> open Claude Code and Shell in the RIGHT component · the extension icon on the open tabs ·
> (earlier) a collapsible "Filtros" bar like the Stats one, taking the filters out of the header.

Every section is a self-contained work package with its own file ownership (§8). Each package ends
with the verification it owes — measured, not assumed — and the repo's mobile rule applies to all of
them: a package is not done until its 390px branch is built and checked.

---

## 1. Panels and slots (the architecture everything else hangs off)

### 1.1 The defect it fixes

The Studio is today a MODE of `ArtifactsAside` (`studio` state, `Layer` over the aside's chrome,
`openArtifacts('studio')`). So opening it opens the session-contents panel: the header's contents
button lights up beside the Studio button, and the Studio's bar carries "‹ Conteúdo", a way back
into a panel the user never opened. Two components, one open state.

### 1.2 The model

- **Panels:** `contents` (today's ArtifactsAside), `studio`, `cli` (the session's own assistant
  pane — "Claude Code", named after the harness), `shell` (the per-session utility shell).
- **Slots:** `right` (today's aside box: split / overlay / fullscreen) and `bottom` (today's docked
  band under the composer, `ShellBand placement="docked"`).
- **What each slot may host:** `right` ⊇ {contents, studio, cli, shell}; `bottom` ⊇ {cli, shell,
  studio}. `contents` never goes to the bottom (not asked for; a tabbed list does not fit a band).
- **One place at a time:** a panel is in at most ONE slot. Opening panel P in slot S when P is in the
  other slot MOVES it (the other slot falls back to its previous occupant, or closes). A slot shows
  one panel; opening P where Q is displaces Q (Q closes — see 1.4 for the Studio's buffers).
- The pure reducer lives in `packages/web/src/lib/panelSlots.ts`:
  `type PanelId`, `type SlotId`, `interface SlotLayout { right: PanelId | null; bottom: PanelId | null;
  bottomOpen: boolean; lastSlot: Record<PanelId, SlotId> }`, `openPanel(layout, panel, slot?)`,
  `closePanel(layout, panel)`, `movePanel(layout, panel, to)`, `allowed(slot, panel)`,
  `resolveForViewport(layout, isMobile)`. Tested exhaustively (every panel × slot × occupant).
  `openPanel` with no slot uses `lastSlot[panel]` (defaults: contents/studio → right, cli/shell →
  bottom). An illegal placement is REFUSED (returns the layout unchanged), never coerced.
- **Center views are not slots.** The chat/terminal toggle in the centre stays. The same pane shown
  in the centre and in a slot is two viewers of one stream (the server hub already shares one
  capture loop per pane); that is allowed and is not a violation of "one place".
- **Persistence:** the LAYOUT (which panel sits in which slot, `lastSlot`, bottom open/height) is a
  per-browser preference in `localStorage` (guarded read/write, like `boardPrefs.ts` /
  `readBandPrefs`), never `/api/preferences` (shared by everyone on a central). The panels' CONTENT
  is per session: switching session keeps the layout and mounts that session's Studio / shell in
  the same slots.
- The existing `artifactsStore` (`openArtifacts(tab, ref)`) keeps working for `contents` tab
  requests (note chips, edge strip). Every `openArtifacts('studio')` caller moves to
  `openPanel('studio')`. `ArtifactsAside` loses `studio` state, the strip entry and the `Layer`.

### 1.3 Controls

- **Right slot header:** a compact switcher naming what it can host (`Conteúdo · Studio · Claude
  Code · Shell`, icons + labels, absent entries when a gate is closed — never greyed), plus a
  "move to bottom" icon button for studio/cli/shell and close.
- **Bottom band header:** today's `Claude Code | Shell` segment gains `Studio` (only when
  `editorEnabled`), plus "move to right" and the existing collapse.
- **Header Studio button** (App.tsx): toggles the Studio in `lastSlot.studio`. See §2.
- **Header contents button:** toggles `contents` only. After this change opening one never lights
  the other — pinned by a test on the store and verified in the browser.
- Keyboard: every switcher is a real `role="tablist"`; move/close are buttons with names.

### 1.4 The Studio must survive a MOVE (load-bearing)

Unsaved Monaco buffers exist only in the Studio's DOM (see `Layer`, `mountedEditors`,
`UnsavedChangesGuard`). React re-parenting unmounts. So the Studio is rendered ONCE per session into
a persistent host element through `createPortal`, and the slot that shows it `appendChild`s that
host into its own box (a `StudioHost` ref callback). Moving right↔bottom moves the DOM node; the React
tree, the models and the undo stacks stay. Monaco's `automaticLayout` re-measures on the resize.
Rules inherited unchanged: hide with `Layer` (opacity 0 + inert + pointer-events none), NEVER
`visibility`, `display:none` or `content-visibility`.

- Displacing or closing the Studio with dirty buffers ASKS through `unsavedBuffers.ts`, exactly as
  closing the aside does today. A move never asks (nothing is dropped).
- **Verification owed (Playwright, 1440×900 and 1024×768):** open two files, type in one without
  saving, move right→bottom→right→bottom; after each move assert the typed text is still in the
  model, `monaco.editor.getModels().length` unchanged, no second `GET /api/fleet/tree` for the root,
  and the undo stack still undoes the typing. Plant a re-parenting render (drop the portal) and show
  the test fail.

### 1.5 cli and shell in the right slot

- `cli` in the right slot is `TerminalRegion` (placement: a new `'aside'` value in
  `lib/terminalSurface.ts`, with the same consent rules as `replacing`: focus is consent, phone gets
  the key strip).
- `shell` in the right slot is `ShellBand` with a new `placement="aside"`: no drag handle, no
  collapsed state (the slot's close is the way out), own geometry key in `shellBand.ts`. The shell
  resolve/ceiling logic is untouched — it is the entire reason placement is a prop.
- The capture/unwatch discipline holds: a pane in a hidden or closed slot is NOT watched
  (`shellWatching` input gains "slot shows it").

### 1.6 Mobile (< 768px)

A phone has no bottom slot for the Studio and no side-by-side. `resolveForViewport` maps any stored
`bottom: 'studio'` to the fullscreen right sheet WITHOUT rewriting storage (turning the phone back
to a desktop restores the user's layout). The "move to bottom" control is ABSENT on mobile. `cli` /
`shell` in the right slot on a phone open as today's dedicated fullscreen pane. The session menu row
"Studio" loses its `novo` badge (§2). 44px targets on every new control.

---

## 2. The Studio button (App.tsx + the mobile session menu)

- Content: `FolderTree` icon + "Studio". The `BetaTag` and `NewTag` leave the button.
- **State = the Studio is on screen in ANY slot.** On: orange outline + orange text + a faint orange
  fill — the exact treatment of the "Reabrir N sessões que caíram" button
  (`1px solid var(--anthropic-orange)`, `rgba(232,105,11,0.10)`, text orange), with
  `aria-pressed`. Off: the neutral style it has now.
- "Better": the beta caveat moves into the `title` tooltip ("Agentistics Studio (beta) — …") and
  stays on the Studio's own bar where it already is; the "new" statement becomes a small orange dot
  on the icon's corner that disappears for good after the first open (guarded `localStorage` key
  `agentistics.studio.seen`). A dot, not a word, so the button reads the same width in both states.
- The mobile menu row: no `badge`; `on: studioOpen`.
- The Studio bar's "‹ Conteúdo" back link is REMOVED (it is the visible half of the §1.1 defect);
  the bar keeps close and the slot controls.
- Test: the button's pressed state follows the slot layout; the dot clears on first open and
  survives a throwing `localStorage`.

## 3. Extension icons on the open tabs

`TabStrip` (Studio.tsx ~1410) renders the same `fileIcon` glyph+hue the tree uses, before the name,
at 14px, with the hue contrast rules already in `fileIcon.tsx` applied against the TAB's ground
(active and inactive grounds differ — compute both, reuse `readable()`). Dirty marker and close
button unchanged; the tab's measured width grows by the icon, so the overflow split must be
re-verified at 390px and 1440px (`scrollWidth <= innerWidth`).

---

## 4. Rendered documents (markdown, mermaid, niche files)

- **Toggle:** a `Código | Visualizar` segmented control on the editor bar for renderable files;
  default is the CODE view (the Studio is an editor), remembered per extension in `localStorage`.
  The preview re-renders from the live MODEL value (unsaved edits show), debounced 250ms.
- **Markdown** (`.md .mdx .markdown`, plus `README`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md`,
  `CHANGELOG`): `react-markdown` + `remark-gfm` (already dependencies). **No `rehype-raw`** — a
  repository file is untrusted input and raw HTML stays text. YAML frontmatter (`---` block, common
  in SKILL.md / docs) renders as a two-column key/value table above the body, parsed with a small
  pure reader (no new yaml dependency; unparseable frontmatter is shown as a code block, never
  dropped).
  - Relative images (`![](./img.png)`) resolve through the existing `GET /api/fleet/tree/media`
    route relative to the document's directory, with the same containment. **Remote images are NOT
    fetched** (a README must not be able to ping a tracker from the user's dashboard): they render
    as a link with the alt text. Relative links to other repo files open that file in the Studio;
    external links open in a new tab with `rel="noopener noreferrer"`.
  - Code fences get the Studio's Agentistics palette (reuse the codeview colors from
    `monacoTheme.ts`, commit 80e956fd).
- **Mermaid:** ` ```mermaid ` fences inside markdown, and whole `.mmd` / `.mermaid` files.
  `mermaid` becomes a dependency, **self-hosted and lazily imported** (dynamic `import()` only when
  a diagram is on screen), `securityLevel: 'strict'`, theme variables from the Agentistics palette
  in both light and dark. A diagram that fails to parse shows mermaid's error sentence plus the
  source, never a blank box. Owed: the chunk is excluded from the PWA precache
  (`workbox.globIgnores`, load-bearing as with Monaco) and the report states the embed/binary size
  delta measured with `bun run build:binary` (before/after `ls -l release/agentop`), same honesty as
  the Monaco work.
- **Niche files — highlighting, not rendering.** A Dockerfile has no "rendered" form; what the user
  lacks is recognition. Audit and fix `monacoLanguage.ts` + `fileIcon.tsx` for: `Dockerfile`,
  `Dockerfile.*`, `*.dockerfile`, `Containerfile`, `docker-compose*.yml|yaml`, `compose*.yml|yaml`,
  `.dockerignore`, `Makefile` / `*.mk` (Monaco has no makefile grammar: state it, map to
  `plaintext` or `shell` and say which in the report), `.env*` (done — keep), `*.toml`, `*.hcl` /
  `*.tf`, `nginx.conf`, `Caddyfile`, `.gitignore`/`.gitattributes`, `justfile`, `Procfile`,
  `*.sh`/`*.bash`/`*.zsh`, `*.jsonc`/`tsconfig*.json` (jsonc). A table-driven test lists every one.
- Mobile: the toggle is 44px; the preview scrolls inside the editor region; a mermaid diagram wider
  than the column scrolls horizontally inside its own container.

---

## 5. Tree operations (context menu, VS Code-like create, drag to move)

### 5.1 Context menu

Desktop: right-click a row (and a `⋯` button that appears on row hover/focus). Mobile: a 44px `⋯`
on every row (no long-press — it collides with scroll and text selection). Items, in this order:
**Novo arquivo · Nova pasta** (inside the folder, or the row's parent for a file; inline name input
exactly as the existing create flow), **Renomear** (inline, F2 on desktop), **Mover para…** (a folder
picker — the only move gesture on a phone), **Copiar caminho relativo · Copiar caminho**,
**Mencionar na conversa** (§6), **Excluir** (confirm dialog naming the entry; a directory says "and
everything inside it"; `recursive: true` only after that confirm). Wire `renameRepoEntry` /
`deleteRepoEntry` (they exist in `repoApi.ts` with no UI today). The "Novo" button on the bar keeps
offering both file and folder.

### 5.2 Drag to move (desktop)

- Rows are `draggable`; `dragstart` sets `application/x-agentistics-repo-entry` =
  `JSON.stringify({ sessionId, path, kind })` AND `text/plain` = the relative path (so a drop into
  any other text field gets the path). This MIME is the contract §6 consumes — define it once in
  `lib/repoDrag.ts` with its reader (`readRepoDrag(dataTransfer, sessionId)`, which refuses another
  session's payload).
- Drop on a folder row → move into it; drop on the tree's empty area → the root. A folder hovered
  for 600ms while dragging expands. The drop target shows an outline; an illegal target shows none.
- Illegal, refused on the CLIENT and the SERVER: into itself, into its own descendant, into its
  current parent (no-op), onto a name that exists. Server: `renameTreeEntry` gains an `into-itself`
  refusal (checked lexically before any fs call — today `rename()` would throw EINVAL unhandled);
  `editor-web.ts` maps it in `CONFLICT_SHAPED` (409) with EN/PT sentences; `repoErrorText.ts` too.
- After a move: a toast "Movido para `dir/`" with **Desfazer** for 6s (renames back; refused
  cleanly if the origin was taken meanwhile). No confirm dialog for a move — the undo is the
  safety, a dialog per drag is friction the user would learn to click through.
- **Open tabs follow their files.** A pure `retargetOpenPaths(paths, from, to)` (in
  `repoTreeModel.ts`) re-keys every tab under a moved/renamed path; a dirty buffer keeps its text,
  view state and undo stack (keep the model; if the model URI encodes the path, create the new model
  from the old value + view state and dispose the old only after the swap). Deleting a path with a
  dirty tab asks first.
- Tree refresh after any operation reloads only the affected parents, through the existing
  `applyRootRefresh` / refusal rendering (commit 8cb05c3c).

---

## 6. References into the conversation

### 6.1 Three gestures, one insertion

1. Drag a tree row (§5.2 MIME) onto the composer.
2. Tree context menu → "Mencionar na conversa".
3. Select code in Monaco → "Mencionar seleção": a Monaco context-menu action, keybinding
   `Ctrl/Cmd+Alt+M`, and a small floating chip at the end of a non-empty selection on desktop. On
   mobile, an editor-bar button that is enabled while a selection exists.

All three call ONE function, `mentionFor(harness, { path, lines? })` → text, and insert it with the
existing `requestDraft(sessionId, text)` (`lib/composerStore.ts`, appends, never replaces). If the
composer is not mounted (the centre is on the terminal), the draft store already holds the request
until it mounts; also switch the centre to the conversation and toast "Adicionado à mensagem".
The composer's existing OS-file drop (image attachments) must keep working: the repo MIME is
checked first, anything else falls through untouched — pinned by a test for both.

### 6.2 The format is MEASURED per harness, never guessed

`lib/mentionSpec.ts`: `Record<HarnessId, MentionSpec | null>`, the `rename-spec.ts` shape. Paths are
relative to the session's cwd (the tree root).

- `claude`: candidate `@<path>` for a file and `@<path>#L<a>-<b>` for a range. **Before writing the
  entry, verify on a throwaway PROBE claude session** (never a user's live session): (a) text sent
  through the composer's real send path (`sendTextTo`) SUBMITS — `@` opens Claude Code's file
  autocomplete in the TUI and could swallow the Enter or replace the text with the highlighted
  suggestion; (b) the assistant actually received the file / the range (ask it to quote line a).
  Record the CLI version and date in a comment. If `#L` does not resolve, use
  `@<path> (linhas a–b)` and say so.
- Every other harness: `null` until someone verifies it, and `null` means the plain, universally
  readable form `` `<path>` `` / `` `<path>:a-b` `` — never an `@` a harness might misread.
- Selection mention never pastes the code itself (the file is on disk; a pasted copy goes stale).

---

## 7. The Filtros bar (Sessions workspace)

The workspace's shared header strip today carries the date presets, the range, "+ Filtro" and "Ver
filtros ativos". The user asked for a tab like the dashboard's **Estatísticas** tab (App.tsx ~3475,
the tab hanging below the strip, `position: absolute; top: 100%`), named **Filtros**, with the
filters moved out of the header so the header holds the session title and utilities.

- A tab hanging below the workspace strip: "Filtros" + active-count badge + chevron; expands to the
  full `FiltersBar` (desktop), animated with the `grid-template-rows 0fr↔1fr` pattern already used
  for mobile filters (including the clip-only-while-animating rule so popovers are not cut).
- Collapsed by default; open state per browser (`localStorage`, guarded).
- The header loses the filter controls in the workspace only; the dashboard pages are untouched.
- Mobile: already a sheet from the session menu ("Filtros" row) — leave it; verify nothing regressed.

---

## 8. Work packages, ownership and order

Wave 1 runs in parallel (each in its own worktree off `feat/repo-explorer-aside`). Wave 2 starts
after wave 1 is merged. Files a package does not own may be READ, never edited.

| Pkg | Scope | Owns |
|---|---|---|
| W1-A | §2 button (without the "on" wiring to slots: until W2 lands, "on" = the Studio is shown in the aside) + §3 tab icons + remove "‹ Conteúdo" | `App.tsx` (Studio button block only), `SessionsPage.tsx` (the mobile menu `studio` row only), `Studio.tsx` (`TabStrip` + the bar's back link only), `fileIcon.tsx` |
| W1-B | §4 rendered documents + niche highlighting | new `MarkdownPreview.tsx`, `MermaidDiagram.tsx`, `lib/frontmatter.ts`, `lib/markdownLinks.ts`; `RepoFileEditor.tsx` (editor bar toggle + preview region only); `monacoLanguage.ts`; `packages/web/package.json`; `vite.config.ts` (globIgnores) |
| W1-C | §5 tree operations | `RepoTreeView.tsx`, `repoTreeModel.ts`, new `TreeContextMenu.tsx`, `lib/repoDrag.ts`; `Studio.tsx` (tree op handlers + tab retarget only); server `editor-fs.ts` (rename refusal), `editor-web.ts`, `repoErrorText.ts` |
| W1-D | §7 Filtros bar | `App.tsx` (workspace strip filters block only) |
| W2-A | §1 slots | `lib/panelSlots.ts`, new `StudioHost.tsx`, `SessionsPage.tsx`, `ArtifactsAside.tsx`, `SessionPanel.tsx`, `ShellBand.tsx`, `lib/terminalSurface.ts`, `lib/artifactsStore.ts`, `App.tsx` (button on-state wiring) |
| W2-B | §6 references | `lib/mentionSpec.ts`, `SessionChat.tsx` (composer drop only), `RepoFileEditor.tsx` (Monaco action + chip only), `TreeContextMenu.tsx` (enable the item) |

W1-A and W1-D both touch `App.tsx` in different blocks; W1-A and W1-C both touch `Studio.tsx` in
different regions. The coordinator merges and resolves; neither package reformats code outside its
block.

## 9. What every package owes (shared rules)

- TDD for pure modules; a new test must be shown to FAIL on a planted defect, then pass.
- `bun tsc --noEmit` clean; the package's tests green; one full `bun test` at the end, alone in the
  worktree, numbers quoted verbatim.
- UI verified in a real browser (Playwright) at 1440×900 AND 390×844 against a preview server on an
  ISOLATED `AGENTISTICS_DIR` and a PROBE session — never the user's live sessions, never the
  installed binary on 47291/47292. `document.documentElement.scrollWidth <= innerWidth` at 390.
- EN and PT strings for every new word.
- Stage exact paths, never `git add -A`. Reports go OUTSIDE the repository.
- No source-grep assertion that a comment can satisfy (use `lib/stripComments.ts`).
