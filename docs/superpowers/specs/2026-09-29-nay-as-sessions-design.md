# Nay: from a one-shot `--print` chat to real agentop sessions

**Status:** approved 2026-09-29. The owner decided the product points below; the leader session
relayed the decisions it answered on the owner's behalf.

## Why

The Nay chat (`TtyChat.tsx`) ran `claude --print --output-format stream-json` once per message. It
drifted from everything the sessions workspace does. Four defects came out of that:

- It passed a CLI flag that does not exist (`--budget-tokens`).
- It silently denied 20 of the 38 MCP tools.
- Its own model list was stale.
- It had a composer of its own that could do none of what the session composer does.

The owner asked for the Nay input to be *exactly* the session input: attachments, the metrics chip,
the microphone, auto mode, and everything that works there. Only one design delivers that: a Nay
conversation IS a managed session, and it is drawn by the same `SessionChat` the workspace draws.

## Decisions

1. **A Nay conversation is an ordinary managed `claude` session.** It runs in
   `~/.agentistics/nay-chat` (`NAY_CHAT_DIR`), with Nay's `CLAUDE.md` and the agentistics MCP, and
   it is spawned by the same host verb the wizard uses. What makes a session "Nay" is its cwd. That
   is a fact the registry already records, so no new field is needed. There can be several, and
   "new conversation" starts one.
2. **Nay sessions appear in the sessions list, in their own user group, "Nay".** Each new one is
   filed there through the existing group planner (`planGroupOp`), and the group is created on
   first use.
3. **The floating chat is a shell with two tabs.**
   - **Nay** lists the open Nay sessions and offers "new conversation". Picking a session opens it
     **where it already is**: if it is detached into a window, that window is raised (and restored
     if it was minimized); otherwise it opens inside the panel.
   - **Sessões** mounts the same `SessionsAside` the left sidebar mounts (folders, groups, filters,
     new session). A session opened from it opens inside the chat panel.
4. **The input is the session composer itself**, because the panel mounts `SessionChat`. There is
   no second composer to keep in step.
5. **The chat button is always the chat button.** While a Nay session is detached, the fixed
   button keeps opening the tabbed panel. Before, it turned into a different button that opened
   nothing.
6. **The docked panel is resizable** by its top and left edges. The size is clamped to the
   viewport and kept per viewer in `localStorage`. On mobile the panel stays full screen.
7. **Visual:** Nay's purple becomes the product orange (`var(--anthropic-orange)`) everywhere,
   including the minimized detached button. Dock and undock become labelled controls with
   unambiguous icons and a tooltip.
8. **Permissions:** Nay's project settings allow the whole agentistics MCP server
   (`mcp__agentistics`), not a hand-kept list of 18 tools. A permission the session still needs
   shows as the ordinary approval card, never a silent denial.

## Out of scope

- The split view (two sessions side by side on `/sessions`) is a separate spec.
- Nay on codex/gemini/copilot. Those become "a session with another harness", which the wizard
  already does. The chat drivers (`chat-drivers/`, `/api/chat-tty`) are no longer used by the
  panel. Removing them is a follow-up, not part of this change.
