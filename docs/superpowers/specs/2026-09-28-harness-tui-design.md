# Harness TUI — the unified agentop terminal interface (design)

**Status:** approved by the owner, 2026-09-28 ("adorei"), in a design-only session (no product code).
**Parent task:** t-e1dea7cd6f "Agentistics Runtime, Adapter Architecture e Harness Nativo" (B4.4, D24).
**Prototype (the source of truth for every screen):**
- Interactive, unified: `docs/superpowers/specs/assets/harness-tui-unified.html` (published at
  https://claude.ai/artifact/1psLwBbxGb4TS9yv1FV31K). Open it, click the terminal, drive it with the
  keyboard; the right-hand map lists every feature by ID and highlights the ones on screen.
- The eight exploration mockups that preceded it: `docs/superpowers/specs/assets/harness-tui-ideas.html`
  (https://claude.ai/artifact/XqAftWjQcv58rakBR9J2gj).

The feature IDs below (GL-, HM-, CD-, SS-, TK-, NW-, ST-, EX-) are the SAME IDs the prototype's map
prints. Implementation is delivered **1-1-1**: one subtask per ID, each closing only when (1) the
feature as mapped in the prototype, (2) the screen that hosts it in the TUI, and (3) the feature
working correctly on that screen, are all true — verified against the COMPILED binary (CLAUDE.md,
Terminal UI rules).

## 1. Decisions

| # | Decision | Why | Rejected |
|---|---|---|---|
| D-TUI-1 | A **rich** terminal interface, opencode-like but better: full session management, metrics, settings — people who live in the terminal never need the web. | The native harness is the product's differentiator; a bare chat loop does not show it. | Minimal (conversation + prompts only); conversation + status bar only. |
| D-TUI-2 | **All four directions combined, nothing duplicated.** Skeleton = A (conversation + right panel). The panel SWAPS content: session (A) · inspector of the selected turn (C) · run timeline (D). The per-turn receipt (B) is always under each answer. Home (E), settings (F), palette (G) and permission-with-diff (H) are screens/overlays. Every fact has ONE place; the palette leads to it rather than repeating it. | The owner loved all four; a swapping panel gives each its moment without four copies of the same numbers. | Picking one direction; showing all panels at once. |
| D-TUI-3 | **One Ink app.** `agentop code` opens the existing control center on its new `code` tab; bare `agentop` opens on `home`. New tabs: `home`, `code`, `tasks`; `sessions` evolves; `dashboard`, `services` (and the existing logs / cheat sheet / contribute screens) stay as they are. | CLAUDE.md: there is ONE Ink application; a second app would be a second set of keys, a second fleet, a second rule set. | A separate `agentop code` app with its own sessions/tasks (duplication); `code` as the front door swallowing the cockpit. |
| D-TUI-4 | **The `sessions` tab reaches parity with the web Sessions workspace**, for every harness (native, Claude, Codex, …, external): list, chat, terminal capture, metrics, answer an approval, open/attach, rename, file under a task, stop, search, group. Every verb, label, `enabled` flag and refusal comes from the server (`/api/fleet*`, `sessionActions`); the TUI decides nothing on its own. | Same experience as the web, one rule set. | A TUI-side copy of the session rules. |
| D-TUI-5 | **`tasks` tab = a read-only view of the ALM**: the tasks assigned to you, status, progress, rollup (cost · tokens · rounds, N/A honest), subtasks, sessions, blocked reason, activity, a link to edit on the web; `n` starts a session filed on the selected task. Full editing stays on the web. | Tracking is automatic; the terminal needs to SEE the work and start sessions in it, not administer the board. | Full board management in the TUI. |
| D-TUI-6 | **Every session started from the TUI is filed under a task — required.** The new-session wizard cannot finish without one (pick, or create inline). Sessions agentop did not start are listed as "not filed" and can be filed (`t`). Stopping the last live session of a task asks whether the task is finished. | Owner: "vai ser obrigatório a criação das tasks" — everything is tracked. | Optional filing; auto-filing by directory guess. |
| D-TUI-7 | **A permission request is a numbered option list read from the policy state**, never a single "approve". It shows the command or the diff, WHY it asks (which rule / mode), "runs as you · no sandbox", the checkpoint for writes; `4` denies with a reason sent to the agent; `d` opens the full diff; `esc` (or no answer) is a DENY. Answering from the `sessions` tab shows the same list — one policy, two doors. | Product rule; B3 policy; B4 `answered:false` is a denial. | An approve button; enter-to-confirm. |
| D-TUI-8 | **Metric granularity is the differentiator, and N/A is never 0.** Per-turn receipt (duration · ttft · all-4 tokens · cache · cost); context gauge split into system / tools / conversation; the inspector prices each counter of each call; the timeline separates model time, tool time and **time waiting on you**. Costs are labelled api-equivalent. A value the source cannot produce renders N/A with a sentence. | HARNESS_CAPABILITIES rule; tokens.ts rule; contextWindows rule. | Confident zeros; input+output as "tokens". |
| D-TUI-9 | **"no sandbox" is always on screen in `code`** (header) and in the wizard's review step for a native session. | M1 runs without a sandbox (B3-SEC F5). | A one-time notice. |
| D-TUI-10 | **Narrow terminals (< 100 columns) show one pane at a time**; `tab` switches pane, `esc` goes back. In `code` the panel collapses to a one-line status (ctx · cost · task · mode) and `ctrl+i`/`ctrl+t`/`ctrl+b` open it full-width. Nothing may wrap or overflow the height (Terminal UI rules). | 80 columns is common. | Squeezing three columns into 80. |
| D-TUI-11 | **Logo**: the icon rendered in half-blocks (▀▄) from the real SVG — scale and colour ONLY — beside the existing `WORDMARK_ART`. | Brand rule: never alter the logo's geometry. | A redrawn ASCII logo. |
| D-TUI-12 | **Keys**: `[` `]` tabs (always) · `ctrl+p` palette · `ctrl+,` settings · `ctrl+s` sessions · `?` help · `ctrl+i` inspector · `ctrl+t` timeline · `ctrl+b` session panel · `ctrl+o` expand output · `ctrl+g` external editor · `ctrl+r` prompt history · `shift+tab` permission mode · `1-4` answer · `d` full diff · `x` stop (never `k`) · `r` rename · `t` file under a task · `a` answer · `n` new · `/` search or command · `g` group. The palette and the `/` popup are ONE command list. Keys are rebindable; conflicts are refused in words. | Continuity with the cockpit; discoverability. | Digit shortcuts for screens (removed from the cockpit for a reason). |
| D-TUI-13 | **English by default, pt-BR toggle**, whole app, persisted by the host (the cockpit's `host.lang` rule). | House rule. | — |
| D-TUI-14 | **Delivery is 1-1-1**: one ALM subtask per feature ID in §3, closed only with the three checks in the header. | Owner: every feature in the prototype is covered, progressively and verifiably. | One big "implement the TUI" task. |

## 2. Screens (see the prototype for exact layout and copy)

- **Chrome** — row 1: logo mark, tab bar, `● N need you`, version. Row 2: what this tab is about
  (in `code`: session · task · folder · `▲ no sandbox` · mode). Last two rows: status sentence, key hints.
- **home** — ANSI logo + wordmark, the first-prompt box (enter → wizard, task first), cards: today,
  resume (1-3), your tasks, providers; a line for the rest of the machine's fleet.
- **code** — conversation (collapsed older turns, streaming text, tool rows, inline diff, receipt,
  long output fold), the permission card, the composer (`/` popup, `@`, `!`), and the swapping panel.
- **sessions** — grouped fleet list + detail (chat · terminal · metrics tabs, action row).
- **tasks** — tasks by status + detail.
- **overlays** — palette, help, settings (7 sections), new-session wizard (6 steps), confirm, full diff.
- **dashboard / services** — existing screens; dashboard gains a "cost by task" panel (EX-01).

## 3. Features, acceptance criteria and dependencies

"Depends" names what does not exist yet and must land first (or the feature ships showing N/A /
absent, never invented). Everything else is buildable on what `dev` already has.

### Global
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| GL-01 | One app, six tabs | `agentop code` and `agentop` open the SAME control center on `code` / `home`; `[` `]` cycle `home code sessions tasks dashboard services` (+ existing screens); no second Ink app exists. | — |
| GL-02 | Attention counter | `● N need you` in the header on every tab counts approval + needs-you rows; bell only on the transition. | — |
| GL-03 | Command palette | `ctrl+p` opens a filterable list of every command with its shortcut; enter runs; inapplicable commands say why instead of vanishing. | — |
| GL-04 | Help overlay | `?` lists every key by screen; matches the actual bindings (test compares the table with the key map). | — |
| GL-05 | Footer hints | the footer names only keys that work in the current focus (`cockpitHints` rule), most important first. | — |
| GL-06 | Status sentences | every action and refusal leaves one sentence on the status row; nothing is silently inert. | — |
| GL-07 | Narrow terminals | at 80 columns every screen shows one pane at a time; no row wraps; no overflow at any height ≥ 24. | — |

### Home
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| HM-01 | ANSI logo + wordmark | icon generated from the SVG by scaling only; wordmark from `WORDMARK_ART`; degrades to the compact mark when narrow. | — |
| HM-02 | First prompt → task | typing then enter opens the wizard at the task step with the prompt carried. | NW-01 |
| HM-03 | Today card | cost (api-equivalent), tokens (all 4), sessions (live count), streak, 14-day sparkline; UTC day rule. | — |
| HM-04 | Resume card | the 3 most recent resumable sessions with cost, task, age, state; `1-3` open them. | — |
| HM-05 | Your tasks card | top tasks with status glyph and progress; no bar when there are no subtasks. | TK-01 |
| HM-06 | Providers card | each configured provider: ready / off (beta) / unreachable, from the real credential/test state. | ST-01 |
| HM-07 | Machine line | other sessions on the machine and how many need you; `ctrl+s` goes there. | — |

### Code — the native session
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| CD-01 | Session header | title, task (+ subtask), folder, mode, `▲ no sandbox` always visible. | — |
| CD-02 | Streaming text | text renders as deltas arrive from the runtime stream, with a live cursor; no full-frame flicker. | — |
| CD-03 | Tool rows | one row per call: status glyph · verb · target · duration/result; failures in words. | — |
| CD-04 | Inline diff | an applied patch shows its changed lines inline (add/del backgrounds), with a count of the rest. | — |
| CD-05 | Collapsed turns | older turns fold to one line (question · tools · cost); selecting in the inspector expands one. | — |
| CD-06 | Turn receipt | under each finished answer: duration · ttft · tokens (all 4) · cache hit · cost; absent parts read N/A. | ttft from stream timing |
| CD-07 | Permission card | numbered options read from the policy; the command or diff; why it asks; runs-as-you/no-sandbox; composer locked while pending. | — |
| CD-08 | Deny with a reason | option 4 opens a reason field; enter sends the denial + reason to the agent. | runtime: reason on deny |
| CD-09 | Full diff | `d` shows the whole hunk with checkpoint note and the same options. | — |
| CD-10 | Long output fold | long tool output folds to one line; `ctrl+o` toggles. | — |
| CD-11 | Composer | `/` popup (same list as the palette), `@` file, `!` shell hints; enter sends. | — |
| CD-12 | Panel · session | context gauge split system/tools/conversation, spend (turn/session/today), 4 counters + cache hit, files, plan, "also open" (only when true). | context split from the runtime; "also open" needs the server to host CLI sessions (B4 stated limit) |
| CD-13 | Panel · inspector | per turn: model, stop reason, ttft/rate, each counter with its cost, context after, tools with latency, the policy decision of each call; `↑↓` picks the turn. | per-call usage + policy decision events |
| CD-14 | Panel · timeline | the run as bars: model calls, tools, waiting on you; totals of time and money. | ask/answer timestamps |
| CD-15 | Permission mode | `shift+tab` cycles the modes; the header and card say which. | runtime: modes defined (see §5) |
| CD-16 | Session rules | an "allow for this session" answer appears in the panel until the session ends. | — |
| CD-17 | External editor | `ctrl+g` (and `/editor`) opens `$EDITOR` on the draft through the control center's `suspend`; saving and quitting puts the text back in the composer; locked while a permission is pending. | — |
| CD-18 | Prompt history | `ctrl+r` (and `/history`) opens a filterable list of this machine's earlier prompts, newest first; enter puts one back in the composer for editing, never sends it. | — |
| CD-19 | Copy last answer | `/copy` writes the last finished answer to the clipboard via OSC 52 (works over SSH and inside tmux) and says how many characters; with no finished answer it says so. | — |

### Sessions — the fleet
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| SS-01 | Whole fleet, grouped | every harness incl. native and external; `g` groups by task · harness · state; data from `/api/fleet`. | native sessions in the fleet |
| SS-02 | State in words | approve · needs you · working · ended · external, with the coloured dot beside the word. | — |
| SS-03 | Detail · chat | the linked conversation (exact link only); otherwise a sentence. | — |
| SS-04 | Detail · terminal | captured frame for tmux sessions; native/external say why there is none. | — |
| SS-05 | Detail · metrics | all 4 counters, cost, context gauge or N/A with the reason, turns. | — |
| SS-06 | Answer from the list | `a` lists options read off the screen (or the policy, for native), re-read before sending; the highlighted row is never chosen for you. | — |
| SS-07 | Open / attach | enter: native → `code`; tmux → attach (`ControlExit`, detach returns); external → refuses in words. | — |
| SS-08 | Rename | `r` renames in agentop and, where the harness supports it, in the harness; says which. | — |
| SS-09 | File under a task | `t` opens the task picker (same component as NW-01). | — |
| SS-10 | Stop → finish task? | `x` confirms; if it was the task's last live session, asks whether the task is done (writes the board). | — |
| SS-11 | Search | `/` filters by title or task; `esc` clears; the empty list says why. | — |
| SS-12 | External sessions | listed and marked; verbs they cannot take refuse in a sentence. | — |

### Tasks — ALM view
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| TK-01 | Your tasks | grouped by status (the board's own vocabulary), progress, cost; done tasks dimmed. | "your tasks" definition (§5) |
| TK-02 | Rollup | cost · tokens · rounds from the task's sessions via `task-rollup.ts`; N/A when none. | — |
| TK-03 | Subtasks | each with status and session count. | — |
| TK-04 | Its sessions | listed with state and cost; enter opens the live one. | — |
| TK-05 | Blocked reason | shown in words for a blocked task. | — |
| TK-06 | New session here | `n` opens the wizard with the task chosen; refused in words on a done task. | NW-* |
| TK-07 | Read-only + web link | no edit verbs; `w` opens `/tasks/<id>` in the browser. | — |

### New-session wizard
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| NW-01 | Task (required) | open tasks + "new task…" (inline title → created as todo); cannot be skipped. | — |
| NW-02 | Assistant | native + installed harnesses only (spawn-spec rule). | — |
| NW-03 | Model | per assistant; native shows provider, price and window with provenance; a disabled provider says why. | — |
| NW-04 | Folder | recent repositories + "new worktree". | — |
| NW-05 | First message | optional free text. | — |
| NW-06 | Review | summary + no-sandbox line for native; enter starts, files it, and lands on the new row. | — |

### Settings
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| ST-01 | Providers | status, credential source (masked, by its end), default model, test with latency; wrong-vendor keys refused in words; writes the same preferences as the web. | B5 credential store |
| ST-02 | Models & pricing | price per counter, window, source + date; N/A when unverified. | — |
| ST-03 | Permissions | allow / ask / deny rules, session rules, the floor shown as not liftable. | — |
| ST-04 | Appearance | theme and density. | — |
| ST-05 | Keybindings | every key rebindable; conflicts refused. | — |
| ST-06 | Language | EN / pt-BR, the whole app, persisted. | — |
| ST-07 | Tasks & tracking | "task required" shown as the owner's rule; external-filing prompt. | — |

### Existing screens
| ID | Feature | Accepted when | Depends |
|---|---|---|---|
| EX-01 | Dashboard | unchanged, plus a "cost by task · today" panel with a "not filed" bucket. | — |
| EX-02 | Services & logs | unchanged; reachable as tabs of the same app. | — |

## 4. Delivery order (each phase = a set of the subtasks above)

1. **P1 — B4.4, the terminal that works:** GL-01, GL-05, GL-06, CD-01–04, CD-07, CD-09, CD-11,
   CD-12 (without the context split and "also open"), NW-01, NW-06 (the minimal path to start a
   filed native session).
2. **P2 — the rest of `code` + home:** CD-05, CD-06, CD-08, CD-10, CD-13–19, HM-01–07, GL-02–04, GL-07.
3. **P3 — sessions parity:** SS-01–12.
4. **P4 — tasks + full wizard:** TK-01–07, NW-02–05.
5. **P5 — settings + dashboard panel:** ST-01–07, EX-01, EX-02, GL-07 re-check.

**Added 2026-09-28 after approval** (CD-17–19, relayed by the leader from the feature research, round 2:
Gemini CLI's `/editor`, Claude Code's `ctrl+g`, a prompt-history search, OSC 52 copy). Small, beside
CD-11; added to the prototype and to the ALM task so the 1-1-1 mapping stays complete — 67 features.

## 5. Open questions (for the leader / owner)

- **Permission modes (CD-15):** the prototype cycles `ask · edits · plan`; the runtime policy has no
  named modes yet. Define them in the runtime before CD-15.
- **"Your tasks" (TK-01):** proposed = tasks you claimed OR where one of your sessions is filed.
- **Required task outside the TUI (D-TUI-6):** does the rule also bind `agentop session start`, the
  web wizard and `POST /api/fleet/new`? The TUI enforces it; extending it is a separate decision.
- **Native sessions in `/api/fleet` (SS-01) and watching a CLI-driven session from the web (CD-12
  "also open"):** both need the server to host native sessions (B4 stated limit, "UI round 2").
- **Runtime events the metrics need:** time-to-first-token, context composition, per-call usage and
  the policy decision per call (CD-06, CD-12, CD-13, CD-14). Until they exist those cells read N/A.
