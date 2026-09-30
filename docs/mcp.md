# agentistics MCP Server

The agentistics MCP server exposes agentistics as tools that any MCP-compatible client can call — including Claude Code, Nay (the built-in chat), and any third-party agent that supports MCP. It is no longer analytics-only: besides usage metrics it reads and drives the **task board (ALM)**, files sessions into **session groups**, builds **custom layouts**, and reads **tags**, **repositories** and **team status**.

## What is MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open standard that lets AI models call structured tools defined by external servers. The agentistics MCP server turns the agentistics HTTP API (`/api/data`, `/api/tasks`, `/api/session-groups`, `/api/preferences`, `/api/tags`, `/api/team/*`) into a set of typed tools.

## Starting the MCP server

The MCP server runs as a stdio process. It is **not** a separate HTTP server — it communicates via stdin/stdout with the MCP client (Claude Code, etc.) and makes HTTP calls internally to the agentistics API.

```bash
# agentistics must be running first (provides /api/data)
agentop server
```

**You do not register it by hand.** Every time `agentop server` starts it registers the MCP for
every assistant installed on the machine (Claude Code, Codex, Gemini, Copilot), launching the
installed binary itself:

```bash
# what the server runs for you — the binary serves the MCP over stdio
claude mcp add -s user agentistics -e AGENTISTICS_API=http://localhost:47291 -- /path/to/agentop mcp
```

`agentop mcp` is the MCP server, built into the binary, so the tools an assistant sees always match
the version installed — an `agentop upgrade` updates them with nothing else to do. (A clone of this
repository registers `bun run <repo>/packages/mcp/agentistics-mcp.ts` instead, so a developer runs
the source they are editing.) An up-to-date registration is left alone; a stale one is replaced.

On each boot the server also **removes any other copy of the agentistics MCP** from
`~/.claude.json` — one registered under another name (for example an older `@agentistics/mcp`
installed by hand), or in a project's local scope, which Claude Code prefers over user scope and
which would otherwise keep serving the old tools. Only entries that launch the agentistics MCP are
touched, and each removal is written to the server log. Sessions that were already open keep the
MCP they started with until they are restarted.

The registration runs the assistant CLIs (`claude mcp add`, …) on the **server's** PATH. If
`agentop server` runs as a systemd service whose unit predates the PATH fix, run
`agentop restart server` from a terminal where those CLIs work — the unit is repaired on the way.

### Verify registration

```bash
claude mcp list
# Should show: agentistics  /path/to/agentop mcp
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTISTICS_API` | `http://localhost:47291` | Base URL of the agentistics API server |

## Multi-harness scope

agentistics tracks multiple coding harnesses (Claude Code, Codex CLI, Gemini CLI, Copilot CLI, Antigravity CLI, Kimi Code). The MCP server reads the same `/api/data` endpoint, so by default its numbers reflect the **unified (all-harness)** view.

- **Per-harness filtering:** `agentistics_summary`, `agentistics_projects`, `agentistics_sessions`, and `agentistics_costs` accept an optional `harness` parameter (any harness id — `claude` | `codex` | `gemini` | `copilot` | `antigravity` | `kimi` — or `all`, the default; the enum is `HARNESS_ORDER`, so a new harness appears by itself). When set, the tool scopes its result to that harness only.
- **Comparison:** `agentistics_harnesses` lists every harness present in the data with its sessions, messages, tokens, estimated cost, and last-active date — the quickest way to answer "which harness do I use most / costs most".
- **Caveats** match the dashboard: `currentStreak` is Claude-only (returned as `null` when scoping to a single non-Claude harness); harnesses that don't emit token usage (e.g. Gemini's local files) contribute 0 tokens/cost; the unified/`claude` cost breakdown comes from the Claude-complete stats-cache, while a specific non-Claude harness's cost breakdown is aggregated per-model from its sessions.
- **Per-session cost is priced per model.** Any `estimatedCostUSD` computed from a session (`agentistics_sessions`, `agentistics_projects`, `agentistics_summary`, `agentistics_harnesses`, `agentistics_repos`) charges each model at its own rate via `sessionCostUSD` from `@agentistics/core` — a session that used more than one model (an Antigravity parent with Gemini/Claude subagent children folded into its `model_usage` breakdown) is never priced as if the whole thing ran at the dominant model's rate. For a single-model session this coincides exactly with the flat calculation.

