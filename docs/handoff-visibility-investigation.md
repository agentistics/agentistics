# Handoff successor visibility investigation

Status: **not reproduced; no production fix**, 2026-10-25. Scope: PASSAGEM.INVISIVEL,
Agentask `t-e1dea7cd6f` / `s-cbd543d665`.

The reported symptom is a successor missing from the sidebar until its predecessor is killed.
The current source preserves both live leaders when given two live registry/backend rows.
Do not treat these tests as a reproduction of the incident or as evidence it is fixed.

## Evidence

- `handoff-visibility.test.ts` exercises registry reconciliation, session views, control-session
  projection and the sidebar team builder. The two leaders deliberately share title, harness,
  directory and task but have distinct conversation IDs. Both remain visible during overlap;
  ending the predecessor leaves one team; a failed spawn leaves the original team.
- `SessionsAside.leaders.test.tsx` exercises the actual sidebar with same-title leaders at 1280px
  and 390px. The successor appears while the predecessor is alive, members appear once, and
  ending the predecessor or omitting a failed successor preserves the appropriate team.
- The latest Motor and Side Tasks handoff records have distinct predecessor/successor
  conversation IDs. Their successors have no parent link. This rules out a persisted shared
  conversation or nested-parent link for those records, but does not establish their state
  during the incident.
- `collapseSupersededSessions` only collapses ended records of the same conversation.
  `buildTeams` gives every leader its own team even if it names another leader as its parent.
  Fleet deltas and their client reducer identify rows by session ID, not title or task.

Validation:

```sh
agentop run --rm -- env "PATH=/home/mithrandir/.volta/tools/image/packages/bun/bin:/usr/local/bin:/usr/bin:/bin:/home/mithrandir/.local/bin" bun test packages/server/server/sessions/handoff-visibility.test.ts packages/web/src/components/nav/SessionsAside.leaders.test.tsx
```

Result: 15 passed, 0 failed, 258 assertions. No full typecheck or live harness spawn performed.

## Missing evidence and next step

Capture the successor's registry entry, backend presence/aliveness, projected fleet state and
SSE delta **before killing the predecessor**, and identify the sidebar tab and filters.
No secrets, prompts or environment variables are needed.

One possible exclusion path exists: `sessionState` maps a running view with no activity to
`lost`; the sidebar excludes `lost` from Ativas and the SSE stream with `closed=0` omits a newly
seen historical row. This is a hypothesis, not an established cause: the ordinary poll supplies
activity for every backend row, including a blank terminal. If the successor is absent from
the backend, inspect structured backend discovery/reattachment before changing the UI.

No what's-new entry was added because no user-facing fix has been established. The handoff
warning/panel/progress files are untouched. Tests and this analysis are staged for the leader.
