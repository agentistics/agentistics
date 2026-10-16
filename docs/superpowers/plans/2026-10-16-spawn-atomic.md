# Atomic spawn + hand-off + stuck activity — implementation plan

Spec: `docs/superpowers/specs/2026-10-16-spawn-atomic.md`. Task `t-67a9e7ff87`. Base every slice on
`origin/dev` in its own worktree under `~/agentistics/.claude/worktrees/`. English commits,
Conventional Commits, explicit `git add` paths. Engine territory (sessions/harness) → engine leader.

## Dependency graph

```
S1 bg-settle (P4) ─────────────┐
S2 spawn-filing planner ──┬── S4 wire into start/batch/spawnSession ─┐
S3 work-children + table ─┤                                           ├─ S6 handoff verb + route ── S7 MCP (optional, D1)
                          └── S5 retire request + hub evaluation ─────┘                         └─ S8 briefing/skill
S1 ──────────────────────────► S5 (bgTasksRunning)
S9 live QA (after S6+S8)
```

Parallel from the start: **S1, S2, S3** (disjoint files). Then **S4 ∥ S5**. Then S6, then S7 ∥ S8,
then S9. Engine mirror of S1 runs in `~/agentistics-engine` right after S1 lands.

## Slices

### S1 — background tasks settle on every real end (subtask 4) · Sonnet
- Files: new `packages/server/server/sessions/bg-settle.ts` (+test); `chat-tail.ts` (both loops at
  `:590-625` and `:728-775` call it; `sessionEnded` option on `readRecentChatTurns`/`readChatWindow`);
  `chat-web.ts` passes the row's not-running state; `packages/core/src/chatTurn.ts`
  (`task.ended?`), engine-api `EngineChatTurn` mirror; `web/src/components/sessions/ChatBubble.tsx:545`
  label for `stopped` / `never-started` / `session-ended` (EN+PT); export `bgTasksRunning(path)`.
- Tests: fixtures cut (redacted by script) from the measured transcripts — TaskStop pair
  (`Command running in background with ID: x` → `Successfully stopped task: x`), denied launch
  (`is_error`), ended session; the notification path stays byte-identical on an existing fixture.
- Done: both orphan shapes from the spec table render `running: false`; `bun test` for
  chat-tail/chat-web/core green; tsc per package green.
- Follow-up (same model, engine clone): mirror into the engine's reader copy so its chat differential
  stays equal.

### S2 — `spawn-filing.ts` pure planner (subtasks 1+3) · Opus (core of the design) or Codex sol
- Files: new `packages/server/server/sessions/spawn-filing.ts` (+test); a pure
  `finished-folder.ts` (name rule shared with S6).
- Implements spec 2.1 rules 1–6 with injected `repoOf`/`liveInCwd`; returns `FilingPlan`.
- Tests: every refusal code; member → group; folder order explicit > task(subtask>task, skipping
  finished folders) > parent > none; worktree of the task's remote accepted; main checkout with a
  live session refused, `sharedCwd` override; leader exempt from repo/shared checks; hand-off input
  copies predecessor cwd/filing/folder.
- Done: pure, 100% branch coverage of the refusal table, no IO imports (test asserts).

### S3 — `work-children.ts` + `HELPER_PROCESSES` (P2 quiet signal) · Sonnet + live measurement
- Files: new `packages/server/server/sessions/work-children.ts` (+test), a `proc` tree reader reusing
  `live-sessions.ts`/`process-transcript.ts` walkers (no new `/proc` parser).
- `HELPER_PROCESSES: Record<HarnessId, RegExp[] | null>` — start all `null`; fill an entry only from
  a live idle session observed in a throwaway (`agentop run --rm`), recording CLI version + date in
  the comment, as `attention-rules.ts` does. Minimum: claude, codex, gemini measured.
- Done: tests over captured trees; three harness entries measured and dated.

### S4 — wire the planner into every spawn site (subtasks 1+3) · Codex sol (scoped)
- Depends: S2.
- Files: `cli-parse.ts` (`--shared-cwd`; keep `--task/--subtask/--role/--folder`), `cli-session.ts`
  `start` (`:362-485`) and `batch` (`:576-705`): call `planFiling` before the memory gate, write
  `taskId`/`subtaskId`/real `task` title on the row, call `attachSession` like
  `cli-start.ts:4567-4571`, folder from the plan; `--json` adds the filing block.
  `cli-start.ts` `spawnSession` (`:4527-4593`) replaces its private member→group/hand-off-parent
  logic with the planner. `USAGE` text.
