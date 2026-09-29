# MCP coverage — every Agentistics capability reachable by Nay, behind gates

**Board task:** t-086a67beb0 · **Related:** t-3648b62bee (Jarvis), t-35a89395fe / t-e1dea7cd6f
(the open-core split and the runtime) · **Status:** design, nothing implemented; technical decisions recorded 2026-09-29 (§7) · **Date:** 2026-09-29

The owner wants Nay (the dashboard chat) and later Jarvis (voice) to be able to do everything a
person does in Agentistics through the MCP. This spec covers five things:

- the capability map: what exists today and what is missing (§2);
- the tools to add, each with a risk class (§3);
- the safety gates (§4);
- defects found along the way (§5);
- a phased plan of board items (§6), with the owner's decisions listed apart (§7).

---

## 1. Where we start (measured on `origin/dev` @ 340637af)

- **The transport is stdio only** (`agentop mcp`). It reaches the server over plain HTTP to
  `AGENTISTICS_API` (default `http://localhost:47291`).
  - Every call is a bare `fetch` with no credential.
  - `agentop server` registers it for Claude Code, Codex, Gemini and Copilot on every start.
- **There are 44 tools in `packages/mcp/agentistics-mcp.ts`:**
  - **ALM:** 17 tools (tasks, statuses, comments, subtasks, links, blockers, next, claim, activity,
    edit, session filing, delete).
  - **Session groups:** 3 tools.
  - **Metrics:** 6 tools (summary, harnesses, projects, historical sessions, costs, repos).
  - **Layouts:** 8 tools.
  - **PDF export URL:** 1 tool.
  - **Tags:** 2 tools, read-only.
  - **Team:** 2 tools, read-only.
- **The MCP has no gate of any kind.** Every tool, including `agentistics_task_delete`, runs on the
  first call. There is no risk classification, no audit and no notion of who called.
- **There is no fleet control at all.** No tool reads the live fleet, prompts a session, starts one,
  or kills one. The web workspace, the cockpit, the VS Code extension and the CLI all can.
- **The engine boundary is decided (D-1, §7), though the code has not moved yet.**
  - Today every package is FSL-1.1-ALv2 (`LICENSING.md`), and no "engine interface" type exists.
  - **CLOSED:** `packages/runtime`, `server/integrations` and live ingestion.
  - **PUBLIC:** the journal, projections, `core/canonical` and the device-side E2E crypto.
  - MCP tools that drive the engine go through the engine interface (§3.13).
- **Against a central, the MCP cannot authenticate.** The auth gate requires an account session
  on every `/api/*` outside `AUTH_PUBLIC`, and the MCP sends no credential. Today it is
  effectively useless there (decision **D-6**: an agent token, P4.1).

## 2. Capability map

Legend:
- ✅ covered.
- ◐ partly covered.
- ✗ no tool.
- **N** deliberately NEVER through the MCP (§3.14).

| Domain | Product surface (route or CLI) | MCP today |
|---|---|---|
| Live fleet: list, state, attention, verbs | `GET /api/fleet`, `/snapshot` | ✗ |
| Session chat, subagents, workflows, artifacts, skills, PRs | `GET /api/fleet/{chat,subagents,workflows,step,artifacts,skills,skill,prs}` | ✗ |
| Session verbs (prompt, approve, rename, note, task, kill, resume, interrupt, cycleMode, rewind, sendNow, broadcast, reopenFell, deleteTask) | `POST /api/fleet/act` | ✗ |
| Start a session | `GET/POST /api/fleet/new`, `/api/fleet/spawn` | ✗ |
| Fan out a batch of sessions | `agentop session batch` (CLI only) | ✗ |
| Reopen a whole task | `agentop session open` (CLI only) | ✗ |
| Attach, raw keystrokes | `/api/fleet/attach`, WS `/api/fleet/input` | **N** |
| Repository explorer: read | `GET /api/fleet/tree*` | ✗ |
| Repository explorer: write | `PUT/POST/PATCH/DELETE /api/fleet/tree/*` | **N** |
| Utility shell | `/api/shell/*` | **N** |
| Session folders | `/api/session-groups*` | ◐ (no nesting, no ungroup) |
| Historical sessions and metrics | `/api/data` | ◐ (no date range, no single-session detail) |
| Pricing, rates, unpriced models | `/api/pricing`, `/api/rates` | ✗ |
| Live processes, hardware | `/api/live-sessions`, `/api/hardware-resources` | ✗ |
| Tasks / ALM | `/api/tasks*`, `/api/task-files*` | ◐ (no move, no files, no share, no central board) |
| Tags | `/api/tags*` | ◐ (read only) |
| Repositories | `/api/data` → repoStats | ✅ |
| Team: status, members | `/api/team/status`, `/members` | ✅ |
| Team: push, test, connections, sharing rules, proposals | `/api/team/{push-now,test-connection,connections*,proposals}` | ✗ |
| Central admin (tokens, repos, IAM, config) | `/api/team/{tokens,repos,config}`, `/api/iam/*` | **N** |
| Central relay of a member's fleet | `/api/team/machine-fleet[/act]` | ✗ |
| Backup | `/api/backup/*` | ✗ |
| Restore | `/api/backup/restore/*` | **N** (the list is readable) |
| Events: inbox, subscriptions | `agentop events …` (CLI only) | ✗ |
| Notifications | `/api/notifications` | ✗ |
| Providers and models | `GET /api/provider`, `/:id/models`, `POST /:id/test` | ✗ |
| Provider credentials | `PUT/DELETE /api/provider/:id` | **N** |
| Preferences: benign keys (lang, currency, theme, costBasis, sounds) | `PUT /api/preferences` | ◐ (layouts only) |
| Preferences: security switches (chat/shell/editor/remote-session consent, archive, share mode) | `PUT /api/preferences` | **N** |
| Env config | `/api/config*` | **N** |
| Billing plan timeline | preferences | ✗ |
| Layouts | preferences | ✅ |
| MCP servers | `/api/mcp/{servers,check,tools}` | ✗ |
| MCP install, replace | `/api/mcp/{install,replace}` | **N** |
| Native runtime: journal, provider try | `agentop journal`, `agentop provider try` (CLI only) | ✗ |
| Version | `GET /api/version` | ✗ |
| Upgrade | `POST /api/upgrade` | ✗ |
| Lifecycle (server, central up/down, restart, autostart, hooks install) | CLI only | **N** in v1 (**D-5**) |
| Arbitrary exec, chat spawn | `/api/exec`, `/api/chat-tty`, `/api/claude-chat` | **N** forever |