## Available tools

There are **38 tools** (`packages/mcp/agentistics-mcp.ts`, the `TOOLS` array). By area:

| Area | Tools |
|------|-------|
| **Task board (ALM)** — 16, *beta* | `agentistics_tasks`, `agentistics_task`, `agentistics_task_create`, `agentistics_task_edit`, `agentistics_task_status`, `agentistics_task_statuses`, `agentistics_task_status_edit`, `agentistics_task_comment`, `agentistics_task_subtask`, `agentistics_task_link`, `agentistics_task_blocked_by`, `agentistics_task_next`, `agentistics_task_claim`, `agentistics_task_activity`, `agentistics_task_session`, `agentistics_task_delete` |
| **Session groups** — 3 | `agentistics_session_groups`, `agentistics_session_group_create`, `agentistics_session_group_edit` |
| **Metrics** — 6 | `agentistics_summary`, `agentistics_harnesses`, `agentistics_projects`, `agentistics_sessions`, `agentistics_costs`, `agentistics_repos` |
| **Custom layouts** — 8 | `agentistics_component_catalog`, `agentistics_get_layouts`, `agentistics_build_layout`, `agentistics_add_component`, `agentistics_remove_component`, `agentistics_create_layout`, `agentistics_set_active_layout`, `agentistics_delete_layout` |
| **PDF export** — 1 | `agentistics_export_pdf` |
| **Tags** — 2, read-only | `agentistics_tags`, `agentistics_tag_detail` |
| **Team** — 2, read-only | `agentistics_team_status`, `agentistics_team_members` |

Each tool's own `description` (what `tools/list` returns) is the authoritative contract; the
sections below document the ones whose shapes are stable.

### What the MCP cannot do — read this before relying on it

- **It has no gate of its own.** Every tool runs on the first call, including the destructive ones
  (`agentistics_task_delete`, `agentistics_delete_layout`, the `delete` action of
  `agentistics_session_group_edit`). There is no risk class, no audit and no notion of who called.
  The only protection is the server's own route guards and your client's tool-approval prompt.
- **It cannot authenticate to a central.** Every call is a bare `fetch` to `AGENTISTICS_API` with
  no credential, and a central requires an account session on every `/api/*` outside its public
  set. Pointed at a central, the tools answer with the auth refusal. `agentistics_team_members`
  describes central data, but in practice it only works when run against a central that does not
  demand auth — i.e. it is effectively machine-side today.
- **It does not control the live fleet.** No tool reads a session's screen, prompts one, starts one
  or stops one; the web workspace, the cockpit, the VS Code extension and `agentop session` can.
- **The task-board and session-group tools need a machine.** Their routes (`/api/tasks`,
  `/api/session-groups`) sit behind the `localShell` capability, so a central refuses them.

These gaps are the subject of the MCP coverage design
(`docs/superpowers/specs/2026-09-29-mcp-coverage-design.md`).

---

### Task board (ALM) — `agentistics_task*`

Thin calls to `/api/tasks`: the arithmetic (cost, rounds, tokens with provenance) and the rules
(`blocked` needs a reason, `done` needs a filed session, a claim is a 30-minute LEASE, never a lock)
live on the server, so the MCP, the CLI and the dashboard cannot disagree about a delivery. Refusals
come back as the server's own codes (`blocked_needs_reason`, `done_needs_session`, a claim naming its
holder). The orchestration loop an agent follows is `agentistics_task_next` (what can be picked up,
plus what is withheld and why) → `agentistics_task_claim` → work → `agentistics_task_session` (file
the session so the task is measured) → `agentistics_task_status`. Marked **beta**: the shapes may move
between releases. See CLAUDE.md § "The task board (ALM)".

---

### `agentistics_summary`

All-time totals aggregated from sessions. Token counts and cost are computed directly from session records (not from the stats-cache snapshot), so they are always accurate even if the cache is stale.

**Parameters:** `harness` *(optional)* — a harness id or `all` (default `all`).

