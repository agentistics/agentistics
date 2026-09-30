# Nay — AI Chat Assistant

Nay is the analytics assistant built into the agentistics dashboard. It reads your real usage data
through the agentistics MCP tools and answers questions about spending, projects, sessions,
repositories, tags, the task board and custom layouts without you leaving the dashboard.

## How it works — a Nay conversation is a real session

Since #780 a Nay conversation is an **ordinary managed `claude` session**, the same kind the
Sessions workspace, the cockpit and `agentop session` start. Nothing about it is a separate chat
engine:

```
"New conversation" in the Nay panel
  → POST /api/fleet/nay
    → runFleetSpawn(harness: claude, cwd: ~/.agentistics/nay-chat)   (sessions/nay-web.ts)
      → an interactive `claude` session in tmux, filed under the "Nay" session group
  → the panel mounts the workspace's own SessionChat (same composer, same terminal)
    → claude calls the agentistics MCP tools → /api/data, /api/tasks, /api/session-groups, …
```

- **What makes a session "Nay" is its directory.** `isNayCwd` (`@agentistics/core`, `nay.ts`)
  recognises `~/.agentistics/nay-chat`; there is no extra registry field.
- **It runs every check a session start makes** (harness on PATH, memory admission, launch
  settling), because it is `runFleetSpawn` with the directory fixed.
- **What it starts with** — the assistant, model and reasoning effort — comes from the dock's
  create picker, which is pre-filled with the defaults in **Settings → Chat** (`chatHarness` /
  `chatModel` / `chatEffort`). `sessions/nay-launch.ts` decides: an explicit choice the machine
  cannot run is refused in words, a saved default that no longer applies is dropped to the CLI's own
  default, a saved model or effort never rides onto a different harness, and only the flags each CLI
  prints are offered (`spawn-spec.ts`). Nay's instructions are written as `CLAUDE.md`, `AGENTS.md`
  and `GEMINI.md`, so every CLI that can host it reads them. The conversation's header shows what it
  runs on ("Claude Code · Opus 4.8 · high").
- **It is filed under "Nay › Ativas" while it runs and "Nay › Inativas" once it ends.** The server
  creates the folders on first use and re-files on every fleet read (`reconcileNayFolders`,
  `planNayPlacement`), so ending a conversation — from the chat's "Encerrar", the row menu, the
  cockpit or a reboot — moves it on its own. A failed filing never turns a started session into a
  reported failure.
- **Gates.** `/api/fleet/nay` rides `/api/fleet`'s `localShell` guard (`capability-guard.ts`) and
  additionally requires the chat switch (`chatAllowed`, Settings → Chat; ON unless turned off,
  owner decision 2026-09-29). So Nay is unavailable on a
  central and on any profile where host power is off.

The old one-shot `claude --print` path (`/api/chat-tty` driving `TtyChat.tsx`) is gone for Nay; the
component was deleted in #780.

## The panel

The Nay panel (`NayDock`) has two tabs:

- **Nay** — the running Nay sessions, plus "new conversation".
- **Sessões / Sessions** — the same `SessionsAside` the workspace shows, kept inside the panel.

A session can be **undocked into its own window**, which can be moved, resized and minimized;
picking a session that already has a window raises and restores that window rather than opening it
twice. The docked panel is resizable from its top and left edges (persisted per viewer) and is full
screen on mobile.

Because the composer IS the session composer, Nay gets everything it has — attachments, the metrics
chip, the microphone, auto mode, approval cards — and nothing a separate copy would have to keep in
sync.

## Requirements

- **Claude Code CLI** installed and authenticated (`claude --version`).
- **tmux** — Nay is a managed session, so it needs the session backend (Linux, macOS, or WSL on
  Windows).
- **`agentop server` running** — the MCP tools talk to the local API.
- **The chat switch on** (Settings → Chat) on a profile that allows host power.

## Subscription and quota usage