## 3. Proposed tools

### Risk classes

The brief asks for three classes. One refinement makes Jarvis usable: the **standing allowance**
(§4.4).

- **R · read.**
  - Runs freely.
  - Output that carries text written by someone other than the owner (session chat, transcripts,
    comments, task detail) is wrapped as untrusted data (§4.8).
- **W · reversible write.**
  - Runs freely, and is audited.
  - "Reversible" means the owner can undo it with one more call: configuration, labels, filing,
    board moves.
- **D · destructive, spending, disclosing or escalating.**
  - The MCP has **no executor** for these. It can only file an **intent**. A person approves it
    through a human channel, and then the server executes it (§4.2).
  - A class is decided by the WORST thing the call can do:
    - destroys work;
    - starts a model turn or a process (money);
    - sends data off the machine;
    - widens what an agent may do.
- **N · never through the MCP.**
  - Credentials, identity and IAM.
  - Raw keystrokes and raw shells.
  - Anything that flips the gates that constrain the agent.
  - Anything that installs code.

Convention:
- Every new tool is `agentistics_<noun>[_<verb>]`, like the existing ones.
- "Route" is what the tool calls. **new** marks a route this spec adds.
- **D** tools call `POST /api/agent/intents` and never the action route.

### 3.1 Fleet: read (R)

| Tool | Inputs | Output | Route |
|---|---|---|---|
| `agentistics_fleet` | `filter?` (state, harness, task, project), `limit?` | the rows exactly as `/api/fleet?view=1` reduces them, including `enabled` verbs and refusal sentences | `GET /api/fleet?view=1` |
| `agentistics_fleet_session` | `session` (id, conversation id, or title) | one row plus `lastLines`, `dialogOptions` and the approval tail | `GET /api/fleet/snapshot` (filtered) |
| `agentistics_session_chat` | `session`, `limit?` (turns, default 20) | turns, untrusted-wrapped | `GET /api/fleet/chat` |
| `agentistics_session_artifacts` | `session`, `kind?` (files, commands, subagents, workflows, prs) | the aside's lists | `GET /api/fleet/{artifacts,subagents,workflows,prs}` |
| `agentistics_session_skills` | `session` | skills available to that session | `GET /api/fleet/skills` |
| `agentistics_spawn_options` | `cwd?` | harnesses, models, efforts, project search results with true totals | `GET /api/fleet/new` |
| `agentistics_repo_tree` | `session`, `path?`, `query?` | directory listing or search hits; a file's text truncated | `GET /api/fleet/tree*` (and the `editorEnabled` gate applies) |

### 3.2 Fleet: act

`session` resolves the way every surface resolves it: through the server, never in the MCP. Each
**D** tool requires a `reason` (free text, shown to the person).