**Returns:**
```json
{
  "harness": "all",
  "totalInputTokens": 12500000,
  "totalOutputTokens": 890000,
  "totalCacheReadTokens": 45000000,
  "totalCacheWriteTokens": 1200000,
  "estimatedCostUSD": 18.42,
  "totalSessions": 142,
  "topModel": "claude-opus-4-8",
  "topProject": "my-app",
  "activeDays": 38,
  "currentStreak": 7
}
```

`currentStreak` is `null` when scoped to a single non-Claude harness (streak is Claude-only).

---

### `agentistics_harnesses`

Side-by-side comparison of every harness present in the data, sorted by total tokens. No parameters.

**Returns:**
```json
[
  {
    "harness": "claude",
    "sessions": 157,
    "messages": 38664,
    "inputTokens": 2467133,
    "outputTokens": 29339498,
    "cacheReadTokens": 5981874127,
    "cacheWriteTokens": 208186404,
    "totalTokens": 6221867162,
    "estimatedCostUSD": 3031.51,
    "lastActive": "2026-06-29T13:52:24.823Z"
  },
  { "harness": "codex", "sessions": 20, "estimatedCostUSD": 0.20, "...": "..." }
]
```

---

### `agentistics_projects`

Per-project breakdown with aggregated token and cost data, sorted by total tokens descending.

**Parameters:** `harness` *(optional)* — scope to one harness, or `all` (default). When scoped, projects with no sessions in that harness are omitted and `sessions` reflects that harness's count.

**Returns:** array of projects
```json
[
  {
    "name": "my-app",
    "path": "/home/user/projects/my-app",
    "sessions": 34,
    "messages": 820,
    "inputTokens": 3200000,
    "outputTokens": 220000,
    "totalTokens": 3420000,
    "estimatedCostUSD": 5.21,
    "lastActive": "2025-01-15T14:30:00Z",
    "languages": ["TypeScript", "CSS"]
  }
]
```

> **Note:** Token/cost data is aggregated from session records grouped by `project_path`. Projects are matched by exact path.

---

### `agentistics_sessions`

Recent sessions with duration, model, and cost.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `limit` | number | 20 | Max sessions to return (1–50) |
| `harness` | string | `all` | Scope to one harness (any harness id), or `all` |

**Returns:** array of sessions sorted by start time descending (each row includes its `harness`)
```json
[
  {
    "id": "abc123",
    "harness": "claude",
    "project": "/home/user/projects/my-app",
    "startedAt": "2025-01-15T14:30:00Z",
    "durationMinutes": 47,
    "messages": 34,
    "inputTokens": 85000,
    "outputTokens": 6200,
    "cacheReadTokens": 310000,
    "cacheWriteTokens": 12000,
    "totalTokens": 413200,
    "estimatedCostUSD": 0.348,
    "model": "claude-sonnet-4-6"
  }
]
```

---

### `agentistics_costs`

Model pricing breakdown and cache analysis.

**Parameters:** `harness` *(optional)* — `all`/`claude` (default) uses the Claude-complete stats-cache; a specific non-Claude harness is aggregated per-model from its sessions.

**Returns:** array of models sorted by total tokens descending
```json
[
  {
    "model": "claude-sonnet-4-6",
    "inputTokens": 8200000,
    "outputTokens": 610000,
    "cacheReadTokens": 31000000,
    "cacheWriteTokens": 1200000,
    "totalTokens": 41010000,
    "estimatedCostUSD": 12.80
  }
]
```

---

### `agentistics_component_catalog`

Lists all dashboard components available for placement on the custom `/custom` page. **Always call this before building a layout.**

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `category` | string | Optional filter: `kpi`, `activity`, `costs`, `projects`, `tools`, `sessions` |

**Returns:** array of components with grid sizes and descriptions
```json
[
  {
    "id": "kpi.cost",
    "label": "Estimated cost",
    "category": "kpi",
    "defaultW": 3,
    "defaultH": 3,
    "minW": 2,
    "minH": 2,
    "description": "Estimated USD cost"
  },
  {
    "id": "activity.chart",
    "label": "Activity chart (full)",
    "category": "activity",
    "defaultW": 8,
    "defaultH": 7,
    "minW": 4,
    "minH": 4,
    "description": "Full activity chart with all metrics"
  }
]
```

---

### `agentistics_get_layouts`

Returns all saved custom layouts and which one is currently active.