- Tests: `cli-parse.test.ts`; a `cli-batch-registry`-style test asserting `subtaskId` on the row;
  integration in `agentop run --rm`: `session claude --bg --task <id> --subtask <id>` → `task show`
  lists it under the subtask.
- Done: the three spawn sites produce identical rows for identical inputs (one table-driven test over
  the shared planner output → row builder).

### S5 — `retire` request + hub evaluation (subtask 2, half) · Opus
- Depends: S1 (`bgTasksRunning`), S3.
- Files: `types.ts`/`registry.ts` (`ManagedSession.retire`, round-trip + `registry.test.ts`), new
  pure `retire-plan.ts` (+test), `session-hub.ts` (evaluate pending requests per tick using the
  hub's own snapshot — never a second poller), `cli-session.ts` (`retire <ref> [--cancel]` verb;
  `kill <own id>` → retire), fleet event + task comment on retire/expire, notification on expire.
- Tests: retire-plan table (two-poll, quietFor, waiting-approval, successor dead, deadline, bg>0,
  work child); hub test with a fake backend that the kill happens once.
- Done: a throwaway session asked to retire while `working` is killed only after it goes idle, and
  never past the deadline.

### S6 — `agentop session handoff` + `POST /api/fleet/handoff` (subtask 2) · Opus
- Depends: S4, S5.
- Files: `cli-parse.ts`, `cli-session.ts` (verb), `fleet-web.ts` (route; prefix already guarded —
  add a `capability-guard.test.ts` assertion), `agentistics-context.ts` (`handoff` file in the
  successor's context), `handoff-group.ts` folded into the planner path.
- Tests: parse; refusal `handoff_pending`; successor fails → no retire written; integration in a
  throwaway: successor leader titled with prefix, same task/subtask/folder, predecessor retired into
  the finished folder after idle.
- Done: one command replaces the 5–6 manual steps; `--json` reports successor id + retire request.

### S7 — `agentistics_session_handoff` MCP tool (optional, decision D1) · Sonnet
- Depends: S6. Files: `packages/mcp` tool + test; verified-leader gate via `session-proof.ts`.
- Done: refused for unverified / non-leader callers; same result as the CLI. Drop if D1 = no.

### S8 — briefing + managed skill (all subtasks) · Sonnet
- Depends: S4, S6 (S7 if shipped).
- Files: `agentistics-context.ts:102,:134` (+ `agentistics-context.test.ts` snapshots), the
  `agentistics-sessions-hand-offs` skill source, `docs/session-manager.md`, CLAUDE.md sessions block
  (one paragraph), What's new entry (`whatsNew/releases.ts`, PT+EN).
- Done: the briefing names only verbs that exist and file atomically.

### S9 — live QA · a model different from each slice's author (Codex astra / Gemini for Claude-authored)
- Depends: S6, S8 (S1 can be QA'd alone earlier).
- Throwaway HOME + own tmux socket (`agentop run --rm`), never the owner's sessions, stop by saved id.
- Matrix: claude, codex, gemini (kimi if budget): worker spawn filed on subtask + folder default +
  wrong-cwd refusal; hand-off claude→claude, codex→codex, claude→gemini; busy predecessor past a
  short deadline not killed; TaskStop and session-kill clear the background line.
- Done: report in `~/.agentistics/leader/qa/spawn-atomic-live-1.md`, all rows green or filed bugs.

## Models / effort

| slice | model | why |
|---|---|---|
| S1 | Sonnet | scoped, fixtures given |
| S2 | Opus (or Codex gpt-6.1-sol) | the rule table is the product |
| S3 | Sonnet | small + measurement |
| S4 | Codex gpt-6.1-sol | mechanical wiring against a fixed planner |
| S5 | Opus | concurrency with the hub, kill semantics |
| S6 | Opus | integrates S4+S5, refusals |
| S7, S8 | Sonnet | small |
| S9 | different from author | owner rule |

Release: one batch (S1–S8) on a `release/<date>` branch after S9, experimental OFF pass included.
