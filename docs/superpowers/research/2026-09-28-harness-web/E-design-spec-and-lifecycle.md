# E - Design: a spec-driven plan mode (A) and a staged POC -> MVP -> product lifecycle (B)

Date: 2026-09-28. Status: design proposal for the owner, documentation only. No product code changed.

Sources are the three research files in this directory and two specs. Citation shorthand:
`Bf F##` = a row of `B-features.md` section 1 (1a spec-driven, 1d lifecycle, 1e/1f context and safety);
`Bf s2 <method>` = `B-features.md` section 2, "Spec-driven methods, phase by phase";
`Bf T15 #n` = its "Top 15 gaps"; `C sN` = `C-lifecycle.md` section N (`C s3` is the toolchain, `C s4 #n` its Top 10);
`A T15 #n` = `A-features.md` "Top 15 gaps"; `INV` = `research-salvage/INVENTORY.md`;
`B8 §n` = `docs/superpowers/specs/2026-09-28-runtime-b8-catalogue.md`; `M §26` = the master spec section 26 (ALM in the execution cycle).
Nothing here copies a source; every pattern is restated in our own words. Nothing was taken from Gitlawb/openclaude or any leaked source.
I did not read `D-quality-tools.md`; it is outside the brief.

Marker convention for claims about lifecycle: **[E]** evidenced by a cited product, **[I]** inferred by the research or by me (the research file uses the same tags, `C s3`).

---

## 0. Two facts that shape everything

1. **Plan mode, today, is only a permission profile.** B8 §5.3 defines `plan` as a read-only agent profile and says explicitly it honours the earlier decision to have NO separate plan-mode tool; `task.plan` stays the in-run checklist (B8 §5.3, INV). Bf F01 records that a durable, gated three-artifact flow is missing, and `A T15 #2` and `Bf T15 #1` rank it the top gap on top of B4.7. So A is built ON B4.7 and B8, not around them.
2. **Nobody ships named POC / MVP / product stages.** The prototype builders have gate sequences (plan, build, verify, publish) and at most environment separation (`C s2`, "Finding up front"); `A T15` closing note says theme 3 "would be new design work rather than a port"; `C s4 #5` says "Nobody ships this". **Part B is our own design.** Its parts borrow evidenced pieces (Kiro/Spec Kit gates, Lovable's security scan, Replit's rollback, the Vercel launch checklist), but the stage model, the entry/exit criteria and the way stages map onto an ALM board are ours, and every criterion below is tagged [E] or [I] so the owner can see which are market-backed and which are a judgement call.

---

# PART A - Spec mode: "a native superpowers inside plan mode"

## A.1 Thesis

**What we build.** A `spec` session mode whose whole job is to turn an idea into approved, versioned, traceable files, and then into ALM board work, before any product code is written. It runs the flow brainstorm -> requirements -> design -> plan/tasks -> analysis -> board, with a person's gate between the phases that matter, on a run whose policy is read-only for the product.

**Why it beats each reference** (only claims the research supports):

| Reference | What it does | Where ours is stronger |
|---|---|---|
| Kiro | Three gated files; requirement-to-task mapping claimed; sync action (Bf s2 Kiro, F01, F04, F07) | The research finds no named approver ("page names no specific approver", Bf s2 note). Ours records WHO approved WHAT hash, as a journal event, and a later edit makes the approval stale. Traceability is a deterministic checker, not a claim. |
| Spec Kit | Seven stages, ambiguity markers, checklists, analyze, converge (Bf s2 Spec Kit, F14-F19) | Its gates are "LLM self-gating" except test approval (Bf s2 Spec Kit). Ours: a gate cannot be released by the model at all. Its tasks live in a markdown file; ours land on a board with claims, dependencies, done-needs-session and acceptance criteria (M §26). |
| superpowers | Hard gate, path classification, plan self-review (Bf F27, F29, F30) | The hard gate is skill text the model agrees to follow (Bf F27, F34 "discipline skill text"). Ours is the plan permission profile: the tool call is denied, whatever the model decides. |
| BMAD | Scale-adaptive paths, planning chain, readiness check (Bf F42, F43, F44) | Same path idea, kept (section A.2 phase 0). The readiness check (F44) becomes our deterministic `spec.check`. |

**What only we have** (from INV, none of it in a reference):

- **Exact cost per phase.** Every provider call has exact usage and cost in the journal with provenance (INV). A phase boundary is an event, so a gate card can say "requirements: 4 calls, $0.41, model X" as a sum of journal rows, never an estimate. No reference shows this; Bf F35/F119 only cover completion gates.
- **The journal as the audit trail** of every question, artifact write, gate request, approval and rejection.
- **The ALM board** as the destination: tasks, subtasks, groups, claims/leases, blocked reasons, done-needs-session, and (planned, M §26) acceptance criteria and staged sessions. Bf F108 records that BMAD's ticket tree is "exactly a task/subtask board" for us.
- **Policy enforcement, not persuasion.** Deny floor no rule lifts; profiles are layers (B8 §5.5).
- **Delegation to other harnesses (B6.2)** for an independent critic on the spec, optional and never required (INV constraint: other harnesses are precedent, not dependency). Reference critics exist only inside one product (Jules critic, BMAD lenses, Bf F48, orchestration table "Critic / reviewer agents").

## A.2 The design

### Phases, artifacts, gates