**Returns:**
```json
{
  "activeLayout": "overview",
  "layouts": [
    {
      "name": "overview",
      "isActive": true,
      "componentCount": 5,
      "components": [
        { "instanceId": "1", "componentId": "kpi.cost", "x": 0, "y": 0, "w": 3, "h": 3 }
      ]
    }
  ]
}
```

---

### `agentistics_build_layout`

Creates a complete layout in one call: creates it, adds all requested components with auto-positioning, and optionally activates it. Ideal for building a themed dashboard from scratch.

Components are positioned using first-fit shelf packing on a 12-column grid. After placement, any component with empty space to its right (no right neighbour in its row range) is extended to fill the full row width.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name |
| `componentIds` | string[] | yes | Ordered list of component IDs from the catalog |
| `activate` | boolean | no | Set as active layout after creating (default: true) |

**Grid sizing guidelines (from the catalog defaults):**
- KPI cards (`kpi.*`): w=3, h=3 — 4 per row
- Wide charts (`activity.chart`, `tools.*`, `sessions.*`): w=8–12, h=6–8
- Medium panels (`costs.budget`, `costs.cache`, `activity.heatmap`): w=6, h=7
- Full-width (`costs.models`, `sessions.highlights`): w=12, h=6–8
- Projects: `projects.top` w=7, `projects.languages` w=5

Order `componentIds` thoughtfully: KPI cards first, then charts, then tables.

---

### `agentistics_add_component`

Adds a single component to an existing layout. Auto-positioned after existing items unless `x`/`y` are specified.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `layoutName` | string | no | Target layout (defaults to active layout) |
| `componentId` | string | yes | Component ID from the catalog |
| `x` | number | no | Column 0–11 (auto-placed if omitted) |
| `y` | number | no | Row (auto-placed if omitted) |
| `w` | number | no | Width in grid columns (defaults to catalog default) |
| `h` | number | no | Height in grid rows (defaults to catalog default) |

---

### `agentistics_remove_component`

Removes a component by its instance ID from a layout. Get instance IDs from `agentistics_get_layouts`.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `layoutName` | string | no | Layout name (defaults to active layout) |
| `itemId` | string | yes | Instance ID of the item to remove |

---

### `agentistics_create_layout`

Creates a new empty named layout without adding any components.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name |

---

### `agentistics_set_active_layout`

Switches the `/custom` page to display a different layout.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name to activate |

---

### `agentistics_delete_layout`

Permanently deletes a layout. Cannot be undone. Cannot delete the last remaining layout.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name to delete |

---

### `agentistics_export_pdf`

Generates a PDF report link: a `[⬇ Download PDF](pdf:URL)` markdown link pointing at `/?export=pdf&range=…`.

> **Known gap:** the `pdf:` link scheme was rendered as a download button by the old Nay chat
> (`TtyChat.tsx`), which #780 removed. Nothing in the current web bundle handles `pdf:` links or the
> `?export=pdf` parameter, so the link arrives as text. Use **Export** in the dashboard meanwhile.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `range` | string | `"all"` | Date range: `"7d"`, `"30d"`, `"90d"`, or `"all"` |

**Returns:** a markdown button link
```
[⬇ Download PDF — last 30d](pdf:http://localhost:47292/?export=pdf&range=30d)
```

---

### `agentistics_repos`

Repositories grouped by normalized git remote (independent of path or machine), with
session/message/token/cost totals and last-active date. Sessions with no linked repository are
grouped under `unlinked`. **Parameters:** `harness` *(optional)*.

---

### `agentistics_tags` / `agentistics_tag_detail`

Read-only. `agentistics_tags` lists every tag visible to the caller with its aggregate sessions,
cost and tokens; `agentistics_tag_detail` (`tag`: name or id) adds the per-source breakdown,
distributions, daily series and the tag's date window. Aggregates only — never session rows.

---

### `agentistics_team_status` / `agentistics_team_members`

Read-only. `agentistics_team_status` reports this machine's team mode (solo / central / member) and,
as a member, its central connections. `agentistics_team_members` lists a central's members with
presence; see the authentication limit above.

---

### Session groups — `agentistics_session_groups`, `agentistics_session_group_create`, `agentistics_session_group_edit`

