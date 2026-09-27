# P3 parity matrix (A4.2) — the §40 matrix as a CI artefact

**Date:** 2026-09-27 · **Spec:** `docs/superpowers/specs/2026-09-19-runtime-p3-projections-parity.md`
§1.2/§5/§8.1 · master spec `docs/superpowers/specs/2026-09-19-agentistics-runtime-master.md` §40.
**Base:** `feat/a4-projections` (`origin/dev` + A3). **Generator:**
`packages/server/server/projections/parity-matrix.ts` (pure) + `packages/server/scripts/parity-matrix.ts`
(the runner, IO). **CI:** `.github/workflows/ci.yml`'s `Parity matrix` step, artefact name `parity-matrix`.

## How to regenerate this file

```bash
bun packages/server/scripts/parity-matrix.ts --out /tmp/parity-out
cp /tmp/parity-out/parity-matrix.md docs/superpowers/research/2026-09-27-p3-parity-matrix.md
# then re-attach this header (git diff will show only the table + summary numbers changing)
```

The script reads **only** `packages/server/test/fixtures/**` and throwaway `tmpdir()` roots it builds
itself — never a real machine's `~/.claude`, `~/.agentistics`, `~/.codex`, `~/.gemini`, `~/.copilot`
or `~/.kimi-code`. It refuses outright (`assertSafe`) if any path it is about to hand to a
differential resolves under one of those real directories, and it points `$HOME` and every
per-harness `<HARNESS>_DIR` env var at a fresh isolated directory before dynamically importing any
server module, so even a future hidden default in `config.ts` cannot reach the owner's real store.

## 1. What this is

One row per (metric × harness), generated — never written by hand — from the per-harness
differentials that already exist (A3's `differential.ts` + `differential-<harness>.ts`, one per
`HarnessId`). `parity-matrix.ts` folds each harness's compared `SessionDiff[]` through
`differential.ts`'s own `summarize()`, then:

- maps the differential's five verdicts down to the matrix's three statuses
  (`equal → equal`; `explained` / `not-projectable` / `partial` → `explained`, carrying the row's
  own one-sentence reason; `bug → regression`, never softened);