Artifacts live in `docs/specs/<slug>/` in the repository (the naming the owner suggested; Kiro and Spec Kit use `.kiro/specs/<spec>/` and `specs/<NNN-branch>/`, Bf F01, F20; superpowers uses a dated file under docs, Bf F27). Note `docs/specs/` already holds flat dated files in this repo; a per-slug folder coexists with them (see risk R1). Slug = `NNN-short-name`, auto-numbered by scanning existing folders (pattern of Bf F20).

| # | Phase | Writes | Person's gate? | Notes and sources |
|---|---|---|---|---|
| 0 | **Frame / route** | `spec.md` header block (`path: spike | quick | full`, size estimate) | Person confirms the path in the first question | Right-sized ceremony: spike (probe, keep nothing), quick (one pass, fewer gates), full. Sources: Bf F27 (spike/bounded/architectural), F06 (quick spec), F42 (four paths by an intent gate and a size gate), F105 (feasibility spike). |
| 1 | **Brainstorm** | `brainstorm.md` (options, constraints, rejected ideas, open questions) | No gate; ends when questions are closed | One question at a time through the existing `ask.user`, with options (Bf F16 Tessl tile; Bf F27). Every unresolved item is kept as an explicit `[NEEDS CLARIFICATION: ...]` marker, never guessed (Bf F16). |
| 2 | **Requirements** | `requirements.md` | **Gate G1 (person)** | Stable ids `R-1..`, each with acceptance criteria `AC-1.1..` in a testable "when X, the system shall Y" form (Bf F03; the "testable, measurable" bar of Spec Kit, `C s2` Spec Kit). A bugfix variant uses Current / Expected / Unchanged sections (Bf F05). An `analyze` pass finds ambiguity and conflicts before G1 (Bf F04). No marker may remain at G1 (Bf F16, F17). |
| 3 | **Design** | `design.md` (+ `contracts/` and `data-model.md` when applicable) | **Gate G2 (person)** | 2-3 approaches with a stated choice (Bf F27 architectural path), architecture and sequence diagrams (Bf F99), a "complexity" section where any departure from the project's standing rules must carry a written justification (Bf F14/F15 constitution and Phase -1 gates). The "project rules" input is `AGENTS.md` (H2) plus an optional `docs/specs/constitution.md`. |
| 4 | **Plan and tasks** | `tasks.md` (and `plan.md` when the full path needs a narrative) | Person reviews inside **Gate G3** with phase 5 | Each task: id `T-n`, the requirement ids it satisfies, exact file paths it may touch, tests before code, optional parallel marker for independent tasks, a size and a proposed dependency list (Bf F22 story-labelled, TDD-ordered tasks; Bf F29 files, interfaces and exact steps, no placeholders; Bf F08 parallel marker). |
| 5 | **Analyze / readiness** | `analysis.md` (generated, read-only report) | **Gate G3 (person)**, the last one | Deterministic cross-artifact check (`spec.check`, A.3), then optional independent critic (B6.1 subagent on a cheaper model, or B6.2 another harness). Sources: Bf F18 read-only analysis, F44 readiness check, F17 checklist-as-gate, `A T15 #7` verification ladder. |
| 6 | **File to board** | board Task, subtasks, criteria; `spec.md` records the task id | No further gate: G3 IS the approval to file | Section A.2 "Landing on the board". Filing only PREPARES sessions; dispatching one is a separate person act (M §26: "Dispatch must not silently alter anything prepared"). |

Two gates would be enough for the quick path (G1 and G3); the spike path has one question and no files kept (Bf F105). Kiro's quick path likewise removes gates (Bf F06); ours keeps at least one person gate even there, because the point of the product is that a person approved what an agent will spend money on.

### Who approves, and why a model cannot

- A gate is **requested** by the model through `spec.gate` (class `gated`, A.3). That call only records `spec.gate.requested{phase, artifactPaths, sha256[]}` and ends the model's turn with a result that says "waiting for a person". It has no parameter that approves.
- The approval is a **person action on a surface** (web Sessions workspace, TUI, VS Code, or `agentop spec approve <slug> <gate>`), implemented once in the host, the way `task-reopen.ts` is the one implementation of a gesture (see project rules on one gesture, two implementations). It writes `spec.gate.approved{actor: person, sha256[], comment?}`. There is no model-callable tool, no command a custom markdown command can expand into, and no allow-for-session option that releases it.
- Approval is **bound to the file hashes**. If an artifact changes afterwards (by the model, the person, or a merge), the journal records `spec.gate.stale` and the gate must be re-approved. This is the durable form of Kiro's "Sync Files" (Bf F07) without a model-written summary: the artifacts ARE the memory.
- Rejection carries a reason; the reason is a plain message to the model on its next turn (approval outcomes with a reason are already have/planned in INV via deny-with-reason, Bf row "Approval outcomes").

### How the plan profile enforces read-only