The Sessions sidebar lets a person keep their fleet in named groups ("Saved to later", "Pelvie"…).
These three tools let an assistant do the same, so the sessions it starts are filed where the person
will look for them. They work on a **machine**; a central has no local sessions and refuses them.

The flow an assistant follows:

1. `agentistics_session_groups` — what groups exist, and which sessions are in each. Reuse a group when
   one fits rather than making a near-duplicate.
2. Start the session (for example `agentop session start …`, which prints its id).
3. `agentistics_session_group_create` with `name` and `sessions: [<id>]`, or, for an existing group,
   `agentistics_session_group_edit` with `action: "add"`, `group`, `session`.

A **session reference** is a managed id (`agentop-…`), a conversation id, an exact title, or a unique
id prefix. A **group reference** is an id or an exact name (case-insensitive). Anything that matches
nothing answers `404`, anything that could mean two things answers `409` with the candidates — a
reference is never guessed, and a call that names a bad session in a batch changes nothing.

Filing a session **moves** it out of any other group (a session belongs to at most one) and **unpins**
it if it was pinned, exactly as dropping it on a group in the sidebar does. Deleting a group never
deletes its sessions; they only leave it.

The tools are thin over `GET|POST /api/session-groups`, `POST /api/session-groups/:group`,
`POST /api/session-groups/:group/sessions`, `POST /api/session-groups/ungroup` and
`DELETE /api/session-groups/:group`. The rules live in `@agentistics/core` (`sessionGroups.ts`) and
are the same ones the web sidebar applies; the writes go through the preferences write chain, so a
browser and an assistant changing groups at the same moment cannot undo each other. The browser picks
up the change when its tab regains focus.

## Using the MCP from Claude Code

Once registered, you can invoke agentistics tools directly from any Claude Code session:

```
# In a Claude Code chat (not Nay), you can ask:
"What's my total spend so far this month according to agentistics?"
"Build me a layout in agentistics with cost KPIs and the activity chart"
"Generate a PDF of my last 30 days usage"
```

Claude Code will automatically use the registered MCP tools. No explicit configuration needed per-project — the registration is at user scope (`~/.claude.json`).

## Using the MCP from a custom agent

```typescript
// Example: calling agentistics tools from a Claude agent
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const response = await client.beta.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  tools: [/* your agentistics MCP tools */],
  messages: [{ role: 'user', content: 'What project spent the most tokens?' }],
})
```

## MCP server implementation

The server lives at `packages/mcp/agentistics-mcp.ts`. It uses the `@modelcontextprotocol/sdk` to expose tools over stdio, fetching data from the agentistics HTTP API (`AGENTISTICS_API`).

Key design decisions:
- **No direct file access** — all data goes through the agentistics API so the same parsing/aggregation logic applies everywhere
- **Cost calculation** — `session-tokens.ts` prices through `@agentistics/core` (`sessionCostUSD` per model, `calcCost` for the no-model fallback, the `tokens.ts` helpers for all four counters); there is no pricing copy inside the MCP
- **The layout catalog is a hand-kept mirror** — `CATALOG` in `agentistics-mcp.ts` copies `packages/web/src/lib/componentCatalog.tsx` and must be updated when a component is added there
- **Auto-position algorithm** — `agentistics_build_layout` uses first-fit shelf packing on a 12-column grid, then `fillGaps` extends items that have empty space to their right (no right neighbour in the same row range)
- **PDF links** — `agentistics_export_pdf` returns a `[label](pdf:URL)` markdown link (see the known gap above)

## MCP Server Verification and Dashboard Integration

The agentistics dashboard provides a dedicated MCP Management interface (in Settings / Live feed):
- **Server Health Verification (`CHECKED`)**: Configured MCP servers are actively verified against their stdio or HTTP endpoints. A configured server is assigned a distinct `CHECKED` state when operational, distinguishing working servers from unverified configurations.
- **Accepted Paste Formats**: The MCP paste drawer supports three distinct input shapes:
  1. Full JSON config block (`{"mcpServers": ...}`).
  2. Single server object (`{"command": "...", "args": [...]}`).
  3. CLI command invocation string (`claude mcp add ...`).

## See also

- [Nay chat](./nay.md) — the built-in assistant; a Nay conversation is a managed session with every tool allowed
- [Data sources](./data-sources.md) — what `/api/data` returns and how it's computed
