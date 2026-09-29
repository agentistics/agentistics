# F — Design: native "ultracode" orchestration (A) and native artifact tools (B)

Date: 2026-09-28. Status: design proposal for the owner. Documentation only; no product code touched.

Source keys used below (all inside research-salvage/out/, public-docs research; nothing here is copied source):
- `[B:F70]` = row F70 in B-features.md (same for F71..F100); `[B:§3]` = its "Orchestration patterns" table; `[B:top15#n]`.
- `[A:row "…"]` = a row of A-features.md located by its capability name; `[A:top15#n]`.
- `[C:n]` = numbered row n in C-lifecycle.md; `[C:top10#n]`.
- `[D:n]` = numbered row n in D-quality-tools.md; `[D:top10#n]`; `[D:notes]`.
- `[INV]` = research-salvage/INVENTORY.md. `[B3]` = 2026-09-20-runtime-b3-tool-catalogue.md. `[B8]` = 2026-09-28-runtime-b8-catalogue.md.
- The reference product's scripted-workflow behaviour is cited from its public documentation as summarised in `[B:F70-F76]` (source key CW there). It is precedent, never a dependency.

Vocabulary decision: the product already has "Dynamic Workflows" (the measurement of Claude Code's Workflow runs: `workflow-metrics.ts`, the repo-detail tab). To keep the two from being confused, the native feature is called an **orchestration**; "ultracode" is the owner's name for the mode and stays as the label on the launch surface. Both words appear below.

---

# Part A — Native ultracode: deterministic multi-agent orchestration

## A.1 Thesis: why ours beats the references

What the reference does (public docs, `[B:F70-F76]`, `[B:§3 "Scripted workflows"]`): a script in a restricted JavaScript dialect holds the loops and intermediate results; the model's context sees only the answer; caps of 16 concurrent agents, 4096 items, 1000 agents; a warning above 25 agents or about 1.5M projected tokens; a run dashboard that shows per-phase agent counts, tokens and elapsed time; replay that reruns the first divergent agent and everything after it; a plan-approval prompt with Once/Always/Deny that is skipped in bypass and headless; and an effort level whose keyword in a typed prompt starts planning workflows automatically and switches off the size warning and the concurrency limit.

Where we are structurally better, each point resting on something already planned or built:

1. **Exact cost per phase and per agent, in money, from the journal.** Every model call already lands in the canonical SQLite journal with exact usage, cost and provenance, and one billed response is counted once (`[INV]`, master spec P1). An orchestrated agent is an Agent entity carrying `orchestrationId / phase / role / stepKey / attempt`, so "what did the verify phase cost" is a `GROUP BY`, not a counter kept beside the run. The reference documents counts, tokens and elapsed; we can show dollars with provenance, including the price of every schema retry and every skeptic.
2. **Hard budgets, not warnings.** The reference's caps bound the shape of a run and its size guidance is advisory. Ours are ceilings in money, tokens, agents and wall clock, enforced before each call by a ledger that reserves the worst case first and settles to the exact figure after (A.2.6). A run cannot exceed a ceiling the person typed, except by one in-flight billed response, which the card states.
3. **Launching is a person's act, with a cost shown first.** The owner lost money to an orchestration the model started on its own with the most expensive model inherited. The reference lets a typed keyword start planning automatically and lets "Always" pre-approve `[B:F73, F76]`. We refuse all three: no model-reachable launch path, no keyword trigger, no "always", no default model (A.2.4).
4. **Content-keyed resume.** The reference replays by start order, so inserting or reordering one agent reruns everything after it `[B:F71]`. We key each step by what it would compute, so an edit reruns only the steps whose inputs changed and their dependents (A.2.8).
5. **Provenance on every result.** A result records the agent, journal event ids, model, effort, cache origin (fresh or reused from run X) and the workspace stamp it was computed against. A finding in a report can be traced to the skeptics that failed to refute it.
6. **ALM integration.** A run is filed under a task or subtask; its per-phase cost rolls into the task's measurement (which is built through sessions: `task-rollup.ts`), and its report is an artifact attached to a criterion (Part B). The references have no board.
7. **Cross-harness steps.** A step may delegate to another installed harness (B6.2) and be measured by the product's existing per-harness readers. The reference's scripts run its own agents only. Where that harness's spend cannot be hard-bounded we say so and mark the phase "soft-bounded" instead of pretending (A.2.9).
8. **Policy inheritance that cannot widen.** Every orchestrated agent runs under the intersection of the launching session's policy layers, its profile and the step's tool list. The deny floor never lifts (A.2.7).

What we deliberately do not copy: cloud fleets that conflict with local-first `[D:3]`; the keyword trigger `[B:F76]`; the "Always" approval `[B:F73]`; caps as large as 4096/1000 as defaults.

## A.2 Design in our architecture

### A.2.1 Placement and ports (D23)

- The engine (script model, static checker, schema validator, estimator, ledger, cache keys, verb library, run state machine) is a **pure-core plus ports** module in `packages/runtime`: `orchestration/`. It imports nothing from server/web.
- Ports injected by the host: `AgentRunner` (starts a B6.1 agent with a spec, returns a handle and a result stream), `Journal` (append/query), `Clock`, `WorktreeProvider` (git.worktree, H15), `DelegateRunner` (B6.2), `Sandbox` (the interpreter, A.2.3), `PersonConfirmation` factory (A.2.4).
- The server hosts runs (B4.6) so that they survive a window closing; web, TUI and VS Code are windows onto one run, exactly as they are onto one session.

### A.2.2 The script model and its verbs

A script is a small program, not a prompt. It is **deterministic given the results the verbs return**, which is what makes resume sound. It has three inputs: `args` (validated against the manifest's args schema), the results of verbs, and the budget readouts. Its only outputs are verb calls and a final `return` value.

Manifest (`manifest.json`, beside the script), strictly validated, unknown keys refused (B8 §3.2 stance):
- `name`, `description`, `phases[]` (declared, so the progress tree and the estimate exist before anything runs), `args` schema, `roles` (named agent roles: `scout`, `worker`, `judge`, …, each with a profile, a tool allowlist, `reads`/`writes`, `spawn: false` by default) and **no model** (models are bound at launch, A.2.4), `defaults` for caps, `maxItems` per fan-out, `effect` flags for steps with external side effects.

Verbs (the whole host API; nothing else crosses into the interpreter):

| Verb | Meaning |
|---|---|
| `agent({ role, prompt, data?, schema?, phase?, reads?, effort? })` | run one B6.1 agent; returns the schema-valid structured result, or `null` with a reason (`stopped`, `budget`, `schema-failed`, `policy-denied`). `data` is passed to the agent in a fenced block, apart from instructions, and journaled as data (prompt-injection chain hygiene) |
| `parallel([...thunks], { limit })` | run independent verb calls concurrently; results in input order |
| `pipeline(items, ...stages)` | each item flows through the stages independently; **no barrier between stages** — item 3 can be in stage 2 while item 9 is still in stage 1 |
| `phase(name, fn)` | groups verbs for the progress tree, per-phase ceilings and per-phase cost |
| `judge(candidates, { rubric, panel, aggregate })` | N judges each score against a rubric schema; the **aggregate is code** (median, mean, majority), never another model call |
| `verify(claims, { skeptics, refuteAt, evidence })` | adversarial verification (A.2.9a) |
| `untilDry(round, { key, maxRounds })` | loop-until-dry: repeat `round` until a round yields no new results under the dedupe `key`, or `maxRounds`, or the budget |
| `critic({ goal, results, maxGaps })` | completeness critic: an agent that lists what the union of results does not cover, as a `gaps[]` schema; the script decides whether to run another round |
| `delegate({ harness, prompt, ... })` | a step run by another harness through B6.2 (A.2.9) |
| `dedupe`, `groupBy`, `sortBy`, `sum`, `pick` | pure JSON helpers; there is no other data API |
| `log(msg)` | an event line in the run (journal `orch.log`) |
| `budget()` | read-only: `{ spentUSD, reservedUSD, ceilingUSD, agents, ceilingAgents }`, so a script can degrade gracefully (skip an optional critic when fewer than X remains) |

Structured outputs: every `agent()` may carry a JSON schema (a documented subset: object, array, string, number, integer, boolean, enum, required, items, `additionalProperties: false`). The result is validated in code; a failure is retried with the validation message as feedback up to `schemaRetries` (default 2, hard max 5, comparable to the reference `[A:row "Structured output with schema validation and retries"]`). Each retry is a separate billed response, journaled as `attempt n`. A schema that is contradictory or unsatisfiable is refused by the static check before launch.

What a script cannot do, by construction: no `import`, `require`, `eval`, `Function`, `fetch`, timers, `Date`, `Math.random` (the last two throw, so a script cannot silently diverge on replay `[B:F71]`), no filesystem, no shell. Agents read files and run tools under policy; the script sees only their structured results. A script that wants to look at a file asks an agent to.

### A.2.3 The interpreter and its isolation (D9)

Options weighed:
1. Declarative DAG in JSON. Safe and trivially estimable, but it cannot express loop-until-dry or data-dependent fan-out without becoming a language. Kept only as a **subset**: the manifest's `phases` and the built-ins' shape.
2. A worker thread or subprocess running plain JS. Not a security boundary (a Bun Worker has the runtime's APIs); an OS-sandboxed child is a cost D9 says to pay only on demand.
3. **Recommended: a JavaScript engine compiled to WebAssembly (QuickJS-class) with a fresh context per run.** The only host functions installed are the verbs above. Values cross the boundary as JSON only (no function or object references), size-capped. The engine has a memory limit and an interrupt handler for a CPU-time limit (a `while(true)` dies with `script-timeout`, journaled), and script CPU time is metered separately from agent time. No WASI filesystem or network is provided.

This honours D9 in spirit: a script is treated as untrusted code from the first day (a project script arrives from a cloned repository), it is not a plugin loader, and it has no path to the host except the verbs. The verbs themselves validate every argument against the manifest (unknown role, model not bound, fan-out over `maxItems`, writer without worktree: refused, in a sentence, journaled). A dedicated escape-test suite is a launch requirement (item ORC.2). Open question Q3 asks the owner to accept the WASM dependency.

### A.2.4 Launching: a person's act, with a cost card, and no default model

Invariants (each has a test, and the first two are structural):

1. **There is no tool that launches an orchestration.** `orchestration.*` model-facing tools are read-only (A.3). The runtime's `launch(plan, confirmation)` requires a `PersonConfirmation` value that only the host can mint, and only from a person input event on a surface (a keypress/click/typed command in web, TUI, VS Code, or explicit CLI flags). Model output, tool results, files, scheduled text, relayed messages and webhooks cannot produce one. Same shape as `chat-gate.ts`: the door is closed in code, not by a prompt instruction.
2. **No keyword or mode switch starts a run.** Typing "ultracode" in a prompt does nothing special. The owner's word names the surface (`/orchestrate`, the "Ultracode" panel), not a trigger.
3. **Model per step is explicit.** The manifest names roles; the **launch card binds every role to a concrete `provider/model` and effort**. `inherit`/`same as session` is not a value. A script naming a model directly is refused by the static check (so a project script cannot choose which paid model a person's key is billed against, the same reasoning as B8 §3.4 `defaultModel` being user-scope only). A built-in ships suggested bindings; the person sees and confirms each one with its price per million tokens and its provenance (`official / community / builtin`, from the pricing table). A model the product cannot price cannot carry a dollar ceiling, so a run with a dollar ceiling refuses it, in words.
4. **A cost is shown before anything is spent, with its basis.** Estimate = `low / likely / high`, computed from: the script's static shape (agent call sites, `maxItems` fan-out bounds, `maxRounds`, panel sizes, schema retries), times per-role token figures **measured from this machine's journal** for the same role and profile in earlier runs (median and p90), times the bound models' prices. With no measured basis it says "no measured basis", shows only the **maximum the ceilings allow**, and the person must set the ceiling. It is labelled an estimate and never rendered as a fact. It is a separate question from the ceiling: the ceiling is what is enforced.
5. **A ceiling is mandatory.** No "unlimited". The card requires: `maxUSD`, `maxTokens` (optional when USD is priceable), `maxAgents`, `maxWallClock`, `concurrency` (default 4, hard max 16 unless the card raises it, which adds a warning row). Defaults come from the manifest but the person sees and can edit each.
6. **The card also shows**: source (built-in / user / project and its trust state), phase list, args, min-max agent count, which roles can **write** (and that they will do so in worktrees), which steps delegate to another harness and that those are soft-bounded, which task it is filed under, and "view script" (raw source). Buttons: Launch, Estimate only, Edit models, Cancel. There is no "Always allow" and nothing about a run is remembered as consent for the next one. Trusting a script's hash is a separate, reading-only concept in B8 §4 and never carries a spending grant.
7. **Headless and scheduled**: `agentop code --orchestrate <name> --args … --max-usd N --model role=provider/model … --json`. Every ceiling and every role binding is a required flag; missing one is exit code 2 with a sentence. It is a person's act by construction (a person typed the flags); a schedule or relayed message may not synthesise one.
8. The model may not even *suggest* by side channel in v1 (Q4 asks whether a text-only hint such as "the /review orchestration exists" belongs in the system prompt; default no).

### A.2.5 Where scripts live — a B8 catalogue kind, plus built-ins

- New B8 kind `orchestration` alongside `command | skill | agent | mcpServer | permissionProfile | afterEdit` (`[B8 §3.1]`); same `CatalogueEntry` fields, same precedence (`project > user > compat > builtin`, powers narrow), same validation-problems-as-sentences and unknown-key refusal.
- Layout: `<AGENTISTICS_DIR>/harness/orchestrations/<name>/{manifest.json,script.js}` (user) and `<workspace>/.agentistics/orchestrations/<name>/…` (project). User scope joins the `ALWAYS` backup allowlist through the entry B8.2 already adds for `.agentistics/harness`.
- **Project scope is untrusted until the folder is trusted (B8 §4)**: listed, disabled, showing its sentence. A project script can never add a tool, a server or a spend grant the wider scope did not give; its manifest can only narrow (fewer tools, fewer agents, lower defaults).
- A custom markdown command (B8 §5.1) may declare `orchestration: <name>` so `/mycmd args` opens the launch card. It still opens a card; it never launches.
- **Saving**: after a run, "save script" copies the script and manifest into user scope (explicit, a person's act, diffable). Run history is never auto-promoted.
- **Built-ins** are compiled into `packages/runtime` **as scripts in this same language** (so `/orchestration show review` prints real source, and a user copy is a starting point, not a fork of hidden code):
  - `review`: N finder agents, one per lens (correctness, security, tests, edge cases; lenses as an arg), then `verify` on every finding, `dedupe`, severity ranking by code, output a `findings` artifact (B.2.2). Shape recorded in `[D:notes]` (parallel finders, refutation pass, ranked deduplicated report) and `[D:top10#1]`, `[B:F48]`.
  - `research`: read-only scouts per sub-question (local files; `web.fetch` only if that tool is granted), `verify` on each claim that has a source, `critic`, a report artifact with sources and per-claim verdicts.
  - `audit`: `pipeline` over directories or packages (finder then verifier per unit, no barrier), `untilDry` over a rotating lens list, `critic` for coverage, report artifact.
  - `verify-claims`: takes a list of statements, runs skeptics, returns verdicts (useful on its own for checking an agent's "done").
  - `batch-edit`: decompose (one planning agent, output schema), **person approves the unit list on a second card**, then one writer agent per unit each in its own worktree, results as patches, an explicit integrate step (ask class). Same shape as `[A:top15#6]`.

### A.2.6 Budgets: ceilings the ledger enforces

- **Ledger** (pure, in the runtime): `ceiling`, `reserved`, `spent`. Before an agent starts, the ledger **reserves that agent's own worst case** (its per-agent cap, itself bounded by its phase cap and by the run's remaining). If the reservation does not fit, the step waits (concurrency shrinks) or, if it can never fit, returns `null: budget`. When the agent finishes (or is stopped), the reservation is released and the exact journal figure is charged. Parallel agents therefore cannot jointly overshoot.
- **Per-agent enforcement** is the B6.1 budget (turns, tokens, wall clock) plus a USD cap computed against the bound model's price; the agent is stopped between calls when the next call could cross it.
- **Stated limit, shown on the card**: one billed response can be in flight when a cap is reached, so the worst overshoot is one response of the most expensive concurrently running model. The estimate card includes that figure ("worst overshoot about $X") instead of claiming zero.
- **Exhaustion pauses, never silently truncates.** On a run ceiling the run enters `paused-budget`: in-flight agents finish within their reservations, no new agent starts, state is checkpointed, the person sees "raise the ceiling by $Y to continue or stop". Raising the ceiling is a person's act and appends an event. A run never fails because it ran out of money mid-way and loses its work.
- **Caps** (agents per run, items per fan-out, depth) are hard limits with lower defaults than the reference's published ones `[B:F72]` (proposal: 200 agents, 256 items, concurrency 4/16). The card may raise them for one run with a visible warning row. The reference's "large-run warning at 25 agents or ~1.5M tokens" is replaced by the estimate card itself, which is always shown.
- Orchestrations cannot start orchestrations: an orchestrated agent has no launch path (invariant 1), so run-in-run nesting and cost explosion by recursion do not exist.

### A.2.7 Composition with B6.1, the policy and worktrees

- Orchestrated agents are B6.1 agents scheduled by the host, not by a model's `agent.spawn` call. They count toward the same depth cap: the orchestration owner is depth 0, an orchestrated agent is depth 1, and by default `spawn: false` (flat). A step may allow `spawn: true` up to the D-T4 cap of 2. The runtime's own records are the authoritative list, not the parent's tool log (D-T4).
- **No agent exceeds its parent's grants.** Effective policy of an orchestrated agent = launching session's policy layers ∩ the role's profile ∩ the step's tool allowlist (B8 §3.5: anything that grants power narrows). The deny floor never lifts and applies unchanged.
- **Unattended agents cannot prompt.** An orchestrated agent whose action would be `ask` cannot open a dialog in the middle of a fan-out of 40. The rule: it is **denied with a reason** (a `policy.denied` event, the agent sees the sentence) unless the launch card pre-granted that exact prefix (listed on the card, run-scoped, gone at the end of the run). Alternatively the run parks that agent as `waiting-approval` and the tree shows it (same state the session manager shows for other harnesses); which of the two is Q5.
- **Worktree isolation for any agent that can write** (`file.patch`, `file.write`, `shell` with write effects, `git.commit`): the host creates a worktree per agent under `<AGENTISTICS_DIR>/runtime/orchestrations/<run>/wt/<agent>`, on its own branch based on the launch commit; the agent's cwd is there; the result is a patch artifact (Part B `diff`) and a branch. Readers share the checkout **read-only** (a `plan`-class profile). **Nothing merges into the shared checkout automatically**; integrating is an explicit `ask` step. This follows the concurrent-work rule this repository already lives by, and `[A:row "Worktree isolation for agents"]`.
- Writers refuse to start when the launch checkout is dirty in files the role can touch, unless the card says so (avoid a patch mixed with the person's edits).

### A.2.8 Resume and cache — keyed by what a step would compute

- The run is an **append-only event log** in the journal. The script is deterministic given verb results, so resuming after a crash or an edit means "run the script again; every verb call first asks the cache".
- **Step key** = `sha256` of: canonical call-site id (verb + a normalised structural path in the script, not a line number), the fully interpolated prompt and `data`, bound model and effort, tool allowlist and role profile hash, output schema hash, hashes of the upstream results it consumed, and a **world stamp** for steps that read the workspace: `HEAD` commit plus a dirty-tree hash over the paths the role may read. A writer's key also includes its worktree base commit.
- Consequences: editing a prompt reruns exactly that step and its dependents; adding or removing an unrelated agent reruns nothing else (contrast positional replay `[B:F71]`); changing the workspace invalidates reads with a stated reason ("HEAD moved since this result"). `--reuse-stale` reuses anyway, explicitly, and the reused results are marked stale in provenance.
- **Crash**: agents that had no recorded result are rerun and their spend appears again in the journal (they are separate billed responses); the resume card says so and shows an estimate for the remaining steps, and **resuming is a launch**: it requires a person, shows the card, and has its own ceiling (the remaining of the old one by default).
- **Effects**: a step marked `effect: external` (a delegate that pushed, a step that ran a deploy) is never re-run by cache miss without a separate confirmation.
- Cache lifetime follows the run's journal retention (D6: events are kept, with a size budget and a stated compaction rule). An expired result says it expired.

### A.2.9 Verification patterns as built-ins, and cross-harness steps

**a) The patterns are library verbs built on `agent()`** so their spend is journal-visible like any other agent:
- `verify(claims, { skeptics: N, refuteAt: k, evidence })`: each skeptic is an independent context (optionally a different model, which helps against shared blind spots) with a mandate to refute the claim using read-only tools, and returns `{ refuted: bool, evidence: [...] }` under a schema. **A refutation without evidence in the schema's evidence fields does not count** (file and line, a command and its captured output). A claim survives when fewer than `k` skeptics refuted it with evidence; the verdict, the skeptics' results and their costs are all recorded. This is the verification step that `[D:notes]` identifies as the noise reducer common to every reviewer product, and `[B:F80]`'s adversarial verification.
- `judge(candidates, { panel, rubric })`: independent scoring, aggregation by code.
- `untilDry(round, { key, maxRounds })`: `key` is a pure function over each result, and "dry" means a full round produced no key not seen before.
- `critic({ goal, results })`: an agent shaped to find gaps against the goal; it returns data, and the script (or the person, on a card) decides on another round.
- Best-of-N is `parallel` + `judge`; a debate is a fixed-round `parallel` of positions then `judge`.

**b) Cross-harness steps (B6.2).** `delegate({ harness: 'codex' | 'claude' | 'gemini' | …, prompt, schema, cwd: 'worktree' })` runs a step in another installed harness. Rules:
- It is an optional step: the script declares `requires: harnessAvailable('codex')` in the manifest, and on a machine without it the built-ins fall back to a native agent or skip with a sentence. The native core works with none installed (D constraint).
- Its result is data under a schema like any other; the delegated harness's own session is registered as an agent entity of the run and measured by the product's existing per-harness readers, so its tokens and cost appear under that phase **with provenance** (`measured` from the harness's own store, or `unknown` when unreadable; never `0`).
- **A ceiling cannot be hard for a harness we do not run.** The runtime can bound what it asks (turn and time limits where the CLI has flags, a kill on the wall-clock cap) but cannot stop a response mid-flight in someone else's process. The card says so, the phase is marked soft-bounded, and its reservation is the declared cap. Where the harness's cost is `unknown`, only the wall-clock and agent-count ceilings apply to it and the card says that in words.
- It runs under the delegated harness's own permission model plus the deny floor, in a worktree if it can write; the launching policy's narrowing applies to what we *ask* of it (B6.2 owns the mechanics).

### A.2.10 Journal events, projection, and the ALM link

New event kinds (additive to the P1 vocabulary; every one carries `runId`, and agent events carry the Agent entity id):
`orch.run.created` (script sha, manifest sha, args hash, **launchedBy: person + surface**, role→model table, ceilings, estimate with basis) · `orch.phase.started|finished` · `orch.step.scheduled|cache-hit|started|finished` (with `stepKey`, `attempt`, result hash) · `orch.budget.reserved|settled|paused|raised` · `orch.verdict` (judge/verify) · `orch.log` · `orch.run.paused|resumed|stopped|finished{reason}` · `orch.script.error` (`script-timeout`, `script-memory`, `verb-refused`).
Agent entities gain `orchestrationId, phase, role, stepKey, attempt`. `usage` is unchanged, so "a response is counted once" holds and **cost per phase, per role, per verb, and per attempt are queries**. A projection `OrchestrationView` (run → phases → agents with state, model, tokens, exact cost, elapsed, cache origin; totals with ceiling, reserved and spent) is the one shape the three surfaces read, so they cannot disagree.

ALM: the launch card asks "file under which task/subtask" (or none). Filing uses the existing claim/attach rules; the run's agents appear as sessions filed under it so `task-rollup.ts` costs the task through them, and the per-phase table is shown in the task's metrics. The run's report artifact is attached to a criterion as evidence (Part B). `done` still requires a session filed under it (unchanged rule); a finished run supplies one. A run with a `delegate` step is filed with the delegated harness's own session rows too.

### A.2.11 The live progress tree, per surface

Data: `GET /api/runtime/orchestrations/:id` and an SSE stream of the projection. These routes touch the host, so they are registered in `capability-guard.ts` (the rule this repo already follows) and are refused on a central. (A central seeing the *relayed* row of a machine's run would be a later item under the "machine decides" rules; out of scope here.)

- **Web Sessions workspace**: an "Orchestration" tab in the right aside (the same place as the artifacts tab, where the person is already looking) plus a chip on the session row and in the fleet overview. Body: budget bar (spent | reserved | ceiling, with the ceiling in the same colour rule as other cost surfaces), phases as collapsible groups, agents as rows (state glyph and word, role, model, tokens, exact $, elapsed, "cached" badge, attempt count), a per-phase cost table. Drilling into an agent opens its transcript in the existing chat view. Controls: pause, stop run, stop agent, restart agent, raise ceiling (opens a card), save script. **Mobile version in the same change**: full-screen sheet, rows collapse to cards, touch targets 44px, no page-level horizontal scroll at 390px.
- **TUI**: a run pane in the code tab (and a `runs` list in the sessions tab): the same tree with box-drawing guides; keys: `↑↓` move, `enter` drill to an agent's tail, `p` pause, `x` stop (asks), `+` raise ceiling (a card). The launch card is a permission-card-shaped component. Fits the existing pure-layout discipline (a `runTreeRows` pure function budgeted against the height, like `sessionRows`).
- **VS Code**: a tree view in the existing sidebar fed by the server API (the extension is a client of the server and holds no rule of its own): the host process polls/streams, the webview never fetches; the launch card is a webview panel; refusals arrive as the server's own sentences.
- All three show the same words for the same states (`queued, running, needs you, done, cached, failed, stopped, over budget`), from one pure i18n table.

## A.3 Native tools and commands added

Model-facing tools (there is deliberately no launch tool):

| Name | Purpose | Class |
|---|---|---|
| `orchestration.status` | read a run's state, phase totals and errors (for the model to report on a run a person started) | auto (read-only) |
| `orchestration.result` | read the structured result or report artifact reference of a finished run | auto (read-only) |

Person-only commands (a new class, **person**: not reachable by any model call, journaled with the actor):

| Name | Purpose | Class |
|---|---|---|
| `/orchestrate <name> [args]` | open the launch card (estimate, models, ceilings) | person |
| `/orchestrations` | list scripts and past/running runs | person |
| `/orchestration show|estimate|resume|pause|stop|save|raise <run>` | inspect and control a run; `resume` and `raise` open a card | person |
| `agentop orch run|estimate|ls|show|resume|stop` | CLI twin (same registry, D-shared handlers) | person |
| `agentop code --orchestrate <name> --max-usd N --model role=…` | headless, all ceilings and bindings mandatory | person |

Orchestration verbs are not tools and appear in no model's tool list.

## A.4 Proposed board items

Sizes on the board's ruler (small = days, medium = 1-3 weeks, giant = a subsystem). "Existing ids" are those named in `[INV]`, B3 and B8.

| Id (draft) | Title | Size | Depends on |
|---|---|---|---|
| ORC.1 | Pure core: manifest schema, static checker, JSON-schema subset validator, estimator arithmetic, ledger (reserve/settle), step-key hashing + tests | medium | B6.1 contract, P1 journal |
| ORC.2 | Sandbox interpreter (WASM JS engine), verb bridge, determinism (Date/random throw), memory/CPU limits, JSON-only boundary + escape-test suite + security review | medium | ORC.1 |
| ORC.3 | Scheduler: runs on the `AgentRunner` port over B6.1, concurrency, reservations, pause-on-ceiling, per-agent USD cap | medium | ORC.1, B6.1 |
| ORC.4 | Journal events, Agent-entity fields, `OrchestrationView` projection, cost-per-phase queries | medium | P1, ORC.1 |
| ORC.5 | Resume and content-keyed cache with world stamps, `effect: external` guard, resume-as-launch | medium | ORC.3, ORC.4 |
| ORC.6 | Verb library: `judge`, `verify`, `untilDry`, `critic`, `pipeline` (no barriers) | medium | ORC.3 |
| ORC.7 | Writer isolation: worktree per writing agent, patch artifacts, explicit integrate step, dirty-checkout refusal | medium | B6.1, H15 (`git.worktree`), ART.2 |
| ORC.8 | B8 kind `orchestration`: catalogue entry, trust, precedence, `ALWAYS` backup entry, `/orchestrations`, `orchestration:` in custom commands | medium | B8.1, B8.2, B8.3, B8.5 |
| ORC.9 | Built-ins as scripts: `review`, `research`, `audit`, `verify-claims`, `batch-edit` | medium | ORC.6, ORC.8, ART.5 |
| ORC.10 | Launch card + `PersonConfirmation` (host-minted), estimate with measured basis, role→model binding UI, headless flags | medium | ORC.1, B4.6, H16 |
| ORC.11 | Web: Orchestration aside tab + fleet chip, controls, mobile version, capability-guard registration | medium | ORC.4, ORC.10, B4.6 |
| ORC.12 | TUI: run pane, launch card, keys, pure row-budget function | medium | ORC.4, ORC.10 |
| ORC.13 | VS Code: tree view + launch webview panel (client of the server) | small | ORC.4, ORC.10 |
| ORC.14 | `delegate` step over B6.2 with soft-bound accounting and provenance for external cost | medium | B6.2, ORC.3 |
| ORC.15 | ALM: file a run under a task/subtask, per-phase cost in task metrics, report as evidence | small | ORC.4, ART.6, B6.5 |
| ORC.16 | Unattended-approval model (deny-by-default with card pre-grants, or park as needs-you) | small | ORC.3, B4.7 |
| ORC.17 | Umbrella acceptance: end-to-end run of `review` on a fixture repo, kill mid-run, resume, exact cost per phase reconciled with the journal | small | ORC.9, ORC.5 |

Together ORC.* is a **giant** feature, consistent with `[B:top15#2, #3]` and `[A:top15#1]`; it is sliceable: ORC.1-ORC.6 give a headless engine, ORC.8-ORC.10 the person-facing loop, ORC.11-ORC.13 the windows.

## A.5 Risks and open questions

Risks:
- **Estimate credibility.** With no measured basis the honest estimate is "unknown, bounded by your ceiling". A first run of a new script is therefore a leap up to its ceiling. Mitigation: an "estimate only" dry run on a tiny slice (`--slice N`) whose measured cost feeds the estimate; suggested by the card.
- **Prompt injection through the chain.** A result read by agent A is interpolated into agent B's prompt. Mitigation: `data` is fenced and journaled as data, policy and ceilings cannot be altered by content, the deny floor holds; residual risk is a worker being steered inside its own grants. Read-only roles are the default.
- **Determinism drift.** A prompt that includes something time-dependent (filenames, git log) makes the step key change on resume. The world stamp makes that visible instead of silent; the cost is more reruns than a user expects.
- **WASM engine surface.** A new dependency and a new escape surface. Mitigation: JSON-only boundary, escape tests, no ambient APIs, security review as a gate on ORC.2.
- **Soft bounds for delegated harnesses** (A.2.9b) are weaker than native hard ceilings; the card must not blur it.
- **Many concurrent writers** stress worktrees and disk; cap and clean-up rules needed (ORC.7).
- **Estimate anchors spend.** A shown estimate can make a person feel safe when the ceiling is what protects them. The card shows both, ceiling first in weight.

Open questions for the owner:
- Q1. Name of the surface: keep "orchestration" with "Ultracode" as the panel label, or something else (the product already has "Dynamic Workflows" for Claude's own)?
- Q2. Ceiling defaults: agents per run 200, items per fan-out 256, concurrency 4 (max 16). Acceptable, or tighter?
- Q3. Accept a WASM JS engine dependency in `packages/runtime` for the script sandbox (versus restricting v1 to the declarative subset, which loses loop-until-dry and data-dependent fan-out)?
- Q4. May the model ever *suggest* an orchestration (a text-only hint), or is the surface entirely person-initiated? Recommendation: entirely person-initiated in v1.
- Q5. Unattended approvals: deny-by-default with pre-granted prefixes on the card, or park the agent as "needs you"? Recommendation: deny-by-default, park optional per run.
- Q6. Should a run be allowed to bill a different provider than the launching session (a card choice), given B8 Q5's same-provider restriction for commands? The card already makes the choice visible; the restriction was about commands the person did not review.
- Q7. Should `batch-edit` also offer publish-as-PRs (H15 write tools + `gh`)? Recommendation: not in v1; ends at branches and patches.

---

# Part B — Native artifact tools

## B.1 Thesis: why ours beats the references

The references: Claude's artifacts render HTML/SVG/Mermaid/React and docs in a side panel, keep versions, and offer a **public link** and remixing, with embedded storage and model calls `[C:27, C:28]`; Amp has a Mermaid diagram tool `[D:26]`; BMAD writes self-contained HTML keepsakes `[B:F98]`; Kiro puts sequence diagrams in design docs `[B:F99]`; the reference harness lists an Artifact tool among those kept for background subagents `[B:F100]`; Replit hands a replay of an app test back `[C:4]`. Our product currently has an artifacts aside that shows files and diffs a session produced but nothing renders a native session's HTML or diagram `[C:27 "Ours"]`, and `artifact.attach` exists only as v2 evidence `[B3 §3]`.

Where ours is better:
1. **Local-first, no public links.** Everything is stored on the machine and never leaves it by default (D10). The references' publish/share is exactly what the constraint forbids, so we replace it with export-to-file, which the person controls.
2. **Versioned by content, tied to the journal.** Every version is an immutable blob referenced by hash, tied to the agent and event that produced it (`sourceEventId`), so "what did the agent show me at 14:02" and "what was the evidence when the task was closed" are exact and cannot be edited after the fact.
3. **Evidence, not decoration.** An artifact attaches to an ALM criterion **pinned by hash**, with provenance and a verified state, which no reference has because none has a board `[C:4, C:23]`.
4. **Rendered on every surface honestly.** One artifact has a defined rendering in web, VS Code and TUI, and where a surface cannot render it it says so and gives a deterministic text description; it never pretends.
5. **Safe by construction.** Model-authored HTML is untrusted code; we render it in an opaque-origin sandbox with no network, so an artifact cannot exfiltrate, and the tool feeds back the reasons a page was blocked so the model can fix it.
6. **Composable with orchestration.** Reports, findings tables and patches from a run are artifacts (Part A), versioned and attachable.

## B.2 Design in our architecture

### B.2.1 The tools

The agent creates artifacts through a small family of tools that write **only to the product's artifact store**, never to the workspace and never to a path the agent chooses. That is why creation is class `auto`: it has no host power beyond bounded, attributable storage.

- `artifact.create({ kind, title, content | fromPath, note? })` → `{ id, version: 1, sha256, warnings[], blocked[] }`
- `artifact.update({ id, content | fromPath | patch, note? })` → new immutable `version n+1` (a `patch` is a context-located edit, the same contract as `file.patch`)
- `artifact.list({ scope })` / `artifact.read({ id, version? })` — the agent reads back its own artifacts
- `artifact.attach({ id, version, task, criterion, note? })` — the existing B3 tool, extended to take an artifact version and pin it
- `artifact.export({ id, version?, to })` — writes a file into the workspace or a path; goes through the policy exactly as `file.write` does (class `ask`)
- `artifact.screenshot({ id, version?, viewport })` — **gated**, only where a browser runtime (B6.4) is granted; renders the HTML artifact to a PNG artifact so it can be evidence
- `report.findings({ items[] })` — a structured findings artifact (file, summary, failure scenario, category, severity), the tool `[D:2, D:top10#2]` asks for; the surfaces render it and a later step marks each fixed or skipped

Kinds (a closed set; a new kind is a decision, like a new harness id):

| Kind | Content | Why this form |
|---|---|---|
| `html` | one self-contained document (inline CSS/JS/data) | UI previews, interactive reports; must not need the network |
| `svg` | SVG | diagrams; displayed as an image so its scripts never run |
| `mermaid` | Mermaid source | diagrams as text, diffable, versionable, renderable by the web/VS Code and readable in the TUI `[D:26]` |
| `markdown` | a document or report | specs, plans (`[C:top10#3]`), research reports |
| `chart` | a declarative chart spec (type, series, axes, units) | rendered by **our** renderer, not by model-written JS, so a chart is a chart on every surface and a TUI can draw bars |
| `slides` | an ordered list of slides (title, bullets, image/chart refs, notes) | a slide-like summary that pages in web, prints as text in the TUI; no arbitrary JS |
| `table` | columns + rows (JSON/CSV) | evidence and comparisons |
| `findings` | the `report.findings` schema | review output, orchestration results |
| `image` | PNG/JPEG/WebP bytes | screenshots, produced images |
| `diff` | a unified diff (patch from a worktree agent) | orchestration writer results |

### B.2.2 Storage: content-addressed, versioned, in the journal's frame

- **Blobs**: `<AGENTISTICS_DIR>/artifacts/blobs/<sha256[0:2]>/<sha256>`, written atomically and never modified. Identical content is stored once.
- **Metadata in the canonical journal** (not a second store): entity `artifact` (`id`, `sessionId`, `agentId`, `kind`, `title`, `slug`, `createdBy`) and `artifact_version` (`n`, `sha256`, `size`, `mime`, `basedOn`, `sourceEventId`, `note`, `createdAt`). Events `artifact.created`, `artifact.versioned`, `artifact.attached`, `artifact.detached`, `artifact.exported`, `artifact.blocked`. Provenance is therefore the same object as every other measured fact.
- **Versions are append-only.** "Restore" makes a new version from an old blob. Diff between versions is a line diff for text kinds and a side-by-side for `html`/`image`.
- **Caps** (stated, refused in words, all editable by the person): per version 5 MB for text kinds and 25 MB for images; per session a total; per artifact a version count. Superseded versions of large images may be pruned oldest-first under the disk budget and are then **marked expired in words**; **any version attached as evidence is pinned and never pruned.**
- **Backup**: `.agentistics/artifacts` is added to the `ALWAYS` allowlist with its reason (nothing regenerates it), like `attachments`/`task-files`; `backup-coverage.lint.test.ts` forces the decision. A restored machine carries the artifacts and their evidence.
- **Secrets**: text kinds go through the shape side of `redactSecrets` as a **refusal**, not a scrub (the B8 §3.4 rule): a credential-shaped string makes `artifact.create` refuse in a sentence, so a pasted key does not land in a durable, exportable page.

### B.2.3 Rendering per surface

Security first, because `html` is model-authored code:
- **Web**: an `<iframe sandbox="allow-scripts">` (opaque origin: no `allow-same-origin`, no forms, no popups, no top navigation), loaded from a dedicated path that answers with a CSP of `sandbox allow-scripts; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'`. Because the CSP arrives as a header, it holds even if the URL is opened directly. There is **no network from a rendered artifact**: a remote script, font, image or `fetch` is blocked, and `artifact.create/update` returns the blocked references in `blocked[]` so the model can inline them. No cookies, no storage shared with the dashboard. The route is registered in `capability-guard.ts` and refused on a central.
- `svg` is shown as an `<img>` (scripts inert). `markdown` is rendered by the existing markdown renderer with raw HTML **not** passed through. `mermaid` is rendered by a bundled renderer in the frame; a parse error shows the source and the error, never a blank. `chart` and `slides` use our own renderers. `image` is an image.
- **VS Code**: a webview panel; the extension host fetches the bytes from the server and hands them to a nested sandboxed frame (the webview never fetches, the same rule as the fleet screen). Same CSP, same kinds.
- **TUI** (cannot render HTML): a deterministic, code-computed description, never model-written: title, kind, version n of m, size, produced by agent/event, headings extracted from `html`/`markdown`, the source for `mermaid` and `svg` in a bordered box, a text bar chart or sparkline for `chart`, a paged text view for `slides`, the table for `table`/`findings`, and for `image` an inline image only where the terminal is detected to support one, otherwise its dimensions and path. Every non-native view carries the line "not rendered here; open in the web workspace: <local URL>" (local only, tokened like the existing shell routes) — a fact stated, not a downgrade hidden.
- **Where it shows in the web Sessions workspace**: the existing artifacts aside gains a second section, **Rendered** (native artifacts, live as they are created) beside **Touched** (files and diffs). A card per artifact with a thumbnail where one exists, version selector, diff toggle, "attach to task…", "export…". The artifacts button already carries a count; native artifacts add to it. The mobile version is a full-screen viewer with the version selector as a bottom sheet (same-change rule).

### B.2.4 Attaching as ALM evidence

- `artifact.attach(id, version, task, criterion)` creates an **evidence row on the task/criterion**: `{ artifactId, version, sha256, kind, criterion, attachedBy: agent|person, sessionId, agentId, eventId, verifiedBy: none | person | check }`. The bytes are not copied; the row pins the hash.
- **An agent's attachment is a claim, marked as such.** It appears on the board as "attached by agent X, not verified"; a person can accept it (`verifiedBy: person`) or detach it; an orchestration's `verify` verdict can raise it to `check` with its own provenance. Nothing about evidence relaxes the existing rules: a task still needs a session filed under it to be `done` (`done_needs_session`), and evidence does not stand in for one.
- **A pinned version cannot be pruned or altered**, so a screenshot attached to a criterion is the same bytes months later.
- **Team sharing**: a shared task carries evidence **metadata only** (kind, title, hash, verification state), never bytes, following the task-files rule that no file bytes travel; the central shows "evidence held on the member's machine". Q4 below asks whether a person may opt one artifact in explicitly.
- The board's existing evidence view (`task-evidence.ts`) lists them with the same renderers as the aside, so a criterion's evidence looks the same where it is read.

### B.2.5 What is NEVER done

- No public link, no publish, no hosted copy, no "remix", no upload to any service (D10). Sharing is `artifact.export` to a file the person then handles.
- No network access from a rendered artifact, no `allow-same-origin`, no reading of the dashboard's origin, cookies, storage or APIs from inside a frame; no execution of artifact code in the runtime or server process.
- No auto-opening of a browser tab or window; the person opens what they want to see.
- No agent-chosen filesystem path; creation writes only into the store; exporting goes through policy.
- No silent overwrite: an update is a new version; nothing is edited in place.
- No model-written summary standing in for the artifact on a surface that cannot render it (the TUI text description is computed by code from the content).
- No secret-shaped content stored (refusal in words).
- No bytes to a central by default; no artifact content in the team push.
- No rendering claim that is false: an unrenderable artifact says "not rendered here" and why.
- No third-party CDN in a page we generate or serve (the vendored renderers are bundled).

## B.3 Native tools and commands added

| Name | Purpose | Class |
|---|---|---|
| `artifact.create` | create a versioned artifact (kind, content or `fromPath` under read policy); returns warnings and blocked references | auto (writes only to the artifact store, capped) |
| `artifact.update` | append an immutable new version (content or patch) | auto |
| `artifact.list` / `artifact.read` | list and read the session's own artifacts | auto |
| `artifact.attach` (extends B3 v2) | pin an artifact version as evidence on a task criterion | auto (registers evidence, marked unverified) |
| `artifact.export` | write an artifact version into the workspace or a chosen path | ask (policy-judged like `file.write`) |
| `artifact.screenshot` | render an `html` artifact to a PNG artifact via the browser runtime | gated (needs B6.4 grant) |
| `report.findings` | structured findings artifact (file, summary, scenario, category, severity) | auto |

Person commands: `/artifacts` (list, open, diff versions, restore, export, attach), `agentop artifact ls|show|diff|export|attach|detach`, and the web/VS Code "accept evidence" gesture. Same registry across surfaces.

## B.4 Proposed board items

| Id (draft) | Title | Size | Depends on |
|---|---|---|---|
| ART.1 | Pure core: kinds, validators, size caps, external-reference scan, secret-shape refusal, version model, deterministic text describer + tests | medium | P1 journal |
| ART.2 | Store: content-addressed blobs, journal entities/events, pinning, pruning-with-expiry, `ALWAYS` backup entry + lint | medium | ART.1, P1 |
| ART.3 | Tools `artifact.create/update/list/read` + host wiring (blocked-reference feedback) | medium | ART.1, ART.2, B4.6 |
| ART.4 | Sandboxed render route (CSP header, opaque origin), web viewer in the aside "Rendered" section, version selector and diff, mobile viewer | medium | ART.2, B4.6 |
| ART.5 | Renderers for `mermaid`, `chart`, `slides`, `findings`, `table` (vendored, no CDN) + `report.findings` tool | medium | ART.4 |
| ART.6 | Evidence: extend `artifact.attach` (pin by hash, `verifiedBy`), board evidence view with the same renderers, accept/detach gestures | medium | ART.2, existing `task-evidence.ts`, artifact.attach v2 |
| ART.7 | TUI: describer views, bordered source, text charts, paged slides, terminal-image detection, "open in web" line | medium | ART.1, ART.3 |
| ART.8 | VS Code webview panel (host-fetched, nested sandbox) | small | ART.4 |
| ART.9 | `artifact.export` (policy-judged) and `/artifacts` + `agentop artifact` commands | small | ART.3, B8.5 |
| ART.10 | `artifact.screenshot` for `html` via B6.4 (gated) | medium | B6.4, B9.2 |
| ART.11 | Shared-task evidence metadata (no bytes) to a central; optional explicit per-artifact opt-in if the owner says yes (Q4) | small | ART.6, the shared-tasks rules |
| ART.12 | Security review and escape tests for frames (network denial, origin isolation, SVG, markdown raw HTML) | small | ART.4 |

Priority note: ART.1-ART.4 unlock most of the value and match `[C:top10#7]` (medium) and `[B:top15#6]`; ART.6 and ART.10 match `[C:top10#8]`; ART.10 is the "agent-driven verification with a replay" direction of `[C:4]` and `[C:top10#1]` and is honestly gated behind the browser work.

## B.5 Risks and open questions

Risks:
- **Untrusted HTML is the biggest surface.** Mitigation: header CSP, opaque origin, no network, escape tests as a gate (ART.12). Residual: a page can still be an annoying or misleading UI (a fake dialog); it is clearly framed as "produced by agent X".
- **Interactive pages that need libraries** will refuse or degrade offline. We accept this (local-first) and report blocked references so the model inlines; a small vendored kit (chart/diagram renderers) covers the common cases through the declarative kinds.
- **Disk growth** from screenshots and versions; the budget and pruning rule must be visible in Settings.
- **The TUI is a second-class renderer** for visual kinds; the text description is honest but poor for a dashboard-like page. Accepted, said on screen.
- **Evidence can be gamed by a model** attaching flattering artifacts. Mitigation: "not verified" by default, an accept gesture, `verify` verdicts as provenance, unchanged `done` rules.

Open questions for the owner:
- Q1. Are the kinds right (notably `chart`/`slides` as declarative specs rather than free HTML)? Free-form HTML remains for anything else.
- Q2. Default caps: 5 MB text / 25 MB image per version; session and version-count totals?
- Q3. Should artifacts be visible across sessions (a project-level gallery) or stay session-scoped in v1 with the task attachment as the cross-session link? Recommendation: session-scoped plus task-attached.
- Q4. Team mode: metadata-only evidence on the central (recommended), or an explicit per-artifact "send bytes" opt-in, one at a time like `Task.shared`?
- Q5. May an `html` artifact use JS at all in v1, or start static (HTML+CSS only) and add scripts after the sandbox review? Recommendation: scripts on, network off, behind ART.12.
- Q6. Should `artifact.create` be `auto` (recommended: it writes only to the bounded store) or `ask` for the first artifact of a session?
- Q7. Should the model be allowed to open an artifact in the person's view automatically, or only announce it (recommended: announce with a chip; never auto-open)?

---

## Cross-cutting: how A and B meet

An orchestration's report, findings table, patches and screenshots are artifacts (`findings`, `markdown`, `diff`, `image`). The run's progress tree links to them; `verify` verdicts become the `verifiedBy: check` provenance on attached evidence; the estimate and per-phase cost figures shown on the launch card and the tree come from the same journal that stores each artifact's producing event. Neither feature adds a path that spends money without a person, publishes anything off the machine, lifts the deny floor, or runs untrusted code in the runtime process.