> **Important:** every Nay conversation is a normal Claude Code session and counts against your
> Claude Code usage exactly like one.
>
> - **Claude Max / Pro subscribers**: usage comes out of your plan's limits.
> - **API key users**: each turn is billed at standard API rates for the selected model.
>
> A small, fast model is plenty for data lookups; pick a larger one in Settings → Chat for analysis
> or layout building.

Nay's own sessions are tracked like any other: they are the project at `~/.agentistics/nay-chat`.

## Workspace setup

On every server start, `ensureNayChat()` (`chat-tty.ts`) writes two files to
`~/.agentistics/nay-chat/` (and `/api/fleet/nay` writes them first if `CLAUDE.md` is missing):

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Nay's instructions: identity, tool-call protocol, the tools it has, PDF flow, response format, navigation links |
| `.claude/settings.json` | Permissions only: `mcp__agentistics` (the **whole** agentistics MCP server) and `WebFetch(domain:localhost)` are allowed without asking; anything else raises the ordinary approval card |

There is no `mcpServers` block in that file — Claude Code does not read one from a project
`settings.json`. The MCP is registered at **user scope** by `registerMcpGlobally`
(`claude mcp add -s user`), launching the installed binary's own `agentop mcp` (see
[mcp.md](mcp.md#starting-the-mcp-server)). The registration is idempotent.

## What Nay can answer

Nay has every agentistics MCP tool (38 at the time of writing — see
[mcp.md](mcp.md#available-tools)). Typical questions:

| Question | What it calls |
|----------|--------------|
| "How much did I spend this month?" | `agentistics_summary`, `agentistics_costs` |
| "Which project / repository cost the most?" | `agentistics_projects`, `agentistics_repos` |
| "What were my most expensive sessions?" | `agentistics_sessions` |
| "Which harness do I use most?" | `agentistics_harnesses` |
| "How much did tag X cost?" | `agentistics_tags`, `agentistics_tag_detail` |
| "What is on the board / what can I pick up?" | `agentistics_tasks`, `agentistics_task_next` |
| "Put these sessions in a folder" | `agentistics_session_groups`, `agentistics_session_group_create` / `_edit` |
| "Build me a cost overview layout" | `agentistics_component_catalog`, `agentistics_build_layout` |
| "How much have I spent talking to you?" | `agentistics_projects`, filtered to `~/.agentistics/nay-chat` |

What Nay **cannot** do through the MCP today: control the live fleet (read a session's screen,
prompt, start or stop one), or authenticate to a central. Both are planned in the MCP coverage
design (`docs/superpowers/specs/2026-09-29-mcp-coverage-design.md`).

## PDF export

`agentistics_export_pdf` returns a `[⬇ Download PDF](pdf:URL)` markdown link and Nay's
instructions tell it to pass that link through unchanged. **Known gap:** since #780 Nay renders
through the ordinary session chat, which has no handler for the `pdf:` link scheme, so the link is
shown as text rather than as the download button the old `TtyChat` drew. Use **Export** in the
dashboard until that is restored.

## Navigation links

Nay ends a data answer with a link to the relevant dashboard page, carrying a `?projects=…` filter
when the answer was about specific projects — for example `→ Ver custos` → `/costs`,
`→ Ver repositórios` → `/repositories`, `→ Abrir layout` → `/custom`.

## Behavior rules (enforced via CLAUDE.md)

1. **Identity** — presents as Nay, the agentistics analytics assistant, not as a generic assistant.
2. **Never answer from memory** — calls tools for every data question, follow-ups included.
3. **Act, don't narrate** — calls tools immediately instead of describing what it is about to do.
4. **Navigation link only when data was fetched** — no link on a conversational reply.
5. **"Talking to me" = the nay-chat project** — cost questions about Nay filter to
   `~/.agentistics/nay-chat`.
6. **PDF flow** — asks for the date range before calling `agentistics_export_pdf`.

## See also

- [MCP tools reference](./mcp.md) — the tools Nay uses
- [Session manager](./session-manager.md) — the managed sessions Nay conversations are