- Spec mode is the agent profile `spec` (B8 §5.3) whose permission profile is `plan` (B8 §5.5): deny `write` and every mutating shell segment the parser can classify, ask on opaque ones. The deny floor is untouched (B8 §5.5).
- **The one honest tension.** Writing `docs/specs/<slug>/*.md` is a write, and a strictly read-only profile would forbid the very artifacts. The design resolves it without weakening `plan`: the artifacts are written by a **dedicated tool, `spec.write`**, whose subject is not `file.write`. The `spec` profile is `plan` plus exactly one allow: `spec.write` with a `pathGlob` of `docs/specs/<current-slug>/*.md`. Everything else in the profile stays denied: `file.patch`, `file.write`, mutating shell, git write tools. `spec.write` also refuses any path outside that glob at the tool level (double belt), refuses symlinks that resolve outside it, and refuses to overwrite an artifact whose phase has an approved, un-stale gate unless the phase is reopened (`spec.reopen`, itself gated).
- Consequence for audit: "in spec mode the run changed no product file" is a query over journal tool events, not a promise. The profile switch out of spec mode into `accept-edits` is event-bearing; session approvals survive a switch into a stricter profile and are dropped on a looser one (B8 §5.5), so nothing approved under `spec` leaks into building.
- Shell in spec mode is available for reading (`git log`, `ls`) as the `plan` profile already classifies; an opaque segment asks. No web access is added by this design (B6.7 is separate; Gemini's plan mode confirms a fetch, Bf/A rows "Web fetch").

### Which parts are B8 built-ins and which are new runtime pieces

| Piece | Kind | Where | Note |
|---|---|---|---|
| `spec` agent profile (prompt addendum, `plan` permission profile + the `spec.write` allow) | B8 built-in agent profile | catalogue, scope `builtin` | B8 §5.3; a profile only narrows the spawning session's grants (B8 §3.5). |
| `spec-critic` agent profile (read tools only, cheaper model if configured) | B8 built-in agent profile | catalogue | Same family as the built-in `explore` (B8 §5.3). |
| Skills `spec-brainstorm`, `spec-requirements`, `spec-design`, `spec-tasks`, `spec-review` | B8 built-in skills (markdown, descriptions in the prompt, `skill.load`) | catalogue | B8 §5.2. They carry the know-how (question discipline, requirement wording, self-review points), so the base prompt stays lean (B4.5). Pattern of Bf F29 five-point self-review and F16, restated. |
| Commands `/spec`, `/spec-status`, `/spec-analyze`, `/spec-file`, `/spec-reopen`; approval is NOT a command a model can run | B8 built-in commands, handlers in the host | command registry, B8 §5.1 | The list of visible commands and their keys is UI.6's call (B8 §5.1). |
| `spec.write`, `spec.gate`, `spec.check`, `spec.file` | NEW runtime tools | `packages/runtime`, pure logic; host performs IO (D23) | A.3. |
| Traceability parser and checker | NEW pure module `packages/runtime/src/spec/` | tested without a filesystem | Parses ids and references out of the markdown; the shape is fixed by templates. |
| Gate approval UI/CLI action | NEW host handler + web/TUI/VS Code affordance | server + surfaces | One implementation, four doors (project surface rule). |
| Board landing | Uses B6.5 ALM tools + M §26 fields | B6.5 | Not new tools of ours beyond `spec.file`, which composes B6.5 calls. |

### Events journaled

Additive, in the D20 style B8 §6 already uses (optional fields; content is never copied into the journal, only paths and hashes):

`spec.started{slug, path}`, `spec.phase.entered{phase}`, `spec.artifact.written{path, sha256, bytes}`, `spec.gate.requested{gate, hashes}`, `spec.gate.approved{gate, actor, hashes, comment?}`, `spec.gate.rejected{gate, reason}`, `spec.gate.stale{gate, path}`, `spec.check.reported{errors, warnings}` (counts, never bodies), `spec.filed{taskId, subtaskIds, criteria}`, `spec.reopened{phase, actor}`.
Questions asked are the existing `ask.user` events. Because every provider call is already journaled with cost, **per-phase cost is the sum of journal rows between `spec.phase.entered` events**; the gate card shows it. Per the frontier rule of the product, these events carry facts and never instructions (project rule "an event carries facts").

### Phase model routing, and no model-written summaries

- A phase may name a model in the `spec` profile (strong model for design and analysis, cheaper for drafting) because phase-based routing is evidenced (Bf F56 Plan/Act with separate models; Bf row "Phase-based model routing", `A T15 #11`). B8 keeps model change inside a profile to the same provider (B8 §12 Q5 as cited in B8 §5.1); that limit applies.
- **No context summaries.** Between phases the carrier is the approved FILE, read back with `file.read`; a fresh run for the next phase starts from paths, not from a model-written recap. This is the deterministic version of Cline's "fresh task seeded with the plan" (Bf F53) and stays inside the CTX §6.5 ban (INV; Bf F122 is marked never as a summary). The artifact is written by the model, but it is a first-class reviewed deliverable a person approved, not a compaction of the context.

### Landing on the ALM board

Prerequisite: M §26's `AcceptanceCriterion` (id, text, `open|met|failed`, evidence refs) and the staged-session fields; `done` with an open criterion is refused (422 shape shared with `blocked_needs_reason`/`done_needs_session`). At G3, `spec.file` (through B6.5 tools) does:

1. One **Task** = the feature; description = a pointer to `docs/specs/<slug>/` (path and hashes), not a copy of the text.
2. One **acceptance criterion per `AC-x.y`**, id preserved (`AC-1.1`), text copied verbatim, state `open`.
3. One **subtask per `T-n`**; requirement ids in its description; **groups** (M/ALM group subtasks) for a requirement with several tasks. Proposed dependencies from `tasks.md` become board dependencies (`task_blocked_by`, existing).
4. Each subtask gets a **staged session** (existing `Subtask.stagedSession`) whose prompt names the spec path, the allowed files (the file list from `tasks.md`), the criteria it must satisfy, and the profile `accept-edits`. Today those live in the prompt because the spec-reference, allowed-files and criteria fields do not yet exist (M §26 says so). **Filing does not dispatch.** A change to a prepared session mints a new version (M §26).
5. Board `done` rules apply unchanged: a task cannot close without a session filed under it and without every criterion `met` (M §26, `done_needs_session`), so the spec cannot be "finished" on paper.

Round trip: `agentop spec status <slug>` reads the board and reports per requirement how many criteria are met, so the spec folder never becomes the second source of truth. `tasks.md` states, in its header, that after filing the BOARD is authoritative for status (a checkbox file would drift; Bf F22 records Spec Kit doing status in the file, which is exactly the drift we avoid).

### Traceability, checked deterministically

`spec.check` is a pure function over the parsed artifacts, no model call. It reports errors (block G3 unless waived by the person with a reason) and warnings:

- every `R-n` has at least one `AC`; every `AC` has at least one `T-n` and a **verification kind** (`test`, `command`, `artifact`, `manual`);
- every `T-n` cites at least one `R-n`/`AC`; no orphan task; no task touches a file outside the project's root or the deny floor;
- no `[NEEDS CLARIFICATION]` marker left (Bf F16);
- ids unique, stable, and unchanged since G1 unless the requirement was explicitly reopened (a renumbered requirement silently breaks the criteria on the board);
- design sections referenced by contracts exist; tasks order tests before the code they test (the TDD ordering of Bf F22, F34, as a warning);
- diff against the board after filing: criteria or subtasks present on one side only (Spec Kit's "converge" idea, Bf F19, reduced to a deterministic diff).
It is the read-only analyze of Bf F18 and the traceability of `Bf T15 #4`, with the difference that no model has to be trusted to count.

### Verification of the result (spec mode's tail)

Spec mode ends at the board. Verification of the built code is the ordinary task loop, with two additions: each criterion's verification kind decides how it becomes `met` (a `command` runs under the policy and its output is the evidence; `artifact` needs an attached artifact; `manual` needs a person), and evidence is attached through `artifact.attach` (v2, INV). An agent's statement is never evidence (evidence-before-claims, Bf F35).

## A.3 Native tools and commands it adds

Permission classes: **auto** = runs without asking; **ask** = policy asks (allow-once, prefix, deny) like any tool; **gated** = only a person can release it, no session-wide or prefix allow, the actor is recorded (new class; see R3). Classes never touch the deny floor.

| Name | Kind | Purpose | Class |
|---|---|---|---|
| `spec.write` | tool | Write or replace one artifact under `docs/specs/<slug>/`; refuses other paths, stale-gate overwrite, symlink escapes; returns the hash | auto (inside the glob), denied elsewhere |
| `spec.gate` | tool | Request a gate; no approve parameter; ends the turn | auto (request only) |
| `spec.check` | tool | Run the traceability checker; returns a structured report | auto (read-only) |
| `spec.file` | tool | Compose B6.5 calls to file the approved spec on the board (requires G3 un-stale) | gated (creates board work) |
| `spec.reopen` | tool | Reopen an approved phase, invalidating downstream gates | gated |
| `/spec <idea>` | command | Start spec mode: creates the slug, enters the `spec` profile | n/a (a person types it) |
| `/spec-status`, `/spec-analyze` | command | Show phase, gates, per-phase cost; run `spec.check` on demand | n/a |
| `/spec-file`, `/spec-reopen` | command | Person-triggered board landing and reopening | n/a |
| `agentop spec approve\|reject <slug> <gate>` | CLI/host action | The person's approval | person only |
| Skills `spec-*` (5), agent profiles `spec`, `spec-critic` | catalogue built-ins | Know-how and the profile | n/a (skill.load is auto, B8 §5.2) |

`task.plan` is unchanged (the model's own in-run checklist). Spec mode uses it inside a phase; the spec tasks are the durable ones (Bf F29/F119: an in-run checklist and a durable task list are different things).

## A.4 Proposed board items

Ids: `E-A*` are draft ids for the leader to reconcile. Dependencies name existing ids from INV and B8 §11.

| Id | Item | Size | Depends on |
|---|---|---|---|
| E-A1 | Spec artifact model: templates, id scheme (`R-`, `AC-`, `T-`), pure parser + tests (no filesystem) | medium | B8.1 |
| E-A2 | `spec.check` traceability checker (rules above) + tests incl. renumbering and board diff | small | E-A1 |
| E-A3 | `spec` and `spec-critic` agent profiles; `plan` profile amendment (`spec.write` scoped allow) and its loader validation | small | B4.7, B8.4, B8.7 |
| E-A4 | Tools `spec.write` / `spec.gate` / `spec.reopen`, the `gated` permission class, hash-bound gates, journal events | medium | B4.7, E-A1, E-A3 |
| E-A5 | Person's gate action: host handler, web card (with per-phase cost), TUI, VS Code, `agentop spec approve` | medium | E-A4, B4.6, UI.6 |
| E-A6 | Built-in commands `/spec*` and the five `spec-*` skills | medium | B8.5, B8.6, E-A4 |
| E-A7 | Board landing `spec.file` over B6.5 + ALM `AcceptanceCriterion` + prepared-session spec/allowed-files/criteria fields (M §26) | medium | B6.5, the ALM phase of M §26, E-A2 |
| E-A8 | Per-phase cost and time from the journal (query + gate-card figure) | small | journal, H6 |
| E-A9 | Independent critic pass: B6.1 subagent on a cheaper model and optional B6.2 delegation to another harness; findings triaged, never auto-applied | medium | B6.1, B6.2, E-A2 |
| E-A10 | Bugfix variant (Current / Expected / Unchanged; regression-preservation criteria) | small | E-A6 |
| E-A11 | Phase model routing inside the `spec` profile | small | E-A3, B9.1 |

## A.5 Risks and open questions (A)

- **R1 Directory.** `docs/specs/` already holds this repo's own dated specs. Is `docs/specs/<slug>/` right, or should product specs live under a different root (for user projects the harness runs in, the root is theirs, so this is a default configured in the catalogue)?
- **R2 `spec.write` versus "read-only".** Alternative: keep spec text in the journal/store until approval and only materialise files after G1. That makes `plan` literally read-only but hides the reviewable diff during drafting. Recommendation: `spec.write` as designed. Owner decision.
- **R3 A new `gated` class.** It is a permission concept beyond allow/ask/deny. It cannot be a loosened `ask` (an ask can be answered "allow for session"). Confirm the class, or map it onto an `ask` with `session-allow` disabled.
- **R4 Gate count and friction.** Three gates per feature can feel heavy; the quick path (G1 + G3) and the spike path (one question) are the escape. Confirm whether G2 may be merged with G3 on the quick path.
- **R5 Templates as a ceremony tax.** Bf F42 and F106 exist because process must scale with work; the router in phase 0 is load-bearing, and the default when unsure should be "quick", never "full".
- **R6 Dependency on unshipped ALM fields.** Board landing needs M §26 (criteria, spec refs). Until they exist the fallback is prompt-embedded references (works, invisible to checks, M §26 says the same).
- **R7 Task-status drift.** Two homes (file and board) is the drift risk; the rule "board is authoritative after filing" plus the diff in `spec.check` is the mitigation, not a cure.
- **R8 Critic on another harness.** B6.2 sends the spec text to another vendor. Local-first: needs the same explicit consent as any delegation, never on by default.
- **R9 Traceability is syntactic.** It proves every requirement has a task and a criterion, not that the criterion is a good one. The person's G1 review carries that; do not oversell.

---

# PART B - Lifecycle stages: POC, MVP, structured product

## B.1 Thesis

**What we build.** Three named, recorded stages on top of ALM. Each stage has entry criteria, work, artifacts, a quality bar it raises, and exit criteria; each criterion has a way of being verified and produces evidence; promotion between stages is a person's decision recorded on the board. **This is our own model** (section 0). The market gives a gate sequence, not stages (`C s2`), and says the human moves work between them ([I], `C s3` cross-cutting).

**Why it is worth having and hard to copy:**
- The stage and its criteria are DATA on the board, not vibes in a prompt: an MVP is "these 9 criteria met with evidence or waived with a reason by a named person", visible next to the sessions and the money spent.
- The quality bar is checkable, deterministic where it can be (command exit codes, file and secret probes) and human-signed where it cannot. Lovable's readiness scan is advisory by default (`C s3` cross-cutting, [E]); ours is advisory at POC, and a promotion needs met-or-waived, which matches the board's existing "warn, never block" spirit for WIP but the existing hard rule for `done`.
- **Cost per stage** from the journal: what the POC cost, what reaching MVP cost, against the human's stated budget. Builders show none of this.
- **Delegation** may run a stage's independent security or review pass on another harness (B6.2), optional.
- Nothing leaves the machine: "deploy" is not a stage step. `C s4 #9` recommends stopping at "produce a deployable bundle + branch + PR" for local-first.

## B.2 The design

### The model on the board (new)

- A **project** is an ALM Task ("initiative") carrying a new `lifecycle` block: `{ stage: 'poc' | 'mvp' | 'product', history: [{stage, enteredAt, approvedBy}] }`.
- **Each stage is a child Task** ("Acme - MVP") whose **acceptance criteria are the stage's exit criteria** (M §26 criteria), whose **subtasks are the work items** (many come from a spec-mode run, Part A), and whose sessions are the ordinary filed sessions. A stage Task is `done` only when every criterion is `met` or `waived`, plus the standing `done_needs_session` rule.
- **`waived`** is a new criterion state (open|met|failed|waived) that only a person can set and that requires a reason and is journaled with the actor. Rationale: `C s3` "Stage 3 exit" is "resolved or explicitly waived with a reason [I]", and no source defines waiving; we define it. It never applies to the deny floor or anything else in the policy.
- **Promotion** = the person approves `stage.exit`; that closes the stage Task and creates the next stage Task seeded from its template. Demotion or "kill" also exists: the POC exit has an explicit `keep | kill` verdict (pattern of the go/clarify/kill assessment, Bf F23), and `kill` archives.
- Artifacts per project under `docs/lifecycle/<slug>/`: `poc-brief.md`, `stage-mvp.md`, `stage-product.md` (the person-approved stage record: criteria, evidence refs, waivers, hashes) and `readiness.md` (generated snapshot at each gate). The running code lives wherever the project lives; nothing here dictates its layout.

### Verification model (common to all stages)

Every criterion has a **verifier kind**, so "how is it verified" is never a matter of opinion:

| Kind | Who/what verifies | Evidence |
|---|---|---|
| `probe` | A pure built-in check (file exists, lockfile committed, no secret-shaped string in tracked files, health endpoint declared in config) | The probe result + file hashes, journaled |
| `command` | A project command run via `shell.start` under the policy (test, lint, build, scan CLI, CI status via `git`), exit code + captured output | Output attached with `artifact.attach`, linked to the journal call id |
| `artifact` | A produced file (screenshot, report, recording) attached to the criterion | `artifact.attach` (v2, INV); rendered in the Sessions workspace artifacts aside (`C s4 #7, #8`) |
| `manual` | A person confirms | Person actor + timestamp in the journal |

`stage.verify` runs the auto kinds and updates criteria to `met` or `failed` with the evidence; only the person can waive. **An agent's assertion never moves a criterion** (evidence-before-claims, Bf F35). Evidence is by reference: hashes and journal ids, not the bulk content, which stays in the artifact store.

### Stage 1 - POC: "does the idea run"

- **Entry:** a one-sentence idea (optionally an image once B9.2 exists) [E: Replit, Firebase Studio prompts, `C s3` Stage 1]; a person starts it (`/poc <idea>`); phase-0 routing of Part A picks the `spike`/`quick` path. Optional plan review before any file is written [E: Lovable, Replit, Bolt, `C s3`].
- **Work:** scaffold in an isolated worktree/branch or fresh directory (worktree isolation is `Bf F41`, `A T15 #6`); build under `accept-edits` after G-POC-1 (the person approves the `poc-brief`); run it locally and see it run; keep every step reversible (in-memory edit checkpoint now, H4 `/undo` when shipped; persisted whole-state checkpoints are `C s4 #2`).
- **Artifacts:** `poc-brief.md` (idea, hypothesis, golden path in 3-7 steps, explicit non-goals, run recipe); the prototype; run evidence.
- **Quality bar raised: starts from zero, and the golden path runs.** Deliberately absent at this stage: auth, a real database, deploy, a test suite [I, `C s3` Stage 1] - and the `poc-brief` says so, so an absent feature reads as a decision, not a defect.
- **Exit criteria:**
  1. `probe`: a documented run recipe exists in the brief. (`command` then runs it to prove it starts.)
  2. `command`/`artifact`: golden path executes; evidence = command transcript or, when B6.4 browser runtime exists, a screenshot and a clean console log [E partially: Replit testing, Claude Code Desktop auto-verify; "golden path" wording [I]].
  3. `manual`: the person's `keep | kill` verdict [I: human decision, not automatic promotion, `C s3`].
- **Board mapping:** a stage Task "POC"; subtasks = the few build steps; criteria = the 3 above; `poc-brief` ACs are the golden-path steps (Part A quick path, tasks trace to them).

### Stage 2 - MVP: "it works for a real person, reliably enough to be used"

- **Entry:** POC verdict `keep`; requirements written as testable statements (a full spec-mode run, Part A) [E: Kiro EARS, Spec Kit "testable, measurable"; the act of moving POC to requirements is [I], `C s3` Stage 2]; the work is on a branch, not the default branch [E: v0 never pushes to main].
- **Work:** turn the prototype into an application with the following bar (each row is BOTH a stage-mandated requirement injected into the spec (B.4) and an exit criterion):

| Dimension | MVP bar | Verifier | Evidence basis |
|---|---|---|---|
| Tests | Every `R-n` has at least one passing check; the test command exists and is green | `command` (+ `spec.check`) | [E] Replit testing, Kiro correctness loop, Spec Kit test-first; the "each requirement has a passing check" rule is [I] (`C s3`) |
| Persistence | Data survives a restart; a schema/migration path exists | `command` (restart test) + `probe` | Firebase/AI Studio/Replit wire storage when needed [E]; specifics [I] |
| Auth | Any endpoint or screen that touches per-user data requires sign-in | `command` (unauthenticated request is refused) | Auth is wired in builders [E]; this test [I] |
| Secrets | None in tracked files or prompts/journal; per-environment values | `probe` (secret scan) | [E] secrets handling in Replit, Lovable, Firebase/AI Studio; `C s4 #10` |
| CI | Lint + typecheck + tests run on the branch in a repeatable way | `command` (local CI script or the repo's CI status) | [I] |
| Observability | Structured logs, a health endpoint | `probe`/`command` | [I] |
| Docs | README: what it is, run, test, configure | `probe` (sections present) | [I] |
| Security | Dependency and static scan with no critical finding; may warn or block per policy | `command` (scanner) | [E] Lovable Quick scan (warn by default, block optional), Replit Semgrep pre-deploy, `C s2`; `C s4 #6` |
| Rollback | A previous build is restorable (tag + rebuild proved once) | `command` | [E] Replit deployment rollback, Vercel; local form [I] |
| Build artifact | A deployable bundle exists; nothing is published | `command` | `C s4 #9` |

- **Artifacts:** the spec folder (`requirements`, `design`, `tasks`, `analysis`; Part A), `stage-mvp.md`, `readiness.md`, evidence attachments (test report, scan report), the project rules file (stack, structure, conventions; steering/constitution `Bf F12, F14`).
- **Exit criteria:** all bar rows `met` or `waived-with-reason`; security scan has no critical finding (or a waiver) [E Lovable]; a rollback proven [E]; the person approves `stage.exit`. The waiver of "auth" for a purely local single-user tool is the kind of case the waiver exists for.
- **Board mapping:** Task "MVP" whose criteria are the table rows plus one criterion per spec `AC`; subtasks from `tasks.md`; the stage-mandated NFRs appear as `R-NFR-*` requirements so the same traceability check covers them.

### Stage 3 - Structured product: "it can be operated, changed and trusted over time"

- **Entry:** MVP in use, and a person's launch decision [I, `C s3` Stage 3]. Stage 3 is a continuing state, not a one-time gate: the checklist is re-run before each release and before large changes.
- **Work (Vercel production-checklist categories, `C s2` and `C s3` Stage 3, [E]):**

| Dimension | Product bar | Verifier |
|---|---|---|
| Operations | A runbook, an incident/escalation note, a stage-promote-rollback practice written down and exercised once | `probe` (docs) + `manual` |
| Security | Security headers/CSP where relevant, rate limiting on public entry points, roles/access model, audit log of admin actions, committed lockfiles, dependency updates routine | `probe` + `command` |
| Reliability | Failure modes listed with a chosen behaviour (timeouts, retries, backups/restore tested) | `command` + `manual` |
| Performance | Budgets stated and measured (e.g. web vitals where a web UI exists) | `command`/`artifact` |
| Observability | Logs persisted, metrics/alerts defined | `probe` + `manual` |
| Cost | A budget with alert; the journal already gives the harness's own spend, and the project's runtime spend is theirs to state | `manual` + journal figure |
| Docs | Architecture doc, decisions record, changelog, contributing guide, public API contract | `probe` |
| Change discipline | Constitution-style gates (simplicity, anti-abstraction, integration-first as the project chooses) and the analyze pass before big changes; environment tiers with promotion | `spec.check` + `manual` (Bf F14/F15, F18; Vercel tiers via v0, `C s2`) |

- **Artifacts:** `stage-product.md` with the checklist and a per-item record (state, evidence, waiver) [I, "per-item state kept as a record", `C s3`]; a spec set kept current; readiness history.
- **Exit criteria:** there is no final exit; the state is "checklist items resolved or explicitly waived with a reason" [I, `C s3`]. A new release re-opens the criteria that a change can affect.
- **Board mapping:** Task "Product readiness" with one criterion per row; changes after launch are ordinary spec-mode runs (Part A) whose tasks are labelled with the product stage.

### Promotion mechanics and gates

`stage.exit` is `gated`: only a person can release it; it checks that every criterion is `met` or `waived` (with a reason), snapshots `readiness.md` (hash), writes `stage.exited{from, to, actor, criteria}` and seeds the next stage Task from the stage template. Skipping a stage is not supported by the tool (a person can create tasks by hand on the board, the board is the board). A stage may regress: `stage.reopen` (gated) reopens criteria when a change invalidates them; that is journaled the same way.

### Which parts are B8 built-ins and which are new runtime tools

- **B8 built-ins:** commands `/poc`, `/mvp`, `/product`, `/stage`; skills `stage-poc`, `stage-mvp`, `stage-product` (the checklists as text; the machine-readable form is the template below); agent profiles `poc-builder` (accept-edits inside the worktree) and `security-reviewer` (read tools, cheaper model) as built-ins (B8 §5.3).
- **New runtime pieces:** the pure **stage template** (criteria as data: id, text, dimension, verifier kind, default), the pure **readiness evaluator**, and the tools below. Templates are catalogue-overridable (project scope needs folder trust, B8 §4) so a team can raise or drop bars; an overridden or lowered template is shown as such at the gate.

### Events journaled

`stage.started{project, stage}`, `stage.criterion.verified{id, kind, result, evidenceRef}`, `stage.criterion.waived{id, reason, actor}`, `stage.criterion.failed{id, evidenceRef}`, `stage.exit.requested{stage}`, `stage.exited{from, to, actor}`, `stage.reopened{stage, criteria, actor}`, `stage.cost{stage, total}` (derived). Cost per stage is the sum of journal call costs on runs filed under the stage's tasks.

## B.3 Native tools and commands it adds

| Name | Kind | Purpose | Class |
|---|---|---|---|
| `/poc <idea>`, `/mvp`, `/product` | commands | Start or continue a stage for the current project | n/a (person-typed) |
| `/stage` | command | Show stage, criteria state, evidence, cost per stage | n/a |
| `stage.status` | tool | Read stage, criteria, evidence refs | auto (read-only) |
| `stage.verify` | tool | Run the auto verifiers of a stage (commands go through the policy as `shell.start`) | ask (command verifiers), auto (probes) |
| `stage.evidence` | tool | Attach evidence to a criterion (wraps `artifact.attach`, requires the artifact to exist) | auto |
| `stage.waive` | tool/host action | Waive a criterion with a reason | gated (person only) |
| `stage.exit` | tool/host action | Promote or kill; closes the stage Task | gated (person only) |
| `stage.reopen` | tool/host action | Reopen criteria after a regression | gated |
| Board: `Task.lifecycle` field, criterion state `waived` | ALM change | Record stage and waivers | n/a (server) |

The verifier commands are ordinary shell calls: the deny floor and profile rules apply exactly as to a model-issued call (the B8 after-edit-step model, B8 §5.6).

## B.4 How the quality bar is injected into work

When a spec-mode run starts inside a stage, the stage template's rows are offered as **stage-mandated requirements** (`R-NFR-n`), prefilled with their verifier, and enter `requirements.md` for the person to keep, edit or waive at G1. They then flow through the same tasks-to-criteria trace as any requirement. That is how the bar is raised: not by a reminder in a prompt, but by requirements that must be met, or waived by a person, before the stage can close.

## B.5 Proposed board items

| Id | Item | Size | Depends on |
|---|---|---|---|
| E-B1 | ALM lifecycle model: `Task.lifecycle`, stage child tasks, criterion `waived` state, `done` rule extended, shared-task/central impact reviewed | medium | the ALM phase of M §26 |
| E-B2 | Pure stage templates (criteria as data, verifier kinds) + readiness evaluator + tests | medium | E-B1, B8.1 |
| E-B3 | Tools `stage.status/verify/evidence/waive/exit/reopen`, the gated class, events | medium | E-A4 (gated class), E-B2, `artifact.attach` v2 |
| E-B4 | POC stage: `poc-brief` template, worktree bootstrap, run recipe verifier, `poc-builder` profile, keep/kill verdict | medium | E-B3, E-A6, H4 (soft), B4.7 |
| E-B5 | POC/MVP evidence for web output: screenshot and console via browser runtime | giant | B6.4, B9.2 (optional; POC works without it using command transcripts) |
| E-B6 | MVP verifiers: secret probe, dependency/static scan wrapper (shell to a scanner; in-house scanner is a later medium), rollback proof, test-per-requirement rule | medium | E-B3, B8.9 |
| E-B7 | Product stage: checklist template, readiness re-run, per-release reopen | medium | E-B3 |
| E-B8 | Stage-mandated NFR injection into spec mode (`R-NFR-*`) | small | E-A6, E-B2 |
| E-B9 | Surfaces: stage view on the board and in the Sessions workspace (criteria, evidence, cost per stage, waivers), TUI and VS Code affordances | medium | E-B1, UI.6 |
| E-B10 | Delegated security/review pass on another harness for a stage (optional) | medium | B6.2, B6.1 |
| E-B11 | Commands `/poc /mvp /product /stage` + skills + `security-reviewer` profile | small | B8.5, B8.6, B8.7 |

## B.6 Risks and open questions (B)

- **R10 Invented thresholds.** Most rows in the MVP and product tables are [I]. Presenting them as a standard would be dishonest; they ship as an overridable default template, labelled as ours, with evidence tags visible in the UI.
- **R11 Are three stages right?** The market has no reference (section 0). Do we want to allow a project to define its own stage names/templates from day one, with these three as the built-in set?
- **R12 Waiver abuse.** A waiver is a person's word; it is recorded and shown at the next gate, but nothing stops a person waiving everything. That is consistent with "the gate is the person's" (M §26 on approvals), yet worth a visible "waived N of M" on the stage card.
- **R13 Verifier trust.** A `command` verifier is only as good as the command (a test suite that asserts nothing passes). The checker proves a command ran and exited 0, not that it tests the right thing; the person's G1 and the `manual` rows carry that.
- **R14 Scanner choice and network.** A dependency scanner may need network; local-first means offline by default, so the scan verifier must say "could not run offline" as a failed-to-verify state, not `met`.
- **R15 Local-first vs "product".** Publishing, custom domains and hosted rollback are out of scope on purpose (`C s4 #9`, "Not in the top 10 on purpose"). Confirm that "product" for us means "operable and trustworthy", not "deployed by us".
- **R16 Existing repositories.** Adopting a project already past POC: does the person start at MVP with criteria evaluated retroactively? Proposed: yes, `/mvp` on an existing repo runs `stage.verify` to show where it stands, before any work.
- **R17 Central sharing.** Stage tasks are ALM tasks; the existing rule that a task reaches a central only when its owner opts it in, one at a time, applies unchanged. Confirm evidence attachments never travel.

---

# PART C - How A and B compose

1. **A is the engine, B is the frame.** A stage does not implement anything itself; it defines what "done" means for a body of work and delegates the work to spec-mode runs. B supplies the criteria template; A supplies phases, artifacts, gates, traceability and board landing.
2. **Composition flow.** `/mvp` -> the stage Task exists with its template criteria -> the person starts `/spec` inside it (the run is tagged with the stage) -> spec mode injects the stage-mandated `R-NFR-*` requirements (B.4) -> G1/G2/G3 as usual -> `spec.file` files subtasks under the stage Task and copies criteria (spec ACs and stage criteria live side by side) -> sessions build under `accept-edits` -> `stage.verify` gathers evidence -> the person approves `stage.exit`.
3. **Same primitives everywhere.** Both parts use: the plan permission profile and the catalogue (B8), the `gated` class, hash-bound person approvals, the journal for events and exact cost, `artifact.attach` for evidence, and the ALM board for status. One gate implementation, one evidence mechanism, one place status lives.
4. **Profile hand-offs are person-visible.** Spec phases run under `spec` (plan-derived, read-only for product code); building runs under `accept-edits`; the switch is an event and drops session approvals when it loosens (B8 §5.5). The stage never widens what the deny floor forbids.
5. **POC shortcut.** The POC stage runs the quick spec path (phase 0 routing, Bf F06/F27), so the ceremony is proportional; MVP runs the full path; the product stage runs a spec per change with the product checklist as a standing requirement set.
6. **Delivery order (suggested).** E-A1..E-A5 (spec mode without the board) -> E-A7 (landing, when M §26 lands) -> E-B1..E-B3 -> E-B4 (POC) -> E-B6 (MVP) -> E-B7/E-B9. E-A4's `gated` class is the shared dependency; decide R3 first.