| Tool | Class | Inputs | Server verb | Why this class |
|---|---|---|---|---|
| `agentistics_session_rename` | W | `session`, `label` | `act:rename` | label only |
| `agentistics_session_note` | W | `session`, `text` | `act:note` | |
| `agentistics_session_file` | W | `session`, `task` | `act:task` | the same filing `agentistics_task_session` does |
| `agentistics_session_interrupt` | W | `session` | `act:interrupt` | hands the turn back; ends nothing |
| `agentistics_session_send_now` | W | `session` | `act:sendNow` | releases a queued prompt already typed |
| `agentistics_session_prompt` | **D** (allowance-eligible) | `session`, `text` | `act:prompt` | starts a model turn = money |
| `agentistics_session_broadcast` | **D** (allowance-eligible) | `sessions[]`, `text` | `act:broadcast` | N turns |
| `agentistics_session_resume` | **D** (allowance-eligible) | `session` | `act:resume` | starts a process |
| `agentistics_session_start` | **D** (spawn budget) | `harness`, `cwd`, `prompt?`, `model?`, `effort?`, `task?`, `subtask?`, `group?` | `POST /api/fleet/new` | new billable assistant |
| `agentistics_session_batch` | **D** (spawn budget) | `task`, `sessions[] {harness, prompt, cwd?, model?}` | **new** `POST /api/fleet/batch` (the CLI's `session batch`, one admission for the batch) | fan-out |
| `agentistics_task_reopen` | **D** (spawn budget) | `task` | **new** `POST /api/fleet/reopen-task` (the pure `task-reopen.ts`) | N processes |
| `agentistics_session_approve` | **D**, never allowance | `session`, `option` (number, read off the screen) | `act:approve` | grants a session power; the events frontier forbids an agent approving for a person |
| `agentistics_session_mode_next` | **D**, never allowance | `session` | `act:cycleMode` | the cycle passes through `accept edits` and `auto`: escalation |
| `agentistics_session_rewind` | **D** | `session`, `prompt`, `occurrence?` | `act:rewind` | destroys the conversation's tail |
| `agentistics_session_kill` | **D** | `sessions[]` | `act:kill` (one per id) | destroys a live process |
| `agentistics_sessions_reopen_fallen` | **D** (spawn budget) | none | `act:reopenFell` | N processes |

Raw keystrokes (`/api/fleet/input`), attach, the utility shell and repository-explorer writes
are **N**. A coordinator that needs to type into a screen is doing a person's job, and a model
writing into another session's worktree bypasses that session's own permission prompts.

### 3.3 Session folders

These extend `agentistics_session_group_edit`:

- **`action: "parent"` (W)**, with `group` and `parent`. It calls
  `POST /api/session-groups/:group/parent`, which gives nested folders.
- **`action: "ungroup"` (W)**, with `session`. It calls `POST /api/session-groups/ungroup`.

The existing `delete` stays **W**: deleting a folder deletes no session.

### 3.4 Metrics (R)

| Tool | Inputs | Output | Route |
|---|---|---|---|
| existing six | **add** `from?`, `to?` (yyyy-MM-dd), `project?`, `repo?`, `tag?` | the same shapes, now range-scoped through the same day rule the dashboard uses (`sessionDaySlice`) | `GET /api/data` |
| `agentistics_session_detail` | `session` (id or conversation id) | one `SessionMeta`: `agentMetrics`, `daily`, compaction, skills, context gauge | `GET /api/data` (filtered) |
| `agentistics_pricing` | `model?` | rate, origin (official / community / builtin), the unpriced models this machine used | `GET /api/pricing`, `/api/rates` |
| `agentistics_live_processes` | none | assistants running now, or the `LiveUnavailableReason` sentence, never an empty list | `GET /api/live-sessions` |
| `agentistics_hardware` | none | CPU, RAM and pressure; the admission-control input | `GET /api/hardware-resources` |
| `agentistics_compare` | `from?`, `to?` | `computeHarnessSummaries` per harness | **new** `GET /api/compare`, which wraps the pure function the web already exports |

**Moving the range arithmetic to the server** is a real item (P1.4). `sliceSession` and
`computeHarnessSummaries` live in `packages/web` today, and the MCP must not re-implement them.
They move to `@agentistics/core` so the server can answer with the dashboard's own numbers.

### 3.5 Tasks / ALM

| Tool | Class | Route |
|---|---|---|
| `agentistics_task_move` (`ref`, `before?`, `after?`, `status?`) | W | `POST /api/tasks/:ref/move` |
| `agentistics_task_file_add` (`ref`, `name`, `text` or `base64`) | W | `POST /api/tasks/:ref/files` |
| `agentistics_task_file_remove` | W | `DELETE /api/task-files/:id` |
| `agentistics_task_share` (`ref`, `shared`) | `shared:true` is **D** (disclosure to a central); `false` is W | `POST /api/tasks/:ref` |
| `agentistics_team_tasks` (central only) | R | `GET /api/team/tasks` |
| **existing** `agentistics_task_delete` | **re-classed D** | through an intent |

`agentistics_task_status_edit` with `remove` stays W. The status vocabulary is configuration, and
the server already refuses to remove a protected status.

### 3.6 Tags

| Tool | Class | Route |
|---|---|---|
| `agentistics_tag_create` (`name`, `color?`, `sources[]`, `window?`, `sharedWith?`) | W; D when `sharedWith` is non-empty (disclosure) | `POST /api/tags` |
| `agentistics_tag_edit` | W; D when it widens `sharedWith` | `PATCH /api/tags/:id` |
| `agentistics_tag_delete` | W (a tag is a saved filter; no data goes with it) | `DELETE /api/tags/:id` |

### 3.7 Team (member side)

| Tool | Class | Route |
|---|---|---|
| `agentistics_team_push_now` | W | `POST /api/team/push-now` |
| `agentistics_team_test` (`connection`) | R | `POST /api/team/connections/:id/probe` |
| `agentistics_team_proposals` | R | `GET /api/team/proposals` |
| `agentistics_team_rules` (`connection`, `mode`, `sources`) | computed with the pure `planProposalApply` arithmetic: narrowing is **W**, widening is **D** | `PATCH /api/team/connections/:id` |
| `agentistics_team_leave` (`connection`) | **D** | `POST /api/team/leave-central` |

- Adding a connection carries a token, so it is **N**.
- Everything under central administration is **N** (§3.14).
- The **central relay** tools, `agentistics_machine_fleet` (R) and
  `agentistics_machine_session_act` (D), land in P4 (**D-6**).

### 3.8 Backup

| Tool | Class | Route |
|---|---|---|
| `agentistics_backup_status` | R | `GET /api/backup/status`, `/github` |
| `agentistics_backup_run` (`layers?`) | W if local only; **D** if it pushes to GitHub (leaves the machine) or includes `repos` | `POST /api/backup/run` |
| `agentistics_backup_config` (schedule, layers) | W | `POST /api/backup/config` |
| `agentistics_restore_points` | R | `POST /api/backup/restore/list` |

Restore itself is **N**. It overwrites the host's history, and the two-phase resumable flow is a
person's act.

### 3.9 Events and notifications

| Tool | Class | Route |
|---|---|---|
| `agentistics_events` (`cursor?`, `kinds?`, `task?`) | R | **new** `GET /api/events/inbox`: the `events.jsonl` reader `events tail` uses, cursor `offset:seq` |
| `agentistics_event_watch` / `_unwatch` | W | **new** `POST/DELETE /api/events/subscriptions` over `event-subscriptions.json` |
| `agentistics_notifications` (`unread?`) | R | `GET /api/notifications` |
| `agentistics_notification_read` | W | `PATCH /api/notifications` |

`events emit` and `test` are **N**. An agent fabricating a fleet event is exactly what the events
frontier exists to prevent.

### 3.10 Providers and models

| Tool | Class | Route |
|---|---|---|
| `agentistics_providers` | R: configured providers, key PRESENCE (never a key), base URL | `GET /api/provider` |
| `agentistics_provider_models` | R | `GET /api/provider/:id/models` |
| `agentistics_provider_test` | **D** (one live call spends money) | `POST /api/provider/:id/test` |

Setting or removing a key is **N**.

### 3.11 Settings

| Tool | Class | Route |
|---|---|---|
| `agentistics_settings` | R: preferences **redacted by allowlist** (connections, tokens and endpoints never appear) | `GET /api/preferences` |
| `agentistics_setting_set` (`key`, `value`) | W, for a **closed allowlist** only: `lang`, `currency`, `theme`, `costBasis`, `chatSoundId`, `a11y.*` | **new** `PATCH /api/preferences/agent`, which refuses any other key server-side |
| `agentistics_billing_plan` (read, add period, end period) | R / W | preferences through the same new route |

The security switches are **N** by construction: they are not in the allowlist, and the route is
the one that decides. The switches are `chatEnabled`, `shellEnabled`, `editorEnabled`, the
remote-session consent pair, `archiveMode`, and connection `shareMode`/`sources`, which have their
own tool above.

### 3.12 MCP servers

| Tool | Class | Route |
|---|---|---|
| `agentistics_mcp_servers` | R | `GET /api/mcp/servers` |
| `agentistics_mcp_check` (`server`) | W (host): it starts a command the person already configured | `POST /api/mcp/check` |
| `agentistics_mcp_remove` | **D** | `POST /api/mcp/remove` |

Install and replace are **N**: they run new code.

### 3.13 Native runtime and harness

| Tool | Class | Route |
|---|---|---|
| `agentistics_journal_status` | R | **new** `GET /api/runtime/journal` (the `agentop journal status` reader). The journal is PUBLIC, so this is an ordinary route. |
| `agentistics_runtime_metrics` | R (flagged) | `GET /api/runtime/metrics`. Projections are PUBLIC. |
| `agentistics_provider_try` | **D** | through the engine interface: `POST /api/engine/provider/try`. `packages/runtime` is CLOSED. |
| native session run / subagents | **D** | through the engine interface under `/api/engine/*` (below) |

**The engine boundary (D-1).** `packages/runtime`, `server/integrations` and live ingestion are
CLOSED. The journal, projections, `core/canonical` and device-side E2E crypto are PUBLIC. The MCP is
public FSL code, so the rules are:

- **The MCP never imports engine code.** It only ever speaks HTTP. No engine type is ever imported
  into `packages/mcp`, and a lint test asserts that.
- **Engine routes live under one prefix, `/api/engine/*`.**
  - The public server mounts them from the engine interface.
  - The prefix is registered once in `capability-guard.ts` under `localShell`, the way
    `/api/fleet` is, so a new engine route is guarded by having been added.
  - When no engine is present, the prefix answers `engine_absent` in words.
- **The engine's tools come from a manifest.** `GET /api/engine/manifest` returns each tool's name,
  input schema, route and risk class. The MCP builds those tools at listing time.
  - A manifest row still has to fit the public policy table: the classes, the intent gate and the
    `NEVER_ROUTES` list. An engine tool declaring `R` for a route under the D rules is refused, so
    closed code cannot relax a public gate.
  - The engine's D tools go through `POST /api/agent/intents` like every other D tool.
- **Journal and projection reads are ordinary public routes**, not engine routes.

### 3.14 Never through the MCP (a closed list, with reasons)

| Surface | Reason |
|---|---|
| `/api/exec`, `/api/chat-tty`, `/api/claude-chat` | arbitrary process or model on the host; Nay spawning Nay is a loop with a wallet |
| WS `/api/fleet/input`, `/api/shell/*`, `/api/fleet/attach` | raw keyboard or shell = unbounded |
| `/api/fleet/tree` writes | bypasses the target session's own permission prompts |
| `PUT/DELETE /api/provider/:id`, team connection add, `/api/team/tokens*`, `/api/team/repos` writes | credentials |
| `/api/iam/*` writes, `/api/team/{members,config}` writes | identity and escalation; step-up territory |
| the security switches in preferences, `/api/config*` | an agent must never widen its own gates |
| `/api/mcp/{install,replace}`, `agentop hooks install`, `autostart` | installs code or writes outside our directories (a CLAUDE.md rule: an explicit act of the user) |
| restore, `events emit/test` | overwrites history or fabricates facts |
| lifecycle (`server`, `central up/down`, `restart`) | out of v1 (**D-5**) |

`POST /api/upgrade` is **D**, not N. It is a single, well-understood act that a person may want to
trigger by voice. The readback must say that the server, and so this conversation's MCP, will
restart.

---

## 4. The safety gates

### 4.1 One table, and the build enforces it

`packages/core/src/agentToolPolicy.ts` (pure) is a
`Record<AgentToolName, { risk: 'R'|'W'|'D', route, capability?: Capability, host: boolean, central:
'refuse'|'allow'|'only', allowance?: 'prompt'|'spawn'|null }>`. It sits beside `NEVER_ROUTES` (the
§3.14 list with reasons). It is the `HARNESS_CAPABILITIES` pattern: a Record, so a new tool does not
compile until it is classified.

`agentToolPolicy.lint.test.ts` asserts four things:

1. Every tool in `TOOLS` has a row, and every row has a tool.
2. No handler of a `D` tool references any route but `/api/agent/intents`. This is a grep over
   the MCP source, the shape of `tokens.lint.test.ts`.
3. The MCP source never mentions the decide route.
4. No MCP handler calls a `NEVER_ROUTES` entry.

### 4.2 Intents: the MCP proposes, a person decides, the server executes

```
MCP (D tool) ──POST /api/agent/intents {tool,args,actor,reason}──▶ server
  server: validates against the policy row; resolves targets NOW (session → title, cwd, state;
          spawn → harness, model, count, admission verdict); writes the READBACK itself;
          stores {id, argsHash, targetSnapshot, expiresAt, status:'pending'}; notifies surfaces
MCP ◀── {intentId, readback, expiresAt, status:'pending'}
person ──(web card | cockpit | VS Code | voice)──▶ POST /api/agent/intents/:id/decide
  server: re-resolves targets; refuses 'stale' if they changed; executes through the SAME
          function the route uses (runFleetAction, spawn, markTask…); stores the outcome; audits
MCP ──agentistics_intent {id, wait?} (R)──▶ outcome
```

Rules:

- **The readback is the server's words, never the model's.** A person approves what will happen,
  not a paraphrase of it. The readback is EN and PT from a pure `intentReadback.ts`. It names the
  target by its title and directory, and states the count and, for a spawn, the model.
- **An intent is bound, single-use and short-lived.** This is the runtime's own grant rule
  (`packages/runtime/src/tools/grant.ts`: live, spent on use, bound to its subjects), applied
  across a process boundary.
  - The args hash binds the decision to exactly what was proposed.
  - The TTL is 120 s, and 60 s on voice.
  - If the target is not what it was when proposed (the session died, its dialog changed, a
    different session now holds the title), the intent is refused `stale`. This is the re-read
    rule `dialog-choice.ts` already follows.
- **No intent may target its caller.** A session asking to kill, rewind or reprompt itself, or the
  Nay host session, is refused `self_target`.
- **At most 5 intents may be pending per actor.** Past that, the call is refused in words, so a
  looping agent cannot bury a person in cards.
- **Both halves live in the server, in the pure `agent-intents.ts` plus the store
  `~/.agentistics/agent-intents.json` (0600).** Any MCP client can be swapped for another. A gate
  that lives in the client is not a gate.

### 4.3 The human channels

The decide route is fed by the surfaces that already exist:

- **Web.**
  - A notification of code `agent.intent` in the bell and toast opens a modal with the readback and
    **Approve** / **Refuse**.
  - It must build its mobile version in the same change, per the house rule.
  - It sends `channel:'web'`.
- **Cockpit.** A line in the header, beside the waiting counter. `enter` opens the same question.
- **VS Code.** A toast with two buttons, through the extension's existing `api.ts`.
- **Voice** (§4.5).

Each channel has an equal right to decide. The first decision wins; the rest see `decided`.

**Stated limit.** A local server has no authentication. Any process running as the owner's uid can
POST to the decide route, just as it can already run `agentop session kill` directly.

- **What the gate protects against:** a model's mistake, a misheard instruction, and prompt
  injection reaching the model through a transcript. That is the realistic threat.
- **What it does not protect against:** a hostile local process.
- **The mitigations that remain:**
  - The decide route requires a same-origin browser request (Origin allowlist, as
    `wsInputOriginOk` does) or the cockpit's in-process call.
  - The MCP has no tool for it (§4.1).
  - A model that shells out to `curl` is stopped by its own harness's Bash permission prompt. That
    prompt is the gate of that layer, and Nay's chat should not pre-allow `curl` to localhost
    (P2 item).

### 4.4 Standing allowances: what makes coordination possible

Confirming every prompt makes Jarvis useless. Confirming none makes it dangerous. An allowance is
a person-issued, scoped, expiring grant. It is created only through a human channel, never through
the MCP. It is stored with the intents.

```
{ scope: { task?: id, sessions?: ids }, verbs: ('prompt'|'broadcast'|'resume'|'sendNow')[],
  spawnBudget?: n, until: ≤ 60 min, createdBy: channel }
```

- A D tool whose row says `allowance: 'prompt'` and whose targets all fall inside a live allowance
  is **executed at once, and audited as `allowed-by:<allowance id>`**.
- `allowance: 'spawn'` tools consume `spawnBudget`. When the budget is spent, the next spawn
  becomes an intent.
- **Never allowance-eligible:**
  - `approve` (the events frontier);
  - `cycleMode` (escalation);
  - `kill`, `rewind`, task delete (destruction);
  - disclosure (sharing to a central, tag sharing, widening rules);
  - `upgrade`;
  - `provider_test`.

  Each of these is always a fresh person decision.
- An allowance appears on the web and in the cockpit as a revocable chip ("Nay may prompt the 4
  sessions of task X for 38 more minutes"). Revoking it takes effect on the next call.

Voice phrasing: "Coordinate these sessions for half an hour" → Jarvis files an **allowance intent**
→ the person confirms it once → the loop runs.

### 4.5 Voice (Jarvis)

The owner's rule is that destructive or spending actions need spoken confirmation. The PUBLIC shell
owns the whole path. The brain never produces the approval.

1. The shell subscribes to `agent.intent` over the existing notification SSE.
2. It **speaks the server's readback** (TTS), and then a prompt: "Say 'confirmo' to proceed."
3. **High-stakes intents add a challenge.** High-stakes means kill of 2 or more sessions, any
   batch or fan-out, upgrade, or a disclosure. The challenge is a server-issued number, for example
   "say: confirmo sete". A confirmation said out of reflex, or by a TV in the room, then fails.
4. It captures the utterance that **starts after the readback ends**. Speech that overlaps the TTS
   is barge-in, and it **cancels**.
5. STT runs, then a **deterministic matcher** decides. It is not the LLM.
   - It accepts only a closed affirmative set in PT and EN, plus the challenge when required.
   - It refuses on any negation word, a confidence below the threshold, a timeout, or anything
     ambiguous.
   - Refusal is the default.
6. The shell POSTs `decide` with `channel:'voice'`, the matcher's transcript and its confidence.
   The brain learns the outcome through `agentistics_intent`, like any caller.

**Stated limit.** Nothing verifies the speaker, so anyone in the room can say "confirmo". The web
card remains the strong channel. Decision **O-3** (still open, for the owner) asks whether voice
from the phone, through the hub, may decide D intents. Until it is decided, a D intent arriving that
way is refused `needs_screen`.

### 4.6 Audit

- **Local:** `~/.agentistics/agent-audit.jsonl`.
  - It is 0600, append-only and rotated at 10 MB, keeping 3 files.
  - It is needed because `audit.ts` needs Mongo, and a solo machine has no audit sink today.
- **Central:** the same builder feeds `writeAudit` with the new actions `agent.tool` and
  `agent.intent.*`.

Each record carries:

- `at`;
- `actor`: the MCP client's `clientInfo` name and version, plus the optional `actor` argument, plus
  the Nay session id when the chat passes it;
- `tool`, `risk`;
- `targets`: ids only;
- `argsHash`;
- `intentId` and `decidedBy` (channel, and the allowance id);
- `outcome`: `ok`, a refusal code, or `stale` / `expired`.

Prompt text and readback text go through `redactSecrets` and are truncated to 512 characters. The
existing `audit.ts` rules apply: the pure builder redacts secret-shaped fields.

Logging rules by class:

- **R calls** are counted per tool per hour, not logged one by one.
- **W calls** are logged.
- **D calls** are logged at every lifecycle step: proposed, allowed or approved or refused or
  expired, executed.

Attribution is best-effort and says so. One registered MCP serves every Claude session on the
machine, and `clientInfo` alone cannot tell two of them apart. Decision **D-4** adds per-session
identity.

### 4.7 Exposure profile and central

- **Server side.**
  - `POST /api/agent/intents`, `/decide`, the allowances route and the new routes above are
    registered in `capability-guard.ts`: under `localShell` for anything that touches the host, and
    under the existing prefixes wherever one already covers the path.
  - On `public`, every host capability is false. The routes 403, and the MCP lists nothing that
    touches the host.
- **Listing.** A new, read-only `GET /api/agent/manifest` returns the profile, `central`, `CAPS`,
  the preference gates (`editorEnabled` and the rest) and the live allowances.
  - The MCP lists only tools that can work there.
  - The MCP adds one tool, `agentistics_capabilities` (R). It says, in words, what is withheld and
    why ("this machine is a central: the fleet is not reachable here"). An absent tool with no
    explanation is the same failure as a confident zero.
- **Central.**
  - Host tools are refused. `/api/fleet*` is already a 404 there, and the intent routes refuse as
    well.
  - The member-relay tools land in P4 (**D-6**).

### 4.8 Untrusted output

Chat turns, transcripts, comments, task detail, notes and file text come from other models and
other people. Tools returning them wrap that text as
`{"untrusted": true, "source": "...", "text": ...}`. The tool description says the content is data
and never instructions.

This matters more once an agent can act: a transcript saying "kill session X" must not become a
kill. The intent gate is the backstop, and the wrapping is the first line.

---

## 5. Defects found while mapping (to be filed separately; none fixed here)

1. **`POST /api/claude-chat` spawns `claude` on the host and has no `capability-guard.ts` entry
   and no `chatAllowed` check.**
   - `index.ts:3068`.
   - Its siblings `/api/chat-tty` and `/api/chat-harnesses` have both.
   - On a central it is behind the account gate, but it still runs a model on the central host.
   - Security, high.
2. **`PUT /api/config` and `POST /api/config/restore` write the env config with no guard entry.**
   - `PUT /api/preferences` also writes the security switches with no guard.
   - On `lan` without the opt-in, `/api/fleet` is refused but the switch file that governs it is
     writable.
3. **The existing destructive MCP tools run on the first call:** `agentistics_task_delete`, and
   the `delete` action of `session_group_edit` and `delete_layout`. Only the first one is D under
   this spec, and it is re-classed in P1.
4. **The MCP cannot authenticate to a central** (§1), yet its tool descriptions advertise central
   use (`agentistics_team_members`).
5. **`docs/mcp.md` is stale** (analytics-only tool list), and so is `docs/nay.md` ("13 MCP tools").
6. **The `exposure.ts` comment for `mcpAdmin` still names the removed `POST /api/mcp-action`.**
7. **The layout component catalog is a hand-kept mirror** of `componentCatalog.tsx` in the MCP.
   Move it to core, or serve it over a route.

## 6. Phased plan (board items)

Sizes: **S** is under half a day, **M** is 1–2 days. Each item lands with its tests, and each UI
item with its mobile version.

**P0 — close what is open today (no new powers)**

- P0.1 **S** — Guard `/api/claude-chat` (capability-guard `localChat` plus `chatAllowed`). Test in
  `capability-guard.test.ts`. Defect 1.
- P0.2 **S** — Guard `/api/config*`. Decide `/api/preferences` via the allowlist route in P1.5.
  Defect 2.
- P0.3 **S** — Fix the doc drift: `mcp.md`, `nay.md`, the `exposure.ts` comment. Defects 5 and 6.

**P1 — the frame (policy table, manifest, audit, reads)**

- P1.1 **M** — `agentToolPolicy.ts` plus `NEVER_ROUTES` plus the lint test (§4.1). Classify the 44
  existing tools.
- P1.2 **M** — The local agent audit sink (`agent-audit.ts`: pure builder plus 0600 JSONL writer
  with rotation) plus the MCP recording W calls and R counters.
- P1.3 **S** — `GET /api/agent/manifest` plus manifest-filtered `tools/list` plus
  `agentistics_capabilities`.
- P1.4 **M** — Move `sliceSession` and `computeHarnessSummaries` into core. Add `from`/`to`/scope
  to the six metric tools. Add `agentistics_session_detail`, `_pricing`, `_live_processes`,
  `_hardware`, `_compare`.
- P1.5 **S** — `PATCH /api/preferences/agent` (closed allowlist) plus `agentistics_settings`
  (redacted) plus `_setting_set`.
- P1.6 **M** — The fleet read tools (§3.1) plus untrusted-output wrapping (§4.8).
- P1.7 **S** — The fleet W verbs: rename, note, file, interrupt, send-now.
- P1.8 **S** — The folders `parent`/`ungroup`, the ALM gaps (move, files, central board), the
  events inbox route plus `agentistics_events`/`_watch`, and notifications.

**P2 — intents (D becomes possible)**

- P2.1 **M** — `agent-intents.ts` (pure: bind, TTL, stale check, self-target, per-actor cap,
  readback EN/PT) plus the store plus `POST /api/agent/intents`, `/decide`, `GET` plus
  `agentistics_intent`.
- P2.2 **M** — The web approval modal (bell, toast, mobile sheet) plus the `agent.intent`
  notification code.
- P2.3 **S** — Cockpit and VS Code approval surfaces.
- P2.4 **M** — The D fleet tools: prompt, broadcast, resume, start, kill, rewind, approve,
  mode-next, reopen-fallen.
- P2.5 **S** — `POST /api/fleet/batch` and `/reopen-task`, extracted from the CLI, plus their D
  tools.
- P2.6 **S** — Re-class `agentistics_task_delete` to D. Add task share, tag write/share, team rules
  narrow/widen, team leave, backup run (GitHub), provider test, MCP remove, upgrade.
- P2.7 **S** — Nay's chat: no pre-allowed `curl`/`fetch` to localhost in its sandbox settings.
  State the limit in `nay.md`.

**P3 — allowances and voice**

- P3.1 **M** — Standing allowances: the store, the human-only create route, the revocable chip on
  web and cockpit, allowance-aware intent resolution.
- P3.2 **M** — The Jarvis confirmation path in the public shell: readback TTS, post-readback
  capture, the deterministic matcher plus challenge, barge-in cancels. Depends on t-3648b62bee's
  shell.
- P3.3 **S** — The public runtime reads: the journal status route plus tool, and the runtime
  metrics tool.
- P3.4 **M** — The engine interface on the MCP side:
  - mount `/api/engine/*` plus its guard prefix, and the `engine_absent` answer;
  - build tools from `GET /api/engine/manifest`, validating each row against the policy table;
  - the lint test that `packages/mcp` imports no engine code;
  - `agentistics_provider_try` (D) as the first engine tool.

**P4 — the central (D-6)**

- P4.1 **M** — The agent token: a per-account, read-scoped token minted in Settings and stored
  hashed like ingest tokens. The MCP sends it as a Bearer. Read-only tools work on a central.
- P4.2 **S** — The member-relay tools: `agentistics_machine_fleet` (R), and
  `agentistics_machine_session_act` (D, and it also requires the member's own consent switches).
- P4.3 **S** — Per-session actor identity (D-4): agentop injects `AGENTISTICS_ACTOR=<managedId>`
  at spawn, and the MCP forwards it into the audit.

Lifecycle tools are **out of v1** (D-5).

## 7. Decisions

Recorded 2026-09-29. The technical ones were decided by the leader, to whom the owner delegated
them. One stays with the owner.

- **D-1 · The engine boundary (was O-1). Decided.**
  - CLOSED: `packages/runtime`, `server/integrations` and live ingestion.
  - PUBLIC: the journal, projections, `core/canonical` and device-side E2E crypto.
  - MCP tools that drive the engine go through the engine interface: the `/api/engine/*` routes
    and the engine manifest (§3.13), never an import.
- **D-2 · A prompt to a running session is class D (was O-2). Decided.** Standing allowances cover
  it (§4.4).
- **D-4 · Per-session actor identity (was O-4). Decided, as recommended.**
  - Each session agentop starts gets `AGENTISTICS_ACTOR=<managedId>` in its environment, and the MCP
    forwards it.
  - Everything else stays best-effort (P4.3).
- **D-5 · Lifecycle by agent (was O-5). Decided: not in v1.** No service restart, no central up or
  down, no autostart. These stay on the §3.14 N list.
- **D-6 · The MCP on a central (was O-6). Decided, as recommended.**
  - A per-account, read-scoped agent token, stored hashed.
  - Read-only tools first.
  - The member-relay act tool is D and also requires the member's own consent switches (P4).
- **D-7 · Allowance ceiling (was O-7). Decided, as recommended.**
  - At most 60 minutes, with a spawn budget set per allowance.
  - In v1 an allowance never covers `kill`, including the kill of sessions that the same allowance
    spawned.

### Open, for the owner

- **O-3 · Can phone voice (through the hub) approve D actions?**
  - The leader leans NO for v1: a destructive action needs an on-screen confirmation.
  - The spec's recommendation is compatible with that. Voice from the phone may approve only
    allowance intents and W. D intents need the local voice path or a card, and under the leader's
    reading, a card only.
  - Until the owner decides, P3.2 builds the voice matcher for local calls only, and a D intent
    arriving from `channel:'voice'` through the hub is refused `needs_screen`.
