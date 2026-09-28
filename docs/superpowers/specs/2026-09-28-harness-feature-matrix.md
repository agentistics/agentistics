# Native harness — feature-gap matrix against mature terminal harnesses

**Research only. No product code was written for this document.** Requested on task `t-e1dea7cd6f`
after the owner's concern of 2026-09-28 that the native harness "looks small" beside a mature
terminal harness. This document answers that concern with a row per capability rather than with a
file count, and recommends what to build and when. The leader (7b1095709e) decides which of the
proposed items become subtasks.

**Scope.** This document covers what a terminal harness DOES (commands, keys, hooks, skills, memory,
subagents, MCP, editor bridge, plan mode, context, configuration, collaboration). It does NOT cover
pixels: layout, colours, the permission prompt's look, diff rendering and narrow terminals belong to
the TUI design session (c44ad82236, UI.6). Where a row needs both, it names the seam and leaves the
look to UI.6.

**The ruler** (the board's own): **small** = one file, one responsibility · **medium** = a module
with its tests · **giant** = a whole phase.

**Recommendation values**: **M1** = needed for the owner's first test of the native harness to be
meaningful · **post-M1** = worth building, after M1 · **never** = deliberately not, with the reason.

---

## 0. Sources, and what was NOT read

| Source | How it was used | Verified in this session? |
|---|---|---|
| `packages/runtime/src/**` and `packages/server/server/{cli-code,runtime-host,runtime-sessions-web}.ts` at `origin/feat/runtime-sessions` (7d77e812) | what the native harness has TODAY | yes — read with `git show`, no checkout |
| `docs/superpowers/specs/2026-09-19-agentistics-runtime-master.md` (§24.5–26, §46–49), `2026-09-20-runtime-b3-tool-catalogue.md`, `2026-09-25-runtime-context-manager-design.md`, `2026-09-25-owner-decisions.md`, `2026-09-27-runtime-b4-sessions.md` | what is already PLANNED or decided, so no row re-opens it | yes |
| The board (`GET /api/tasks/t-e1dea7cd6f`, 141 subtasks, 241 comments) | which items exist | yes, 2026-09-28 ~19:10Z |
| **opencode** (MIT), installed at `~/.opencode` | reference: `opencode --help`, `opencode debug config`, `debug agent plan`, `debug skill` (its built-in configuration skill documents the whole config surface: agents, commands, skills, plugins and their hook names, permissions, compaction, snapshot, LSP, formatter, references) | yes — read from the binary's own output |
| Public documentation of **Claude Code**, **Codex CLI** and **Gemini CLI** | reference | **no — from the model's knowledge of the public docs (cutoff 2026-06), not re-fetched today.** Each claim below is a well-known, stable feature. Anything that becomes a spec must be re-checked against the vendor's own page first, the rule `attention-rules.ts` applies to dialogs |
| This product's own research (`master` §24.7, the harness hooks table at master line ~886) | Gemini/Copilot/Kimi hook and ACP facts | yes |

**openclaude (`Gitlawb/openclaude`) was not opened.** The brief allowed reading it for patterns under
strict rules. The owner's record is stricter: D3 says *"no code derived from the leaked Claude Code
source, under any option (§54)"*, and the leader's board note of 2026-09-28 19:02 says *"do NOT copy
or read its code"*. When two instructions disagree, the stricter one wins. Nothing in this matrix
depends on that repository. Every mature-harness row below rests on public documentation or on the
MIT opencode.

---

## 1. The findings that matter more than any row

The owner compared file counts. The real gaps are not the breadth of the catalogue. They are five
seams that a first user will hit in the first ten minutes, and **none of them is on the board**.

1. **A native session runs with NO system prompt.** `runToolLoop` accepts `system` / `systemCache`
   (`loop/loop.ts:143`), but `session/runtime.ts:288` never passes it, and `runtime-host.ts` does
   not either. So the model is told nothing about:
   - its working directory, workspace root, platform, date or git branch;
   - the policy it runs under;
   - the fact that there is no sandbox (D-T5);
   - the conventions of its own tools (`file.patch` is read-before-write; `shell.*` is one
     persistent session);
   - the project's instruction file.

   Every mature harness builds this block, and it is the single largest quality lever there is.
2. **Nothing loads a permission rule from disk.** The layered model is complete and pure: machine →
   user → project, deny beats everything, most-specific next (`policy/rules.ts`). But
   `runtime-host.ts:121` hands the policy `layers: []`. Today the only way to stop being asked the
   same question is "allow for this session", and that is lost on every restart (B4 §4).
3. **The undo engine exists and nothing can reach it.** `tools/file/checkpoint.ts` records what the
   editor wrote and restores it, refusing a file changed since. Two limits:
   - it is in-memory only, so it dies with the process;
   - no CLI verb, route or tool calls `restore`.

   With no sandbox (D-T5, accepted consciously), undo is the cheapest safety net the product has,
   and it is already written.
4. **Nothing stops a session from outgrowing the model's window until B4-CTX ships.** A resumed run
   sends "the newest 200 messages, trimmed to a clean boundary" (B4 §4). That is a MESSAGE count,
   not a token count: 200 messages carrying large tool results exceed a 200k window, and the run
   fails at the provider. B4-CTX is the real answer and ships only after its pre-registered
   measurement (CTX §10). Until then, a floor is needed. This is **not** a second design: see §3.
5. **`agentop code` hosts its own hub, so the web cannot watch a terminal session** (B4 §8, stated
   limit). Objective C of the task is "one session, many windows". If the terminal is a HOST
   rather than a CLIENT, the web and the terminal are two islands. This fork has to be decided
   **before** UI.6's design turns into the B4.4 follow-up, because it decides what the TUI talks to.

---

## 2. The matrix

Legend for **Today**: **yes** / **partial** / **no**, with where. **Planned** names the board item
when one exists.

### 2.1 Session basics and the system prompt

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| **System prompt: identity + environment block** (cwd, workspace root, platform, date, git branch/status summary, the policy and no-sandbox fact, tool conventions) | the model acts on facts instead of guessing them; every mature harness sends one | **no** — `system` exists on the loop and is never passed (§1.1) | none | **M1** — the owner's test is meaningless without it; mark it cacheable (`systemCache` already exists) so it costs one cache write per session | medium |
| **Project instruction file** (`AGENTS.md`; the cross-vendor name used by Codex and opencode. Claude Code reads `CLAUDE.md`, Gemini reads `GEMINI.md`) | a repository states its own rules once, for every session | **no** | none | **M1** for `AGENTS.md` at the workspace root plus the directory chain down to `cwd`. Reading `CLAUDE.md`/`GEMINI.md` is an **opt-in compatibility setting**, never the default: the native core must not depend on another harness's files (the "precedent, never a dependency" rule) | small |
| **Session title** | `agentop code ls` shows a model id today (`s.title ?? s.model`); a list of ten `claude-sonnet-5` rows is unusable | partial — `SessionRecord.title?` exists, and nobody sets it | none | **M1** — **deterministic**: the first prompt through `sessionLabel()`'s rules. **Not** a model call: CTX §6.5 already rejects "a second model writing text the product trusts", and opencode's hidden `title` agent is exactly that | small |
| `/clear` / new session in the same place | start fresh without leaving the terminal | no — only `/exit`, then re-run | B4.4 follow-up (after UI.6) | **M1**, as part of the command registry (2.2) | small |
| `/resume` picker inside the TUI | reopen without copying an id | partial — `agentop code ls` + `--resume <id>` | B4.4 follow-up | M1 (the picker's look is UI.6's) | small |
| **Change model mid-session** (`/model`) | pick a cheaper or stronger model for the next turn | no — `--resume` refuses `--model`; the session keeps its model | none | **post-M1**. Same PROVIDER: the history is canonical, so this is a new run parameter plus a `run.started` field. ACROSS providers is a message-translation problem (signed reasoning, CTX §7's edit policies) and needs its own spec | medium (same provider) / giant (cross-provider) |
| Fork a session at a turn | try another path without losing the first | no | none | post-M1 — copy messages `≤ seq` into a new `SessionRecord`; the content store is addressed by sha256, so nothing is duplicated | small |
| Export a session | hand a conversation to someone or keep it | no | none | post-M1. It must honour CTX §8.4: a `sensitive` execution never leaves, and the redactor runs at the export boundary | small |
| **Audit event for creating/driving a session** | the security rules require audit on host-power actions | no — B4 §8 names it a stated limit | none | **M1** — it is the one security-rule gap in the shipped surface | small |

### 2.2 Commands (`/…`) and the keyboard

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| **A command registry** (name, description, arguments, availability, one handler) shared by the TUI and the web composer | the command list must exist ONCE. Two lists are the "one gesture implemented twice" defect `task-reopen.ts` exists to have fixed | no — `cli-code.ts` special-cases `/exit` | UI.6 decides WHICH commands and keys; nothing owns the registry | **M1**, together with the B4.4 follow-up. UI.6 decides the list; this is the seam its list plugs into. Put it in `packages/runtime` as data, with the handlers in the host | medium |
| Built-in commands: `/help` `/clear` `/new` `/resume` `/model` `/cost` `/context` `/permissions` `/undo` `/plan` `/exit` | the everyday verbs every mature harness has (Claude Code, Codex and Gemini all ship most of them; opencode ships them as TUI actions) | only `/exit` | UI.6 (which ones, how they look) | M1 for `/help /new /resume /exit /undo /cost /context /permissions`; the rest post-M1, each behind the row it depends on | small each |
| `/cost` and a per-run line (tokens, cost, cache share) | the product's reason to exist is the exact number; the native harness has it and prints none of it | no — `model.completed` carries exact usage, and the CLI prints tool lines only | none | **M1** — the data exists (B1.6/D21); only the line is missing, and its look is UI.6's | small |
| **Context gauge** in the CLI/TUI and the web | shows how full the window is before it fails | no for native — the product has the gauge for external harnesses (`contextFraction`, `resolveContextWindow`) | none | **M1** — reuse the same two functions and the same "no bar when the window is unknown" rule. No second implementation | small |
| Custom commands (a markdown file whose body is a prompt template with `$ARGUMENTS`) | a team packages its recurring prompts | no | none | post-M1 — once the registry exists, a file-backed command is one more source for it (opencode `.opencode/command/*.md`, Claude Code `.claude/commands/*.md`, Gemini TOML) | small |
| `/init` — draft an `AGENTS.md` from the repository | the instruction file above has to start somewhere | no | none | post-M1 — it is a PROMPT, not code: a built-in command whose template asks the model to write the file through `file.write`, gated like any write | small |
| `@path` mentions (attach a file to the prompt) | cheaper than asking the model to read the file | no | none | post-M1. Functional half: resolve and inline under the policy's read rules. Look/autocomplete: UI.6 | small |
| `!command` passthrough (run a shell command yourself, output into context) | a person shows the model something without a tool call | no | none | post-M1 — it runs through the SAME policy as `shell.start`, with the person as the actor | small |
| **Customisable keybindings** (a user file overriding defaults; Claude Code has one, opencode has `keybinds` in its config) | muscle memory from other tools | no | UI.6 decides the defaults | post-M1 — never before the defaults exist, or the file freezes an accident | small |
| Vim-mode input | a preference | no | none | post-M1, low — only if the input component chosen by UI.6 makes it cheap | small |

### 2.3 Permissions, plan mode and safety

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| Per-call ask with "allow once / allow this prefix for the session / deny", deny floor, command parsed by segment | the core safety of a harness that runs commands | **yes**, and stricter than most (`policy/policy.ts`, `floor.ts`, `shell-parse.ts`) | done (B3, B3-SEC) | — | — |
| **Permission rules loaded from files** (user file + project file) | stop answering the same question every session | **partial** — the model is complete, `layers: []` in the host (§1.2) | none | **post-M1, first wave**. One security rule is mandatory: **a project file ships inside the repository an agent works on, so until the person trusts that folder, the project layer may only ADD `deny`/`ask` rules, never `allow`.** Otherwise a cloned repository pre-approves its own `curl … \| sh`. Codex (trusted projects) and Gemini (trusted folders) both gate on trust for this reason. `rules.ts` already makes deny absolute across layers. This adds the missing other half | medium |
| **Plan mode / read-only mode** | explore and propose without changing anything; every mature harness has one (Claude Code's cycle, Codex's read-only approval policy, opencode's `plan` agent) | no — B3 §3 **deliberately** excluded "a plan-mode separate from `task.plan`" | none | **post-M1, first wave — as a POLICY PROFILE, not a tool.** opencode defines its plan mode as nothing more than a permission ruleset (`edit: deny`; read from its own `debug agent plan`). Here it would be a policy layer denying writes and mutating shell segments. That honours B3's exclusion (no new tool, `task.plan` stays the checklist) and costs one layer | small |
| "Accept edits for this session" mode | fewer prompts in a trusted edit loop | partial — session approvals are per command prefix, not per class | none | post-M1 — the same profile mechanism, lifting `file.patch`/`file.write` inside the workspace from ask to allow. **It may never lift the floor** | small |
| A "bypass everything" / yolo mode | speed | no | — | **never.** The floor is non-negotiable by design (B3 D-T3). A mode that lifts it is a sandbox-less agent with no brakes. The profiles above cover the legitimate need | — |
| `/add-dir` — work outside the workspace | multi-repository work | no — outside-workspace reads/writes are denied unless a rule NAMES the path | none | post-M1 — it is exactly "a session-scoped rule with a `pathGlob`", which `rules.ts` already supports. The command only writes that rule | small |
| **Undo / rewind the agent's edits** | recover from one bad step without git archaeology | **partial** — engine written, in-memory, unreachable (§1.3) | none | **M1** — expose `restore` for the last run and for the session, through the command registry and the web. Persist the checkpoint through the content store so it survives a restart. It must say what it does NOT cover (shell-made changes), in words, as its own header already does | small (expose) + small (persist) |
| Loop guard ("the same tool call N times in a row"; opencode's `doom_loop` permission) | stop a model burning money repeating itself | partial — run limits exist (turns, tool calls, wall time) | none | post-M1 — a pure detector over the run's own `tool.requested` events that turns the Nth identical call into an ask | small |
| Sandbox | contain what a command can reach | partial — B3.8: probe + opt-in Docker, four stated states | done (D-T5) | — | — |

### 2.4 Hooks and extensions

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| **User-configured hooks** (a command runs on an event). Claude Code: pre/post tool use, prompt submit, stop, session start/end, notification, pre-compact. Gemini: ~11 events incl. before/after model (master §17 table). Codex: a `notify` program. opencode: plugin callbacks `tool.execute.before/after`, `permission.ask`, `shell.env`, `chat.system.transform`, `session.compacting` | automation around the agent: format after edit, block a path, notify, inject context | internal seams only (`onToolCall`, `onHistory`, retry hooks); nothing a person configures | A5.1 is hooks of EXTERNAL harnesses (ingestion), not this | **post-M1, split three ways — do NOT build one generic hook system.** (a) **Block / allow before a tool** is the policy's job: a hook that vetoes is a second policy engine, and the journal could not say which one decided. (b) **Observe** (notify, log, sync) is a subscriber to the journal/event stream the product already has. (c) The one genuinely new case is **"run a command after an edit"** (formatter, linter). Make it a narrow, declared entry in the project config (below), running through the same policy as `shell.start` | small (c); (a) and (b) need nothing new |
| **Plugins / extensions** (code loaded into the harness) | third parties add tools, providers, auth | no | **decided: D9** — "define the contract now; ship the loader when there is demand" | follow D9 as written: **post-M1, on demand**. MCP (B6.3) covers "add a tool" without running foreign code in-process, which is most of the demand | — |
| **Skills** (a `SKILL.md` folder: a description always visible, the body loaded on demand) | reusable know-how the model loads only when relevant, with no tax on every session | no | none | **post-M1, first wave.** The format is now a cross-vendor convention: opencode loads `~/.claude/skills` and `~/.agents/skills` automatically (verified in its `debug skill` output). The product ALREADY lists skills per harness (`skill-source.ts` / `HARNESS_SKILLS`). Native design: primary dir `.agentistics/skills` + `~/.agentistics/skills`; reading `~/.claude/skills`/`~/.agents/skills` is an opt-in compatibility setting; a `skill.load` tool returns the body under the policy's read rules, and the descriptions go into the system prompt (2.1) | medium |
| Status line (a command whose output is drawn under the prompt) | persistent at-a-glance facts | no | UI.6 | post-M1 — its data is the per-run line + gauge (2.2); its look is UI.6's | small |

### 2.5 Memory

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| Static instructions (a `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` hierarchy) | rules the person WROTE | no | — | covered by **2.1 "Project instruction file"**. It is not memory: nothing is learned or derived. **Keep it out of B6.6** | small |
| "Remember this" (Claude Code's `#` shortcut, Gemini's `/memory add`) | the person states a durable fact in one gesture | no | **B6.6** (`memory.note`, §24.6 rule 5: the one path that may default to available) | post-M1 via B6.6 — no new item. **Overlap to avoid:** a `/remember` command, if UI.6 wants one, is a registry entry calling B6.6's `memory.noted`, never a second write path | — |
| Learned / derived memory across sessions | the agent stops repeating the same mistakes | no | **B6.6** (facts derived from the journal; D13 consent; D15 no semantic retrieval in v1) | as planned — nothing to add | — |
| Inspect / edit / forget memory (`/memory`) | memory must not be write-only from the user's side (§24.6 rule 1) | no | B6.6 | as planned; it lands in the registry as a command | — |

### 2.6 Subagents and delegation

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| Spawn / wait / stop a subagent, depth-capped and budgeted | parallel or isolated work; a cleaner parent window | no | **B6.1** (D-T4: cap 2) | as planned | — |
| **Agent profiles** (a named definition: prompt addendum, model, allowed tools, policy profile). Claude Code: `.claude/agents/*.md`; opencode: `agent` entries or `.opencode/agent/*.md` with `mode: primary\|subagent` | "a reviewer that can only read", "an explorer on a cheap model" | no | B6.1 does not say whether `agent.spawn` takes a profile | **fold into B6.1's scope** as data: `{prompt, model?, tools?, policyProfile?}`. **This is the same object as plan mode (2.3)**: opencode's plan mode IS an agent profile. One concept, "profile", serves plan mode, read-only reviewers and subagent types. File-backed profiles come later, like custom commands | medium (inside B6.1) |
| Delegate to another harness (the master) | route work to an already-paid subscription | no | **B6.2** (§24.7) | as planned | — |
| Background tasks (long shell output while the agent continues) | a dev server or test run without blocking | **yes** — `shell.start` yields a handle, `shell.read` polls later (D-T2) | done | — | — |

### 2.7 MCP, web, browser, ALM

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| MCP client (stdio + remote), tools namespaced `mcp__<server>__<tool>` | the ecosystem's tools without writing them | no | **B6.3** | as planned. **Add to its scope:** (1) where servers are DECLARED (the project/user config below); (2) OAuth for remote servers (opencode ships `mcp auth/logout/debug`); (3) a `list/add` CLI verb | medium (the additions) |
| MCP servers other harnesses already have configured | reuse what the machine already runs | — | — | post-M1, opt-in import. The product already reads other harnesses' MCP config (`mcp-list.ts`); **import, never link**, so the native harness keeps working if that file changes | small |
| ALM tools (claim, update, comment, attach evidence) | the agent works the board | no — `task.plan` is deliberately in-run only (it cannot import `packages/server`, D23) | **B6.5** | **Design note for B6.5:** the product already exposes the whole board as MCP tools (`packages/mcp`: `agentistics_task_*`). The cheapest D23-respecting path is that **the host registers its own agentistics MCP server with the native session through B6.3**, rather than a second implementation of the board's write path inside the runtime. Worth deciding before B6.5 is briefed | — |
| `web.fetch` / `web.search` | read documentation and search | no | **B6.7** | as planned | — |
| Browser | UI verification | no | **B6.4** (D-T7, D12) | as planned | — |
| Git write verbs (`git.commit`/`branch`/`worktree`) | attributable git acts, not anonymous shell | no — read verbs only | decided **D-T6: v2**, and **no board item exists** | post-M1 — **create the item** so D-T6 does not live only in a spec | medium |

### 2.8 Context

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| Automatic context management | long sessions keep working and keep their facts | no | **B4-CTX** ("an index, not a summary" — decided, not re-opened here) | as planned | — |
| **A floor until B4-CTX ships** | a long session fails at the provider today (§1.4) | no — message-count trim only | none | **M1, deliberately minimal.** It is not a design: (a) the trim budget is counted in TOKENS against `resolveContextWindow`, not in messages; (b) a provider "input too long" failure becomes a sentence naming what to do (`/new`, or resume after the trim), never a raw error. B4-CTX replaces both, as B4 §4 already says it replaces the 200-message rule | small |
| Manual `/compact` | the person forces a compaction | no | — | **never, as a summary.** CTX §6.5 rejects model-written summaries. If B4-CTX's measurement wants a manual trigger, it is "close the current step now" (the boundary rule, CTX §6.1), and it belongs to CTX | — |
| `/context` — what is in the window and what it costs | makes the budget visible | no | **CTX §9** (`context.manifest` per call) | the command is post-M1 and reads CTX's manifest. Before CTX, it shows the gauge (2.2) | small |

### 2.9 Editors and other surfaces

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| **The terminal as a CLIENT of the server** (web and terminal see the same live session) | objective C: one session, many windows | **no** — the CLI hosts its own hub; the web cannot watch it (B4 §8) | none | **decide before the B4.4 follow-up.** Recommended: `agentop code` drives through `/api/runtime/*` + the stream when `agentop server` is running (it already exists and is guarded), and hosts in-process only when it is not, saying so on its start line. That is the VS Code extension's rule ("a client of the server, never more"), applied to the terminal | medium |
| VS Code: list / open / answer native sessions | the fourth front door | no — the extension speaks `/api/fleet` (tmux sessions) only | **A4.5** is METRICS from the journal, not native chat | post-M1 — a view onto `/api/runtime/sessions` with approvals as the SAME option list the extension already draws for tmux dialogs | medium |
| Open the agent's proposed diff in the editor | review an edit where you read code | no | none | post-M1, after the item above | medium |
| **ACP server** (an editor such as Zed drives the native harness; `opencode acp` exists) | editor-agnostic integration | no | **A5.4** is the opposite direction (agentop reading harnesses it spawned) | post-M1 — one more window onto the same runtime | medium |
| LSP diagnostics after an edit | the model sees the type error it just caused | no | none | post-M1, opt-in. Heavy: a language-server lifecycle per workspace. `shell.start` running the project's own type check covers most of it today | medium |
| Formatter after an edit | edits land formatted | no | none | post-M1 — it IS hook case (c) in 2.4. One mechanism, not two | — |
| **Headless / scripted mode with structured output** (`claude -p --output-format stream-json`, `codex exec --json`, `opencode run`) | CI, scripts, and a native session driven by another program | partial — no tty means one prompt then text to stdout | none | post-M1 — `--json` emitting the hub frames already defined (B4.3). It makes the native harness drivable by the session manager and by B6.2's delegation in reverse | small |
| Desktop notification when a native session waits on a person | the person is not watching the terminal | no for native; the product has `agentop events` for tmux sessions | none | post-M1 — route the hub's `ask` frames into the existing event channel. **Same frontier: an event carries facts, never an action** (`events-frontier.test.ts`) | small |
| Image / screenshot input | "look at this error" | partial — `AttachmentRef` exists in the records; no surface attaches | UI.3 (web chat) may | post-M1 — per provider, capability-gated like any other capability | medium |

### 2.10 Configuration and collaboration

| Feature | What it solves | Today | Planned | Recommendation | Size |
|---|---|---|---|---|---|
| **Project + user configuration file** (Claude Code's settings hierarchy, Codex `config.toml` + profiles, Gemini `settings.json`, opencode `opencode.json` deep-merged global → project) | one place for: default model/provider, permission rules, MCP servers, after-edit commands, instruction files, skills dirs | no | none | **post-M1, first wave** — ONE loader, `~/.agentistics/…` (user) and `.agentistics/settings.json` (project), carrying the permission layers (2.3, with the trust rule), MCP declarations (B6.3), after-edit commands (2.4c) and the default model (so `--model` stops being required: B4 §8 made it required because "guessing one is a billing decision", and a setting the PERSON wrote is not a guess). Validate strictly and refuse in words, like opencode does | medium |
| Folder trust | a cloned repository cannot configure the agent that reads it | no | none | part of the item above. Without it, the project layer is an attack surface | (inside) |
| Several windows on one session | pair on one session | **yes** — B4.3 (hub, FIFO, first-answer-wins asker) | done | — (the terminal-as-client row in 2.9 is what finishes it) | — |
| A public share link for a session (opencode `share`) | show a colleague | no | — | **never.** D10 keeps a shared session local-only, members never push chat, and a public URL to a transcript is exactly the off-machine copy CTX §8.3 forbids | — |
| A cheap "small model" for side work (titles, summaries) | cost | no | — | **never, for now.** Titles are deterministic (2.1) and summaries are rejected (CTX §6.5). Revisit only if something that needs a model appears | — |

---

## 3. Overlaps — what this matrix is careful NOT to duplicate

- **B4-CTX.** This matrix does not touch the "index instead of summary" decision. The context row it
  adds (2.8, the floor) is what B4 §4 already calls "B4 only keeps it bounded", with the unit
  corrected from messages to tokens. B4-CTX replaces it wholesale. The gauge and `/context` read the
  numbers CTX will produce, and produce none of their own.
- **B6.6 memory vs instruction files.** An `AGENTS.md` is text the person wrote. Memory is facts
  derived or noted, with provenance and supersession (§24.6). Putting instruction files into B6.6
  would give static text a supersession model it does not need, and would delay it to B6. They
  stay apart.
- **Hooks vs the policy engine vs the event channel.** See 2.4. The only new mechanism proposed is
  "a command after an edit", declared in the config.
- **D9 plugins.** Unchanged. MCP carries the "add a tool" demand.
- **B4.3 multiplayer.** Done. The one open piece is the terminal-as-client row (2.9).
- **UI.6.** Every row with a look ("which commands, which keys, how the prompt/diff/gauge looks")
  hands the look to UI.6 and keeps only the functional seam here.

---

## 4. Proposed new items (for the leader to decide)

In the order the owner would feel them. Groups are suggestions. **H** is a new group ("Harness
basics"), proposed because none of these fits B4-CTX or B6, and all of them are about the
harness's own seams rather than a new capability.

| # | Title | Group | Size | When |
|---|---|---|---|---|
| H1 | System prompt: identity + environment block + tool conventions, cacheable | H (or B4) | medium | **M1** |
| H2 | Load `AGENTS.md` (workspace root → cwd chain); `CLAUDE.md`/`GEMINI.md` as an opt-in | H | small | **M1** |
| H3 | Command registry in `packages/runtime` (data + host handlers), shared by the TUI and the web composer | H, paired with the B4.4 follow-up | medium | **M1** (after UI.6 names the commands) |
| H4 | Undo: expose `checkpoint.restore` (last run / session) + persist it through the content store | H | small | **M1** |
| H5 | Context floor until B4-CTX: a token-counted trim + a sentence on a provider "input too long" | H (explicitly replaced by B4-CTX) | small | **M1** |
| H6 | Per-run line (tokens, cost, cache share) + the context gauge for native sessions, reusing `contextFraction` / `resolveContextWindow` | H (look: UI.6) | small | **M1** |
| H7 | Deterministic session title from the first prompt (`sessionLabel` rules) | H | small | **M1** |
| H8 | Audit event for creating and driving a native session | H | small | **M1** |
| H9 | Decide and build: `agentop code` as a CLIENT of `agentop server` when it runs, in-process host otherwise | B4 (the B4.4 follow-up) | medium | **decide before UI.6's output is built** |
| H10 | Configuration loader (user + project) with FOLDER TRUST: permission layers, default model, MCP declarations, after-edit commands | H | medium | post-M1, first wave |
| H11 | Policy profiles: plan/read-only and accept-edits, as policy layers (no new tool; the floor never lifts) | H | small | post-M1, first wave |
| H12 | Skills: `.agentistics/skills` + `skill.load` + descriptions in the system prompt; `~/.claude/skills`/`~/.agents/skills` opt-in | B6 (or H) | medium | post-M1, first wave |
| H13 | Agent profiles as data inside `agent.spawn` (the same object as H11's profiles) | **B6.1 scope** | medium | with B6.1 |
| H14 | MCP additions: declaration in H10's config, OAuth for remote servers, `list/add` verb | **B6.3 scope** | medium | with B6.3 |
| H15 | Git write verbs (D-T6 v2) — the item does not exist yet | B6 (or B3 v2) | medium | post-M1 |
| H16 | `--json` headless output of the hub frames | H | small | post-M1 |
| H17 | Native `ask` frames into the existing `agentop events` channel (desktop notification) | H | small | post-M1 |
| H18 | Loop guard: Nth identical tool call becomes an ask | H | small | post-M1 |
| H19 | Custom commands (markdown template + `$ARGUMENTS`) and `/init` as a built-in template | H (after H3) | small | post-M1 |
| H20 | `/add-dir` as a session-scoped `pathGlob` rule | H (after H3) | small | post-M1 |
| H21 | Fork and export a session (export honours `sensitive`) | H | small | post-M1 |
| H22 | VS Code: a view onto native sessions (`/api/runtime`), approvals as the existing option list | new group or A4 | medium | post-M1 |
| H23 | ACP server for the native harness | new group or A5 | medium | post-M1 |
| H24 | Change model mid-session, same provider only | H | medium | post-M1 |

**The B6.5 note** (2.7) is a design decision, not an item: brief B6.5 as "register the host's own
agentistics MCP server with the native session through B6.3" before writing a second board write
path.

**What M1 costs:** H1–H8 add up to two medium items and six small ones, plus the H9 decision. That
is the whole distance between "a loop that runs" and "a harness a person can use for an afternoon".
The breadth in the rest of the table (skills, profiles, config, MCP) is real, but it is post-M1 and
mostly one or two modules each. The native harness is not small in its core: its policy, journal,
provenance and sessions are stricter than the references'. It is thin at its seams.

---

## 5. Deliberately never

| Feature | Why not |
|---|---|
| A mode that lifts the deny floor ("yolo") | the floor is the one guarantee that holds with no sandbox (D-T5); profiles cover the legitimate need |
| Model-written compaction summaries / a manual `/compact` summary | rejected by the owner in CTX §6.5 |
| A public share link for a session transcript | D10 (local-only), CTX §8.3 (nothing leaves the machine by default) |
| A "small model" for titles/summaries | deterministic titles; no summaries; nothing else needs one yet |
| A generic user hook system that can veto a tool | a second policy engine the journal could not attribute a decision to (2.4a) |
| In-process plugins now | D9: contract now, loader on demand |

---

## 6. Stated limits of this research

- The Claude Code / Codex / Gemini rows come from the public documentation **as known up to
  2026-06**, not re-fetched on 2026-09-28. Each is a stable, widely documented feature. Before any
  of them becomes a spec, re-read the vendor's page and date the check.
- opencode was read from its installed binary's own output (`--help`, `debug config`, `debug agent
  plan`, `debug skill`), which reflects the version installed on this machine.
- openclaude was not read (§0).
- The size estimates are this document's, on the board's ruler. The briefing session of each item
  should re-estimate against the code it actually touches.

---

## 7. Addendum (2026-09-28, evening) — what became an item, and where

The leader (7b1095709e) reconciled this matrix and the B8 spec
(`2026-09-28-runtime-b8-catalogue.md`) into board items on task `t-e1dea7cd6f`. The table below
points each proposal at its item, so this document can serve as the source for them. The item on
the board is authoritative: its title, group and status can change after this was written.

### 7.1 The H-list of §4

| Proposal | Item | Group |
|---|---|---|
| H1 system prompt | **B4.5 H1-lean** `s-f75a63e390` (M1, host facts only, pending the owner's yes) + **H1-full** `s-26960c3c0f` | B4 / B8 |
| H2 `AGENTS.md` | H2 `s-007e34c62c` | B8 |
| H3 command registry | B8.5 `s-54fd1ee14b` (`/review` is an acceptance criterion there, not an item) | B8 |
| H4 undo | H4 `s-762c0abe92` | B8 |
| H5 context floor | H5 `s-b66d4d5649` (replaced by B4-CTX) | B8 |
| H6 per-run line + gauge | H6 `s-b3484437e4` | B8 |
| H7 title | H7 `s-b4c1f3882e` | B8 |
| H8 audit | H8 `s-15bea06f05` | B8 |
| H9 terminal as client / server hosts native sessions | **B4.6** `s-e50398b96f` (needs its own spec before implementation) | B4 |
| H10 config loader + folder trust | B8.2 `s-0ced5a6168`, B8.3 `s-915d3dcc37`, B8.4 `s-a7a41142ee` | B8 |
| H11 permission profiles | B8.4 `s-a7a41142ee`; the three built-ins alone, with no catalogue, as **B4.7** `s-8f04a093b5` (unblocks the TUI's CD-15) | B8 / B4 |
| H12 skills | B8.6 `s-87d93c00a7` | B8 |
| H13 agent profiles | B8.7 `s-f3f422e2e2` (the contract handed to B6.1) | B8 |
| H14 MCP declarations/OAuth/verbs | B8.8 `s-7277bad6e1` (extends B6.3) | B8 |
| H15 git write verbs (D-T6) | H15 `s-7003396f13` | B8 |
| H16 headless `--json` | H16 `s-21c914b57b` | B8 |
| H17 desktop notification when a native session waits | H17 `s-c4ce49fa17` | B8 |
| H18 loop guard | H18 `s-e8f3cbc626` | B8 |
| H19 custom commands + `/init` | B8.5 `s-54fd1ee14b` | B8 |
| H20 `/add-dir` (and opencode-style references) | H20 `s-ab5b74028a` | B8 |
| H21 fork / export | H21 `s-1660f1f61a` | B8 |
| H22 VS Code native sessions | H22 `s-fa9f017edd` (depends on B4.6) | B8 |
| H23 ACP server | H23 `s-00565da376` | B8 |
| H24 model change mid-session (same provider) | H24 `s-e6225d7312` | B8 |
| LSP diagnostics (§2.9, no H-number) | H25 `s-dffd7446d2` | B8 |
| installer / lockfile (B8 spec §7) | B8.10 `s-2e646461c8` (source still the owner's C8) | B8 |
| after-edit steps | B8.9 `s-ac0172c6e9` | B8 |

### 7.2 Second research round — gaps found after §2, verified in code the same day

| Finding | Evidence at `origin/feat/runtime-sessions` | Item |
|---|---|---|
| No way to request extended reasoning or an effort level; thinking blocks are only carried raw | `loop/loop.ts:265`, `provider/client.ts:92` | **B9.1** `s-a087dff5c1` |
| No image part in the provider message shape; a pasted screenshot cannot be sent | `provider/client.ts` (no image part type) | **B9.2** `s-19c106fe17` |
| Rate-limit headers ARE captured (`anthropic-ratelimit-*`, `x-ratelimit-*`) and shown to nobody | `provider/anthropic/raw.ts:40`, `provider/openai-compatible/raw.ts:62` | **B9.3** `s-602094a20b` |
| The group | B9 · provider capabilities | `s-35ed99c910` |
| Code review mode (`/review`, Codex and Claude Code) | — | acceptance criterion of B8.5, no item |
| External editor for a long prompt, prompt-history search, `/copy` of the last reply | not in `2026-09-28-harness-tui-design.md` | passed to the TUI design session by the leader; no item here |
| A machine/administrator policy layer (managed settings in the references); `rules.ts` models it and nothing reads it | `policy/rules.ts` (machine → user → project) | recorded on B8.4 as a known gap; probably an Enterprise conversation |

### 7.3 Two dependencies the board did not show, now items

- **The server hosting native sessions** (the B4 spec §8 stated limit) had no owner, and the TUI's
  sessions parity (P3), the VS Code view (H22), the web watching a terminal-driven session, and
  native sessions in `/api/fleet` all depend on it. It is now **B4.6**.
- **The TUI's CD-15 (permission mode, P2)** depended on B8.4, which is post-M1. **B4.7** is the
  deliberate slice (the three built-in profiles, no catalogue) that unblocks it without pulling B8.4
  forward.

### 7.4 Not an item yet

- **The owner's idea: suggest filing a session under an ALM task.** Checked against the references:
  it is not on opencode's surface (config, agents, skills, plugins, read from its binary), nor in the
  public documentation of Claude Code, Codex or Gemini as known to this session. It is a genuine
  differentiator. Two notes for its scope, not a decision:
  - For NATIVE sessions the signal is exact and cheap. The journal already holds the tools, the
    files touched, the duration and every `task.plan` call; a multi-step `task.plan` in a session
    with no `taskId` is the strongest sign of a delivery.
  - For external sessions the same signal comes from the `SessionMeta` the product already computes.

  The offer must be a FACT on the event channel ("this session looks like a delivery; file it?"),
  never an automatic creation. Waiting for the leader's timing.
- **The owner questions** C8 (where installable entries come from) and C9 (system-prompt content and
  language) stay open. The leader is taking them to the owner.