- **overrides** any row whose metric maps to a `HarnessCapabilities` key the harness's own
  capability table (`@agentistics/core`'s `CAPABILITY_STATES`) says it does not produce
  (`not_supported` / `not_applicable` / `unknown`), replacing whatever verdict the differential gave
  — including a coincidental `equal` at `0`/`0` — with `explained: not produced by <harness>: <the
  capability table's own reason>`. This is the same N/A-vs-confident-0 rule CLAUDE.md states for
  every other capability-gated surface, applied to the parity matrix itself;
- **synthesizes** one row per harness for a declared-unsupported capability that no field in
  today's comparator covers at all (`dynamicWorkflows`, `skills`, most of `mcpServers`) so the
  matrix states the gap rather than omitting the harness/metric pair silently. A capability that
  IS supported but has no comparable field (e.g. `dynamicWorkflows` on claude, which today's
  comparator never measures) is left OUT rather than fabricated — there is nothing measured to
  report, and inventing an `equal` row for it would be the same confident-0 defect this module
  exists to refuse.

Rows are sorted deterministically: `HARNESS_ORDER`, then metric name (`sortParityRows`, asserted by
`parity-matrix.test.ts`).

## 2. Fixtures used, per harness

| harness | fixture(s) | notes |
|---|---|---|
| claude | `claude-replay`, `claude-replay-compact`, `claude-replay-turns`, `claude-replay-turn-end` | four redacted conversations, merged into one report |
| codex | `codex-replay/sessions` (5 rollouts) | the 5th is the synthetic reset/model-switch/web-search rollout |
| gemini | reconstructed at run time from the two literal sessions `differential-gemini.test.ts`'s own "end to end over a throwaway store" tests already prove clean (a rich-json session with a tool error + a model switch, and a jsonl-shape session) | no ready-made directory fixture exists for gemini today (its own differential test builds one at test time); this script places the SAME checked-in literal content into the `tmp/<project>/chats/` layout the differential scans, rather than inventing new fixture data |
| copilot | `copilot-replay-basic`, `copilot-replay-crashed` (checked-in `session-state/` dirs) | the crashed one has no `session.shutdown` at all |
| antigravity | `antigravity-replay`, `antigravity-replay-real` | each built into its own throwaway SQLite root by the integration's own `buildFixtureRoot` |
| kimi | `kimi-replay/basic`, `kimi-replay/subagent` | the subagent fixture holds a main agent and one worker; see §3 for how its rows are settled |
| opencode | the committed `integrations/opencode/__fixtures__/sessions.json`, built into a throwaway SQLite db by `buildFixtureDb` | no legacy adapter exists for opencode at all; both sides of every opencode comparison are the differential's own independent readings |

## 3. Known non-parity, stated up front

**kimi's "subagent" fixture is included, and settled rather than excluded.** The first A4.2 run
left it out because it carried a real `bug`: legacy `input_tokens` 80 (main 50 + worker 30) against a
projected 50. The cause was in the PROJECTION, not in `integrations/kimi`: legacy `kimi-parse.ts`
folds every agent's `wire.jsonl` into one session, while `sessionMetaProjection` v1 summed the main
agent only (Claude's rule). sessionMeta **v2** states legacy's rule per harness
(`HARNESS_TOOL_RULES.kimi.countScope = 'all-agents'`: tokens, daily buckets, tools, lines and files
from every agent; gauge, model, turns and compactions stay main-only) and
`subagentsImplyTaskAgent: false` (legacy's `uses_task_agent` reads tool names only). The rows that
still differ are `explained` in `differential-kimi.ts` with per-session proofs (`KIMI_EXPLANATIONS`):
legacy names and prices the whole session at the LAST usage.record's model it reads (a subagent's
here) — proven by pricing the projected counters at legacy's model, which reproduces legacy exactly —
and `agentMetrics` is new for kimi, its totals proven equal to the subagents' own `model.completed`
sums. **A reader must not add kimi's `agentMetrics` to its session totals**: under the all-agents rule
they are already inside them.

**Everything else in master §40's "known non-parity, by design" note also applies unchanged**: the
per-UTC-day slice and hour buckets are new for every non-claude harness (legacy never computed them
at all for those harnesses), and every affected row here reads `explained` with that reason rather
than a silent improvement.

**Not yet covered by this generator, and why:** master §40 additionally lists sessions, languages,
repositories, projects, tags, task rollups and streak among the rows that must eventually be green.
None of those are produced by today's differential machinery — `differential.ts` and
`differential-<harness>.ts` compare `SessionMeta` fields only, and the higher-level aggregates
(`costByDimension`, `taskRollup`, tag/repo rollups) are P3 projections A4.1 built in this same round,
but no differential compares them against a legacy figure yet. Extending the matrix to them is the next
step (it needs a legacy-side aggregate per dimension), not a gap in this generator.

## 4. Result

rows: 279 · equal: 149 · explained: 130 · regression: 0

| harness | metric | legacy | projected | delta | capability | exactness | status | reason |
|---|---|---|---|---|---|---|---|---|
| claude | `active_minutes` | 3 | 3 | 0 | activeTime (supported) | exact | equal |  |
| claude | `agentMetrics.invocations[].agentType` | general-purpose | general-purpose | — | agents (supported) | exact | equal |  |
| claude | `agentMetrics.invocations[].toolStats` | `{"readCount":0,"searchCount":0,"bashCount":1,"editFileCount":0,"otherToolCount":0}` | `{"readCount":0,"searchCount":0,"bashCount":1,"editFileCount":0,"otherToolCount":0}` | — | agents (supported) | exact | equal |  |
| claude | `agentMetrics.invocations[].totalTokens` | 195507 | 195507 | 0 | agents (supported) | exact | equal |  |
| claude | `agentMetrics.invocations[].totalToolUseCount` | 1 | 1 | 0 | agents (supported) | exact | equal |  |
| claude | `agentMetrics.invocations[].unmeasured` | false | false | — | agents (supported) | exact | equal |  |
| claude | `agentMetrics.totalCostUSD` | 0.3893194 | 0.3893194 | 0 | agents (supported) | exact | equal |  |
| claude | `agentMetrics.totalInvocations` | 3 | 3 | 0 | agents (supported) | exact | equal |  |
| claude | `agentMetrics.totalTokens` | 488646 | 488646 | 0 | agents (supported) | exact | equal |  |
| claude | `agentMetrics.unmeasuredInvocations` | 0 | 0 | 0 | agents (supported) | exact | equal |  |
| claude | `cache_creation_1h_input_tokens` | 250967 | 250967 | 0 | tokens (supported) | exact | equal |  |
| claude | `cache_creation_5m_input_tokens` | 0 | 0 | 0 | tokens (supported) | exact | equal |  |
| claude | `cache_creation_input_tokens` | 250967 | 250967 | 0 | tokens (supported) | exact | equal |  |
| claude | `cache_read_input_tokens` | 2964690 | 2964690 | 0 | tokens (supported) | exact | equal |  |
| claude | `compact_count` | 0 | 0 | 0 | compaction (supported) | exact | equal |  |
| claude | `compact_dropped_tokens` | — | — | — | compaction (supported) | exact | equal |  |
| claude | `compact_ms` | 0 | 0 | 0 | compaction (supported) | exact | equal |  |
| claude | `context_tokens` | 132361 | 132361 | 0 | contextWindow (supported) | exact | equal |  |
| claude | `context_window` | — | — | — | contextWindow (supported) | exact | equal |  |
| claude | `costUSD` | 0.85487 | 0.85487 | 0 | cost (supported) | estimated | equal |  |
| claude | `daily` | 1 | — | — | tokens (supported) | exact | explained | its `messages` counts every user- and assistant-role LINE (tool results included) and its `hours` every timestamped line; events cover a subset of lines. Tokens are in `daily_tokens` |
| claude | `daily.<day>.tokens` | `{"input":222,"output":11249,"cacheRead":2964690,"cacheWrite":250967}` | `{"input":222,"output":11249,"cacheRead":2964690,"cacheWrite":250967}` | — | tokens (supported) | exact | equal |  |
| claude | `duration_minutes` | 14 | 14 | 0 | — | exact | equal |  |
| claude | `end_time` | 2026-09-10T19:00:18.466Z | 2026-09-10T19:00:18.466Z | — | — | exact | equal |  |
| claude | `files_modified` | 0 | 0 | 0 | gitLines (supported) | exact | explained | files of completed edits only: legacy counts at request time, excludes NotebookEdit, takes max() with git |
| claude | `input_tokens` | 222 | 222 | 0 | tokens (supported) | exact | equal |  |
| claude | `lines_added` | 0 | 0 | 0 | gitLines (supported) | exact | explained | edit-derived half only: legacy counts edits at request time and takes max() with git diff |
| claude | `lines_removed` | 0 | 0 | 0 | gitLines (supported) | exact | explained | edit-derived half only: legacy counts edits at request time and takes max() with git diff |
| claude | `message_hours` | 166 | — | — | — | declared | explained | legacy takes the local hour of EVERY timestamped transcript line (every role, system lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 sessions equal, A2.7), so it is left legacy-only by decision D25 |
| claude | `model` | claude-haiku-4-5-20251001 | claude-haiku-4-5-20251001 | — | model (supported) | exact | equal |  |
| claude | `output_tokens` | 11249 | 11249 | 0 | tokens (supported) | exact | equal |  |
| claude | `rounds` | 7 | 7 | 0 | — | exact | equal |  |
| claude | `start_time` | 2026-09-10T18:46:48.021Z | 2026-09-10T18:46:48.021Z | — | — | exact | equal |  |
| claude | `tool_counts` | `{"ToolSearch":2,"mcp__agentistics__agentistics_sessions":1,"Bash":16,"Agent":3}` | `{"ToolSearch":2,"mcp__agentistics__agentistics_sessions":1,"Bash":16,"Agent":3}` | — | tools (supported) | exact | equal |  |
| claude | `tool_error_categories` | `{"Bash":1}` | `{"Bash":1}` | — | tools (supported) | exact | equal |  |
| claude | `tool_errors` | 1 | 1 | 0 | tools (supported) | exact | equal |  |
| claude | `user_interruptions` | 6 | 6 | 0 | — | exact | equal |  |
| claude | `user_message_count` | 7 | 7 | 0 | — | exact | equal |  |
| claude | `user_message_timestamps` | `["2026-09-10T18:46:48.561Z","2026-09-10T18:55:36.387Z","2026-09-10T18:58:50.063Z","2026-09-10T18:59:53.710Z","2026-09-10T19:00:08.058Z","2026-09-10T19:00:08.060Z","2026-09-10T19:00:12.174Z"]` | `["2026-09-10T18:46:48.561Z","2026-09-10T18:55:36.387Z","2026-09-10T18:58:50.063Z","2026-09-10T18:59:53.710Z","2026-09-10T19:00:08.058Z","2026-09-10T19:00:08.060Z","2026-09-10T19:00:12.174Z"]` | — | — | exact | equal |  |
| claude | `user_response_times` | `[92,186,39,0,0,0]` | `[92,186,39,0,0,0]` | — | — | exact | equal |  |
| claude | `uses_mcp` | true | true | — | tools (supported) | exact | equal |  |
| claude | `uses_task_agent` | true | true | — | tools (supported) | exact | equal |  |
| claude | `uses_web_fetch` | false | false | — | tools (supported) | exact | equal |  |
| claude | `uses_web_search` | false | false | — | tools (supported) | exact | equal |  |
| codex | `active_minutes` | 1 | 1 | 0 | activeTime (supported) | exact | equal |  |
| codex | `agents` | — | — | — | agents (not_supported) | n/a | explained | not produced by codex: Codex does not record per-subagent breakdowns in its transcripts. |
| codex | `cache_creation_1h_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| codex | `cache_creation_5m_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| codex | `cache_creation_input_tokens` | 0 | 0 | 0 | tokens (partial) | exact | equal |  |
| codex | `cache_read_input_tokens` | 207360 | 207360 | 0 | tokens (partial) | exact | explained | a cumulative counter went DOWN (a restarted series): legacy keeps only the last snapshot, the replay adds every series; the recount of snapshots reproduces both |
| codex | `compact_count` | — | — | — | compaction (not_supported) | n/a | explained | not produced by codex: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| codex | `compact_dropped_tokens` | — | — | — | compaction (not_supported) | n/a | explained | not produced by codex: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| codex | `compact_ms` | — | — | — | compaction (not_supported) | n/a | explained | not produced by codex: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| codex | `context_tokens` | 49649 | 49649 | 0 | contextWindow (supported) | exact | equal |  |
| codex | `context_window` | 258400 | 258400 | 0 | contextWindow (supported) | exact | equal |  |
| codex | `costUSD` | 0.06271499999999999 | 0.06271499999999999 | 0 | cost (partial) | estimated | explained | the price of the model/counter differences explained above: the legacy session repriced with the projected model and the recount of the projected counters equals the projected cost exactly |
| codex | `daily.<day>.tokens` | — | `{"input":46474,"output":2735,"cacheRead":207360,"cacheWrite":0}` | — | tokens (partial) | exact | explained | the parser writes no per-day split for Codex; the projection slices each turn delta onto its UTC day (P2 §3, master §40), and the projected days sum exactly to the recount of the counted usage |
| codex | `duration_minutes` | 2.87625 | 3 | 0.1237499999999998 | — | declared | explained | codex-parse.ts keeps the fractional minutes of end - start while the shared projection rounds them to whole minutes (the Claude rule); the recount of start and end from the raw lines reproduces both |
| codex | `dynamicWorkflows` | — | — | — | dynamicWorkflows (unknown) | n/a | explained | not produced by codex: no reason recorded — needs review |
| codex | `end_time` | 2026-07-07T22:04:57.680Z | 2026-07-07T22:04:57.680Z | — | — | exact | equal |  |
| codex | `files_modified` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by codex: Git line counts are not present in Codex transcripts. |
| codex | `input_tokens` | 46474 | 46474 | 0 | tokens (partial) | exact | explained | a cumulative counter went DOWN (a restarted series): legacy keeps only the last snapshot, the replay adds every series; the recount of snapshots reproduces both |
| codex | `lines_added` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by codex: Git line counts are not present in Codex transcripts. |
| codex | `lines_removed` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by codex: Git line counts are not present in Codex transcripts. |
| codex | `mcpServers` | — | — | — | mcpServers (not_supported) | n/a | explained | not produced by codex: Codex records no MCP tool at all, so the MCP server cannot be read back off tool_counts. |
| codex | `message_hours` | 11 | — | — | — | declared | explained | legacy takes the local hour of EVERY timestamped transcript line (every role, system lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 sessions equal, A2.7), so it is left legacy-only by decision D25 |
| codex | `model` | gpt-5.4-mini | gpt-5.4-mini | — | model (supported) | exact | explained | the rollout carries no billed usage, so no model.completed names a model; legacy still names the last turn_context model, which the recount reproduces \| legacy names the LAST turn_context model, the projection the model of the FIRST billed turn; the recount of turn_context records reproduces both |
| codex | `output_tokens` | 2735 | 2735 | 0 | tokens (partial) | exact | explained | a cumulative counter went DOWN (a restarted series): legacy keeps only the last snapshot, the replay adds every series; the recount of snapshots reproduces both |
| codex | `rounds` | 3 | 3 | 0 | — | exact | equal |  |
| codex | `skills` | — | — | — | skills (unknown) | n/a | explained | not produced by codex: no reason recorded — needs review |
| codex | `start_time` | 2026-07-07T22:02:05.105Z | 2026-07-07T22:02:05.105Z | — | — | exact | equal |  |
| codex | `tool_counts` | `{"Bash":15}` | `{"Bash":15}` | — | tools (supported) | exact | equal |  |
| codex | `tool_error_categories` | `{}` | `{}` | — | tools (supported) | exact | equal |  |
| codex | `tool_errors` | 0 | 0 | 0 | tools (supported) | exact | equal |  |
| codex | `user_interruptions` | 0 | 2 | 2 | — | declared | explained | codex-parse.ts writes user_interruptions: 0 unconditionally while the projection derives count - 1 from the same user_message turns; the recount of user_message records reproduces both |
| codex | `user_message_count` | 3 | 3 | 0 | — | exact | equal |  |
| codex | `user_message_timestamps` | `["2026-07-07T22:02:40.142Z","2026-07-07T22:02:54.132Z","2026-07-07T22:04:01.794Z"]` | `["2026-07-07T22:02:40.142Z","2026-07-07T22:02:54.132Z","2026-07-07T22:04:01.794Z"]` | — | — | exact | equal |  |
| codex | `user_response_times` | `[]` | `[]` | — | — | exact | equal |  |
| codex | `uses_mcp` | false | false | — | tools (supported) | exact | equal |  |
| codex | `uses_task_agent` | false | false | — | tools (supported) | exact | equal |  |
| codex | `uses_web_fetch` | false | false | — | tools (supported) | exact | equal |  |
| codex | `uses_web_search` | false | false | — | tools (supported) | exact | explained | legacy sets uses_web_search from a web_search_call record, which canonicalTool leaves unmapped, while the projection looks for the canonical 'WebSearch'; the recount of web_search_call records reproduces both |
| gemini | `active_minutes` | 4 | — | — | activeTime (supported) | exact | explained | this integration emits no turn.started/turn.ended (out of scope for this wave), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no gemini entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| gemini | `agents` | — | — | — | agents (not_supported) | n/a | explained | not produced by gemini: Gemini CLI does not record per-subagent breakdowns. |
| gemini | `cache_creation_1h_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| gemini | `cache_creation_5m_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| gemini | `cache_creation_input_tokens` | 0 | 0 | 0 | tokens (partial) | exact | equal |  |
| gemini | `cache_read_input_tokens` | 0 | 0 | 0 | tokens (partial) | exact | equal |  |
| gemini | `compact_count` | — | — | — | compaction (not_supported) | n/a | explained | not produced by gemini: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| gemini | `compact_dropped_tokens` | — | — | — | compaction (not_supported) | n/a | explained | not produced by gemini: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| gemini | `compact_ms` | — | — | — | compaction (not_supported) | n/a | explained | not produced by gemini: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| gemini | `context_tokens` | — | — | — | contextWindow (unknown) | n/a | explained | not produced by gemini: no reason recorded — needs review |
| gemini | `context_window` | — | — | — | contextWindow (unknown) | n/a | explained | not produced by gemini: no reason recorded — needs review |
| gemini | `costUSD` | 0.000675 | 0.00011999999999999999 | -0.000555 | cost (partial) | estimated | explained | the price consequence of the model-switch difference above: both sides sum the identical raw token totals, and repricing legacy at the PROJECTED (first) model equals the projected cost exactly |
| gemini | `daily.<day>.tokens` | — | `{"input":150,"output":15,"cacheRead":0,"cacheWrite":0}` | — | tokens (partial) | exact | explained | per-UTC-day slicing is new for Gemini (P2 §3, declared): legacy carries no daily field at all, the projection derives one bucket per model.completed event's own day (rich-json shape only) — a new capability, not a divergence |
| gemini | `duration_minutes` | 4.5 | 5 | 0.5 | — | declared | explained | gemini-parse.ts computes duration_minutes UNROUNDED ((lastUpdated - startTime) / 60000, both file shapes); session-meta.ts's projection rounds to the nearest minute; round(legacy) equals the projected value exactly |
| gemini | `dynamicWorkflows` | — | — | — | dynamicWorkflows (unknown) | n/a | explained | not produced by gemini: no reason recorded — needs review |
| gemini | `end_time` | 2026-03-01T10:04:30.000Z | 2026-03-01T10:04:30.000Z | — | — | exact | equal |  |
| gemini | `files_modified` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by gemini: Gemini's tool calls name the file they touched but carry no diff counters. |
| gemini | `input_tokens` | 150 | 150 | 0 | tokens (partial) | exact | equal |  |
| gemini | `lines_added` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by gemini: Gemini's tool calls name the file they touched but carry no diff counters. |
| gemini | `lines_removed` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by gemini: Gemini's tool calls name the file they touched but carry no diff counters. |
| gemini | `mcpServers` | — | — | — | mcpServers (not_supported) | n/a | explained | not produced by gemini: Gemini records no MCP tool at all, so the MCP server cannot be read back off tool_counts. |
| gemini | `message_hours` | 3 | — | — | — | declared | explained | legacy takes the local hour of EVERY timestamped transcript line (every role, system lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 sessions equal, A2.7), so it is left legacy-only by decision D25 |
| gemini | `model` | gemini-4-preview | gemini-3-flash-preview | — | model (partial) | exact | explained | legacy's parseRichJson loop overwrites `model` on every 'gemini' message, ending on the LAST one; the projection keeps the FIRST (by order key); the recount of every message's `model` field in the raw bytes reproduces both |
| gemini | `output_tokens` | 15 | 15 | 0 | tokens (partial) | exact | equal |  |
| gemini | `rounds` | 1 | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (out of scope for this wave), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no gemini entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| gemini | `skills` | — | — | — | skills (unknown) | n/a | explained | not produced by gemini: no reason recorded — needs review |
| gemini | `start_time` | 2026-03-01T10:00:00.000Z | 2026-03-01T10:00:00.000Z | — | — | exact | equal |  |
| gemini | `tool_counts` | `{"Edit":1}` | `{"Edit":1}` | — | tools (partial) | exact | equal |  |
| gemini | `tool_error_categories` | `{}` | `{"Edit":1}` | — | tools (partial) | exact | explained | gemini-parse.ts never reads toolCalls[].status and hardcodes tool_errors: 0 / tool_error_categories: {} for both file shapes; the replay's rich-json fold reads status: 'error' as tool.failed, which is real information legacy discards — an independent recount of toolCalls[].status === 'error' (excluding 'cancelled') in the raw bytes equals the projected count exactly, and legacy's side is always 0/{} |
| gemini | `tool_errors` | 0 | 1 | 1 | tools (partial) | exact | explained | gemini-parse.ts never reads toolCalls[].status and hardcodes tool_errors: 0 / tool_error_categories: {} for both file shapes; the replay's rich-json fold reads status: 'error' as tool.failed, which is real information legacy discards — an independent recount of toolCalls[].status === 'error' (excluding 'cancelled') in the raw bytes equals the projected count exactly, and legacy's side is always 0/{} |
| gemini | `user_interruptions` | 0 | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (out of scope for this wave), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no gemini entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| gemini | `user_message_count` | 1 | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (out of scope for this wave), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no gemini entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| gemini | `user_message_timestamps` | `["2026-03-01T10:00:00.000Z"]` | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (out of scope for this wave), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no gemini entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| gemini | `user_response_times` | `[]` | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (out of scope for this wave), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no gemini entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| gemini | `uses_mcp` | false | false | — | tools (partial) | exact | equal |  |
| gemini | `uses_task_agent` | false | false | — | tools (partial) | exact | equal |  |
| gemini | `uses_web_fetch` | false | false | — | tools (partial) | exact | equal |  |
| gemini | `uses_web_search` | false | false | — | tools (partial) | exact | equal |  |
| copilot | `active_minutes` | 0 | — | — | activeTime (supported) | exact | explained | this integration emits no turn.started/turn.ended (P2 §2), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no copilot entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| copilot | `agents` | — | — | — | agents (not_supported) | n/a | explained | not produced by copilot: Sub-agent metrics are not available in Copilot local event logs. |
| copilot | `cache_creation_1h_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| copilot | `cache_creation_5m_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| copilot | `cache_creation_input_tokens` | 0 | 0 | 0 | tokens (partial) | exact | equal |  |
| copilot | `cache_read_input_tokens` | 10 | 10 | 0 | tokens (partial) | exact | equal |  |
| copilot | `compact_count` | — | — | — | compaction (not_supported) | n/a | explained | not produced by copilot: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| copilot | `compact_dropped_tokens` | — | — | — | compaction (not_supported) | n/a | explained | not produced by copilot: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| copilot | `compact_ms` | — | — | — | compaction (not_supported) | n/a | explained | not produced by copilot: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| copilot | `context_tokens` | — | — | — | contextWindow (not_supported) | n/a | explained | not produced by copilot: Copilot's only token report is a cumulative one written at shutdown, and a cumulative total is not a context size. |
| copilot | `context_window` | — | — | — | contextWindow (not_supported) | n/a | explained | not produced by copilot: Copilot's only token report is a cumulative one written at shutdown, and a cumulative total is not a context size. |
| copilot | `costUSD` | 0.00006525000000000001 | 0.00006525000000000001 | 0 | cost (partial) | estimated | equal |  |
| copilot | `daily.<day>.tokens` | — | `{"input":100,"output":20,"cacheRead":10,"cacheWrite":0}` | — | tokens (partial) | exact | explained | per-UTC-day slicing is new for Copilot (P2 §3, declared): legacy carries no daily field at all, the projection derives one bucket (the session.shutdown line's own day) from the cumulative usage report — a new capability, not a divergence |
| copilot | `duration_minutes` | 0.11666666666666667 | 0 | -0.11666666666666667 | — | declared | explained | copilot-parse.ts computes duration_minutes UNROUNDED ((end - start) / 60000); session-meta.ts's projection rounds to the nearest minute; round(legacy) equals the projected value exactly |
| copilot | `dynamicWorkflows` | — | — | — | dynamicWorkflows (unknown) | n/a | explained | not produced by copilot: no reason recorded — needs review |
| copilot | `end_time` | 2026-01-01T10:00:07.000Z | 2026-01-01T10:00:07.000Z | — | — | exact | equal |  |
| copilot | `files_modified` | 0 | 0 | 0 | gitLines (partial) | exact | explained | files of completed edits only: legacy counts at request time, excludes NotebookEdit, takes max() with git |
| copilot | `input_tokens` | 100 | 100 | 0 | tokens (partial) | exact | equal |  |
| copilot | `lines_added` | 0 | 0 | 0 | gitLines (partial) | exact | explained | edit-derived half only: legacy counts edits at request time and takes max() with git diff |
| copilot | `lines_removed` | 0 | 0 | 0 | gitLines (partial) | exact | explained | edit-derived half only: legacy counts edits at request time and takes max() with git diff |
| copilot | `mcpServers` | — | — | — | mcpServers (not_supported) | n/a | explained | not produced by copilot: Copilot keeps MCP names in mcp_tool_names and never records the server. |
| copilot | `message_hours` | 1 | — | — | — | declared | explained | legacy takes the local hour of EVERY timestamped transcript line (every role, system lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 sessions equal, A2.7), so it is left legacy-only by decision D25 |
| copilot | `model` | gpt-5-mini | gpt-5-mini | — | model (supported) | exact | equal |  |
| copilot | `output_tokens` | 20 | 20 | 0 | tokens (partial) | exact | equal |  |
| copilot | `rounds` | 1 | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (P2 §2), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no copilot entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| copilot | `skills` | — | — | — | skills (unknown) | n/a | explained | not produced by copilot: no reason recorded — needs review |
| copilot | `start_time` | 2026-01-01T10:00:00.000Z | 2026-01-01T10:00:00.000Z | — | — | exact | equal |  |
| copilot | `tool_counts` | `{"Bash":1}` | `{"Bash":1}` | — | tools (supported) | exact | equal |  |
| copilot | `tool_error_categories` | `{}` | `{}` | — | tools (supported) | exact | equal |  |
| copilot | `tool_errors` | 0 | 0 | 0 | tools (supported) | exact | equal |  |
| copilot | `user_interruptions` | 0 | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (P2 §2), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no copilot entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| copilot | `user_message_count` | 1 | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (P2 §2), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no copilot entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| copilot | `user_message_timestamps` | `["2026-01-01T10:00:01.000Z"]` | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (P2 §2), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no copilot entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| copilot | `user_response_times` | `[]` | — | — | — | declared | explained | this integration emits no turn.started/turn.ended (P2 §2), and session-meta.ts's TURNS_SINCE/TURN_END_SINCE tables carry no copilot entry either way, so the field is not-projectable for this harness today, not a proven-wrong number |
| copilot | `uses_mcp` | false | false | — | tools (supported) | exact | equal |  |
| copilot | `uses_task_agent` | false | false | — | tools (supported) | exact | equal |  |
| copilot | `uses_web_fetch` | false | false | — | tools (supported) | exact | equal |  |
| copilot | `uses_web_search` | false | false | — | tools (supported) | exact | equal |  |
| antigravity | `active_minutes` | 63 | 63 | 0 | activeTime (supported) | exact | explained | legacy opens an active-time turn only on a non-slash USER_INPUT while counting slash commands as user messages; the replay emits turn.started for every counted USER_INPUT (D22), and recomputing activeMinutesOf over the steps with slash prompts as openers reproduces the projection |
| antigravity | `agentMetrics.invocations[]` | — | present | — | agents (partial) | exact | explained | the child conversation is a child Agent under the run (P2 §2), an improvement over legacy, which has no agentMetrics for agy; each invocation equals legacy's own parse of that child conversation alone (tokens and cost), and the totals equal legacy's rollup minus the parent alone |
| antigravity | `agentMetrics.totalCostUSD` | 0 | 1.1126364000000002 | 1.1126364000000002 | agents (partial) | exact | explained | the child conversation is a child Agent under the run (P2 §2), an improvement over legacy, which has no agentMetrics for agy; each invocation equals legacy's own parse of that child conversation alone (tokens and cost), and the totals equal legacy's rollup minus the parent alone |
| antigravity | `agentMetrics.totalInvocations` | 0 | 1 | 1 | agents (partial) | exact | explained | the child conversation is a child Agent under the run (P2 §2), an improvement over legacy, which has no agentMetrics for agy; each invocation equals legacy's own parse of that child conversation alone (tokens and cost), and the totals equal legacy's rollup minus the parent alone |
| antigravity | `agentMetrics.totalTokens` | 0 | 1929735 | 1929735 | agents (partial) | exact | explained | the child conversation is a child Agent under the run (P2 §2), an improvement over legacy, which has no agentMetrics for agy; each invocation equals legacy's own parse of that child conversation alone (tokens and cost), and the totals equal legacy's rollup minus the parent alone |
| antigravity | `agentMetrics.unmeasuredInvocations` | 0 | 0 | 0 | agents (partial) | exact | equal |  |
| antigravity | `cache_creation_1h_input_tokens` | — | — | — | tokens (supported) | exact | equal |  |
| antigravity | `cache_creation_5m_input_tokens` | — | — | — | tokens (supported) | exact | equal |  |
| antigravity | `cache_creation_input_tokens` | 0 | 0 | 0 | tokens (supported) | exact | equal |  |
| antigravity | `cache_read_input_tokens` | 2367988 | 980382 | -1387606 | tokens (supported) | exact | explained | legacy folds each invoke_subagent child conversation into the parent session (rollUpAntigravitySessions); the replay reports it as a child Agent, so the parent alone — legacy's own parser over the parent's transcript and gen_metadata, unmerged — reproduces the projection |
| antigravity | `compact_count` | — | — | — | compaction (not_supported) | n/a | explained | not produced by antigravity: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| antigravity | `compact_dropped_tokens` | — | — | — | compaction (not_supported) | n/a | explained | not produced by antigravity: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| antigravity | `compact_ms` | — | — | — | compaction (not_supported) | n/a | explained | not produced by antigravity: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| antigravity | `context_tokens` | 81998 | 81998 | 0 | contextWindow (supported) | exact | equal |  |
| antigravity | `context_window` | 128000 | 128000 | 0 | contextWindow (supported) | exact | equal |  |
| antigravity | `costUSD` | 2.2093122 | 1.0966757999999999 | -1.1126364 | cost (supported) | estimated | explained | legacy folds each invoke_subagent child conversation into the parent session (rollUpAntigravitySessions); the replay reports it as a child Agent, so the parent alone — legacy's own parser over the parent's transcript and gen_metadata, unmerged — reproduces the projection |
| antigravity | `daily.<day>.tokens` | — | `{"input":532274,"output":20161,"cacheRead":980382,"cacheWrite":0}` | — | tokens (supported) | exact | explained | per-UTC-day slicing is new for agy (P2 §3): legacy agy writes no `daily`, and the projected days sum exactly to the projected session totals |
| antigravity | `duration_minutes` | 85.96666666666667 | 86 | 0.03333333333333144 | — | declared | explained | the projection rounds duration to whole minutes as Claude's legacy does, while agy's legacy keeps the fraction; (end - start) / 60000 over the recorded instants reproduces legacy and its Math.round the projection |
| antigravity | `dynamicWorkflows` | — | — | — | dynamicWorkflows (unknown) | n/a | explained | not produced by antigravity: no reason recorded — needs review |
| antigravity | `end_time` | 2026-08-14T15:19:38.000Z | 2026-08-14T15:19:38.000Z | — | — | exact | equal |  |
| antigravity | `files_modified` | 8 | 4 | -4 | gitLines (partial) | exact | explained | files of completed edits only: legacy counts at request time, excludes NotebookEdit, takes max() with git |
| antigravity | `input_tokens` | 1059186 | 532274 | -526912 | tokens (supported) | exact | explained | legacy folds each invoke_subagent child conversation into the parent session (rollUpAntigravitySessions); the replay reports it as a child Agent, so the parent alone — legacy's own parser over the parent's transcript and gen_metadata, unmerged — reproduces the projection |
| antigravity | `lines_added` | 287 | 233 | -54 | gitLines (partial) | exact | explained | edit-derived half only: legacy counts edits at request time and takes max() with git diff |
| antigravity | `lines_removed` | 0 | 0 | 0 | gitLines (partial) | exact | explained | edit-derived half only: legacy counts edits at request time and takes max() with git diff |
| antigravity | `mcpServers` | — | — | — | mcpServers (not_supported) | n/a | explained | not produced by antigravity: Antigravity writes MCP tools as mcp_ with one underscore and call_mcp_tool, so the MCP server cannot be read back off tool_counts. |
| antigravity | `message_hours` | 8 | — | — | — | declared | explained | legacy takes the local hour of EVERY timestamped transcript line (every role, system lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 sessions equal, A2.7), so it is left legacy-only by decision D25 |
| antigravity | `model` | gemini-3.6-flash | gemini-3.6-flash | — | model (supported) | exact | equal |  |
| antigravity | `output_tokens` | 35378 | 20161 | -15217 | tokens (supported) | exact | explained | legacy folds each invoke_subagent child conversation into the parent session (rollUpAntigravitySessions); the replay reports it as a child Agent, so the parent alone — legacy's own parser over the parent's transcript and gen_metadata, unmerged — reproduces the projection |
| antigravity | `rounds` | 3 | 3 | 0 | — | exact | equal |  |
| antigravity | `skills` | — | — | — | skills (unknown) | n/a | explained | not produced by antigravity: no reason recorded — needs review |
| antigravity | `start_time` | 2026-08-14T13:53:40.000Z | 2026-08-14T13:53:40.000Z | — | — | exact | equal |  |
| antigravity | `tool_counts` | `{"Bash":21,"Write":8,"invoke_subagent":1,"Grep":2,"Read":14,"Glob":3,"send_message":1}` | `{"Bash":20,"Write":4,"invoke_subagent":1}` | — | tools (supported) | exact | explained | legacy folds each invoke_subagent child conversation into the parent session (rollUpAntigravitySessions); the replay reports it as a child Agent, so the parent alone — legacy's own parser over the parent's transcript and gen_metadata, unmerged — reproduces the projection |
| antigravity | `tool_error_categories` | `{"exit_code":5}` | `{"exit_code":5}` | — | tools (supported) | exact | equal |  |
| antigravity | `tool_errors` | 5 | 5 | 0 | tools (supported) | exact | equal |  |
| antigravity | `user_interruptions` | 0 | 2 | 2 | — | declared | explained | legacy agy hard-codes user_interruptions: 0 (it measures no interruption); the projection derives count - 1 from turn.started — declared not-projectable for agy |
| antigravity | `user_message_count` | 3 | 3 | 0 | — | exact | equal |  |
| antigravity | `user_message_timestamps` | `["2026-08-14T13:53:40Z","2026-08-14T14:49:42Z","2026-08-14T15:19:38Z"]` | `["2026-08-14T13:53:40Z","2026-08-14T14:49:42Z","2026-08-14T15:19:38Z"]` | — | — | exact | equal |  |
| antigravity | `user_response_times` | `[]` | `[]` | — | — | exact | equal |  |
| antigravity | `uses_mcp` | false | false | — | tools (supported) | exact | equal |  |
| antigravity | `uses_task_agent` | true | true | — | tools (supported) | exact | equal |  |
| antigravity | `uses_web_fetch` | false | false | — | tools (supported) | exact | equal |  |
| antigravity | `uses_web_search` | false | false | — | tools (supported) | exact | equal |  |
| kimi | `active_minutes` | 0 | — | — | activeTime (supported) | exact | explained | not recorded by this adapter version (events replayed before turn.ended existed); absent, not zero |
| kimi | `agentMetrics.invocations[]` | — | present | — | agents (partial) | exact | explained | a kimi subagent is a child Agent under the run (P2), an improvement over legacy, which has no agentMetrics for kimi; its tokens are ALREADY in the session totals (legacy's all-agents rule), so a reader must not add them again — proven per session: the totals equal the subagents' own model.completed sums |
| kimi | `agentMetrics.totalCostUSD` | 0 | 0.000055 | 0.000055 | agents (partial) | exact | explained | a kimi subagent is a child Agent under the run (P2), an improvement over legacy, which has no agentMetrics for kimi; its tokens are ALREADY in the session totals (legacy's all-agents rule), so a reader must not add them again — proven per session: the totals equal the subagents' own model.completed sums |
| kimi | `agentMetrics.totalInvocations` | 0 | 1 | 1 | agents (partial) | exact | explained | a kimi subagent is a child Agent under the run (P2), an improvement over legacy, which has no agentMetrics for kimi; its tokens are ALREADY in the session totals (legacy's all-agents rule), so a reader must not add them again — proven per session: the totals equal the subagents' own model.completed sums |
| kimi | `agentMetrics.totalTokens` | 0 | 35 | 35 | agents (partial) | exact | explained | a kimi subagent is a child Agent under the run (P2), an improvement over legacy, which has no agentMetrics for kimi; its tokens are ALREADY in the session totals (legacy's all-agents rule), so a reader must not add them again — proven per session: the totals equal the subagents' own model.completed sums |
| kimi | `agentMetrics.unmeasuredInvocations` | 0 | 0 | 0 | agents (partial) | exact | equal |  |
| kimi | `cache_creation_1h_input_tokens` | — | — | — | tokens (supported) | exact | equal |  |
| kimi | `cache_creation_5m_input_tokens` | — | — | — | tokens (supported) | exact | equal |  |
| kimi | `cache_creation_input_tokens` | 3 | 3 | 0 | tokens (supported) | exact | equal |  |
| kimi | `cache_read_input_tokens` | 5 | 5 | 0 | tokens (supported) | exact | equal |  |
| kimi | `compact_count` | — | — | — | compaction (not_supported) | n/a | explained | not produced by kimi: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| kimi | `compact_dropped_tokens` | — | — | — | compaction (not_supported) | n/a | explained | not produced by kimi: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| kimi | `compact_ms` | — | — | — | compaction (not_supported) | n/a | explained | not produced by kimi: Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero. |
| kimi | `context_tokens` | 108 | 108 | 0 | contextWindow (supported) | exact | equal |  |
| kimi | `context_window` | — | — | — | contextWindow (supported) | exact | equal |  |
| kimi | `costUSD` | 0.00040850000000000006 | 0.00040850000000000006 | 0 | cost (supported) | estimated | explained | legacy prices the whole session at that last-read (subagent) model; the projected counters priced at legacy's model reproduce legacy's figure exactly, so the difference is the model choice alone (costByDimension prices every response at its own model) |
| kimi | `daily.<day>.tokens` | — | `{"input":100,"output":20,"cacheRead":5,"cacheWrite":3}` | — | tokens (supported) | exact | explained | master spec §40: per-UTC-day token slicing is new for kimi — legacy's kimi shape never computed a `daily` breakdown at all, so this bucket is derived from this session's own model.completed timestamps, which is the improvement §40 declares rather than a silent one |
| kimi | `duration_minutes` | 2 | 2 | 0 | — | exact | equal |  |
| kimi | `dynamicWorkflows` | — | — | — | dynamicWorkflows (unknown) | n/a | explained | not produced by kimi: no reason recorded — needs review |
| kimi | `end_time` | 2023-11-14T22:15:00.000Z | 2023-11-14T22:15:00.000Z | — | — | exact | equal |  |
| kimi | `files_modified` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by kimi: Kimi records the Edit/Write strings but no diff counters. |
| kimi | `input_tokens` | 100 | 100 | 0 | tokens (supported) | exact | equal |  |
| kimi | `lines_added` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by kimi: Kimi records the Edit/Write strings but no diff counters. |
| kimi | `lines_removed` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by kimi: Kimi records the Edit/Write strings but no diff counters. |
| kimi | `message_hours` | 1 | — | — | — | declared | explained | legacy takes the local hour of EVERY timestamped transcript line (every role, system lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 sessions equal, A2.7), so it is left legacy-only by decision D25 |
| kimi | `model` | claude-sonnet-5 | claude-sonnet-5 | — | model (supported) | exact | explained | legacy names a kimi session after the model of the LAST usage.record it reads (agents are read main-first), so a subagent's model can name the whole session; the projection names it after the main agent's first model — proven per session: legacy's model is one a subagent reported |
| kimi | `output_tokens` | 20 | 20 | 0 | tokens (supported) | exact | equal |  |
| kimi | `rounds` | 1 | — | — | — | declared | explained | not recorded by this adapter version (events replayed before turn.started existed); absent, not zero |
| kimi | `skills` | — | — | — | skills (unknown) | n/a | explained | not produced by kimi: no reason recorded — needs review |
| kimi | `start_time` | 2023-11-14T22:13:20.000Z | 2023-11-14T22:13:20.000Z | — | — | exact | equal |  |
| kimi | `tool_counts` | `{"Write":1,"Bash":1}` | `{"Write":1,"Bash":1}` | — | tools (supported) | exact | equal |  |
| kimi | `tool_error_categories` | `{}` | `{}` | — | tools (supported) | exact | equal |  |
| kimi | `tool_errors` | 0 | 0 | 0 | tools (supported) | exact | equal |  |
| kimi | `user_interruptions` | 0 | — | — | — | declared | explained | not recorded by this adapter version (events replayed before turn.started existed); absent, not zero |
| kimi | `user_message_count` | 1 | — | — | — | declared | explained | not recorded by this adapter version (events replayed before turn.started existed); absent, not zero |
| kimi | `user_message_timestamps` | `["2023-11-14T22:13:20.100Z"]` | — | — | — | declared | explained | not recorded by this adapter version (events replayed before turn.started existed); absent, not zero |
| kimi | `user_response_times` | `[]` | — | — | — | declared | explained | not recorded by this adapter version (events replayed before turn.ended existed); absent, not zero |
| kimi | `uses_mcp` | false | false | — | tools (supported) | exact | equal |  |
| kimi | `uses_task_agent` | false | false | — | tools (supported) | exact | equal |  |
| kimi | `uses_web_fetch` | false | false | — | tools (supported) | exact | equal |  |
| kimi | `uses_web_search` | false | false | — | tools (supported) | exact | equal |  |
| opencode | `active_minutes` | 1 | 1 | 0 | activeTime (partial) | exact | equal |  |
| opencode | `agents` | — | — | — | agents (not_supported) | n/a | explained | not produced by opencode: Every real session had parent_id/workspace_id null; the schema's nested-session columns exist but were never observed populated, so every session folds into one main agent with no per-agent breakdown. |
| opencode | `cache_creation_1h_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| opencode | `cache_creation_5m_input_tokens` | — | — | — | tokens (partial) | exact | equal |  |
| opencode | `cache_creation_input_tokens` | 0 | 0 | 0 | tokens (partial) | exact | equal |  |
| opencode | `cache_read_input_tokens` | 10 | 10 | 0 | tokens (partial) | exact | equal |  |
| opencode | `compact_count` | — | — | — | compaction (unknown) | n/a | explained | not produced by opencode: no reason recorded — needs review |
| opencode | `compact_dropped_tokens` | — | — | — | compaction (unknown) | n/a | explained | not produced by opencode: no reason recorded — needs review |
| opencode | `compact_ms` | — | — | — | compaction (unknown) | n/a | explained | not produced by opencode: no reason recorded — needs review |
| opencode | `context_tokens` | — | — | — | contextWindow (unknown) | n/a | explained | not produced by opencode: no reason recorded — needs review |
| opencode | `context_window` | — | — | — | contextWindow (unknown) | n/a | explained | not produced by opencode: no reason recorded — needs review |
| opencode | `costUSD` | 0.001413 | 0.001413 | 0 | cost (partial) | exact | equal |  |
| opencode | `daily.<day>.tokens` | — | `{"input":270,"output":40,"cacheRead":10,"cacheWrite":0}` | — | tokens (partial) | exact | explained | opencode has no legacy equivalent to compare a day-keyed token split against (this integration has no adapter at all); reclassified only because the projected days sum EXACTLY to the projected session totals, proven per session below — never assumed from the field's absence. |
| opencode | `duration_minutes` | 1 | 1 | 0 | — | exact | equal |  |
| opencode | `dynamicWorkflows` | — | — | — | dynamicWorkflows (not_supported) | n/a | explained | not produced by opencode: opencode has no equivalent of the multi-agent orchestration tool this flag gates. |
| opencode | `end_time` | 2023-11-14T22:14:20.000Z | 2023-11-14T22:14:20.000Z | — | — | exact | equal |  |
| opencode | `files_modified` | 0 | 1 | 1 | gitLines (not_supported) | n/a | explained | not produced by opencode: The session table carries git-shaped summary columns but both real sessions show 0, and no tool part carries a diff field, so this is not wired into the replay. |
| opencode | `input_tokens` | 270 | 270 | 0 | tokens (partial) | exact | equal |  |
| opencode | `lines_added` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by opencode: The session table carries git-shaped summary columns but both real sessions show 0, and no tool part carries a diff field, so this is not wired into the replay. |
| opencode | `lines_removed` | 0 | 0 | 0 | gitLines (not_supported) | n/a | explained | not produced by opencode: The session table carries git-shaped summary columns but both real sessions show 0, and no tool part carries a diff field, so this is not wired into the replay. |
| opencode | `mcpServers` | — | — | — | mcpServers (not_supported) | n/a | explained | not produced by opencode: No mcp__-shaped (or any MCP-prefixed) tool name was observed among the real tool parts measured (bash, write, read, skill), so this replay never has a server to read back. |
| opencode | `message_hours` | 0 | — | — | — | declared | explained | legacy takes the local hour of EVERY timestamped transcript line (every role, system lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 sessions equal, A2.7), so it is left legacy-only by decision D25 |
| opencode | `model` | fixture-model-a | fixture-model-a | — | model (partial) | exact | equal |  |
| opencode | `output_tokens` | 40 | 40 | 0 | tokens (partial) | exact | equal |  |
| opencode | `rounds` | 3 | 3 | 0 | — | exact | equal |  |
| opencode | `skills` | — | — | — | skills (unknown) | n/a | explained | not produced by opencode: no reason recorded — needs review |
| opencode | `start_time` | 2023-11-14T22:13:20.000Z | 2023-11-14T22:13:20.000Z | — | — | exact | equal |  |
| opencode | `tool_counts` | `{"Bash":1,"Write":1,"Read":1}` | `{"Bash":1,"Write":1,"Read":1}` | — | tools (partial) | exact | equal |  |
| opencode | `tool_error_categories` | `{"Read":1}` | `{"Read":1}` | — | tools (partial) | exact | equal |  |
| opencode | `tool_errors` | 1 | 1 | 0 | tools (partial) | exact | equal |  |
| opencode | `user_interruptions` | 2 | 2 | 0 | — | exact | equal |  |
| opencode | `user_message_count` | 3 | 3 | 0 | — | exact | equal |  |
| opencode | `user_message_timestamps` | `["2023-11-14T22:13:22.000Z","2023-11-14T22:13:40.000Z","2023-11-14T22:14:00.000Z"]` | `["2023-11-14T22:13:22.000Z","2023-11-14T22:13:40.000Z","2023-11-14T22:14:00.000Z"]` | — | — | exact | equal |  |
| opencode | `user_response_times` | `[12,10]` | `[12,10]` | — | — | exact | equal |  |
| opencode | `uses_mcp` | false | false | — | tools (partial) | exact | equal |  |
| opencode | `uses_task_agent` | false | false | — | tools (partial) | exact | equal |  |
| opencode | `uses_web_fetch` | false | false | — | tools (partial) | exact | equal |  |
| opencode | `uses_web_search` | false | false | — | tools (partial) | exact | equal |  |
