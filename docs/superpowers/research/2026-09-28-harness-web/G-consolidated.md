# G - Consolidated list for filing (research A-D + designs E, F)

Date: 2026-09-28. Documentation only. Authority for "already filed": BOARD.md (ids below are the board labels, e.g. B6.1, H25; `s-...` hashes are in BOARD.md).
Source shorthand: `A#n`/`B#n`/`C#n`/`D#n` = Top-N gap n of that research file; `A:row "x"` = a row of A's table; `E:A.n`/`E:B.n` = E section; `F:A.n`/`F:B.n` = F section; `E-A1..`, `E-B1..`, `ORC.n`, `ART.n` = the design's own draft ids.
Draft-id prefixes here: SPEC, LIFE, ORC, ART, TOOL, OTH. Dependencies name board labels or other new ids.

---

## 1. Already on the board (gap -> item; nothing to file)

- Subagent spawn / wait / stop, depth cap (A:row "Subagent spawn tool") -> B6.1
- Delegate a task to another harness (A#14 partly, E/F "critic on another harness") -> B6.2
- MCP bridge, per-server approval, origin-bound credential (A#15 partly) -> B6.3, B8.8
- Browser runtime, Playwright, gated (A:row "Browser and computer control", C#1 tool half) -> B6.4
- ALM tools in the conversation (A:row "Persistent task tracker with dependencies") -> B6.5
- Memory as facts derived from the journal (A:row "Auto memory") -> B6.6
- web.fetch / web.search -> B6.7
- Read-only `plan` permission profile (the seed of A#2, C#3) -> B4.7 (in progress), B8.4
- Custom commands, /review as built-in command, skills, agent profiles, MCP declarations, after-edit steps, folder trust, installer -> B8.5, B8.6, B8.7, B8.8, B8.9, B8.3, B8.10
- AGENTS.md read into the system prompt (A#10 partly) -> H2; lean/full prompt -> B4.5, H1-full
- Loop guard (A:row "Repeated-call loop detection") -> H18 (done)
- Desktop notification on needs-you (A:row "Notifications") -> H17
- LSP diagnostics after edit, opt-in (D#3 first half) -> H25
- Undo of edits (A#13 first half) -> H4; fork and export of a session -> H21
- Headless `agentop code --json` (D#8 base, A#4 partly) -> H16
- Git write tools incl. worktree (A#6, B#5 ingredient; F:ORC.7 dependency) -> H15
- Reasoning effort, image input, rate-limit visibility (A#11 partly, C#1 dependency) -> B9.1 (todo), B9.2 (todo), B9.3 (done) — corrected 2026-09-28 against the board; the first draft marked all three done
- Model change mid-session, same provider -> H24
- Extra folder as context -> H20; ACP server -> H23; VS Code native sessions -> H22
- Server hosts native sessions (needed by every surface item below) -> B4.6
- Per-run cost line and context gauge (used for per-phase cost) -> H6
- Context manager, no summaries (A:row "Context compaction") -> B4-CTX, H5
- Prompt for permission with reason, session rules, permission mode (TUI) -> P1 CD-07, CD-08, CD-15, CD-16
- TUI command palette, panels, sessions tab, tasks view, wizard -> the Harness TUI board (P1-P5); ORC/ART/SPEC surfaces below hang off it, they do not duplicate it
- Bill reconciliation of usage -> B5b.2
- Provider gateway (optional) -> B7.1
- Semantic memory retrieval: explicitly out of v1 in B6.6 (not filed, see section 5 Q17)

## 2. Extends an existing item (add to scope, no new item)

| Existing item | Add to its scope | Source |
|---|---|---|
| B4.7 (three built-in profiles) | The `plan` profile must be amendable by a scoped allow (one tool, one path glob) so a spec mode can write only its artifacts; the profile-switch is a journaled event and approvals survive only a switch to a stricter profile | E:A.2 "How the plan profile enforces read-only" |
| B8.4 (permission profiles, settings rules as layers) | A new permission class **gated**: only a person can release it, no allow-for-session/prefix, the actor is recorded. Shared by SPEC.4, LIFE.3, ORC.10. Name in one place | E:A.3, R3 |
| B8.5 (command registry, custom commands) | (a) command parameters and a response-schema field, retry check (B#12 recipes); (b) a `person`-only command class not reachable from any model call; (c) an optional `orchestration: <name>` field that opens a launch card (never launches) | B#12, F:A.3, F:A.2.5 |
| B8.7 (agent profiles, `agent.spawn({profile})`) | Profile may carry a model per phase and a `small_model` for cheap side tasks (same provider, B8 Q5 stands); built-in profiles added by the designs: `spec`, `spec-critic`, `poc-builder`, `security-reviewer`, `explore` | A#11, E:A.2 phase routing, E-A11, E:B.2 |
| B8.2 / backup rows | `ALWAYS` allowlist entries with a reason for `orchestrations/` and `artifacts/` stores (the coverage lint forces the decision) | F:A.2.5, F:B.2.2 |
| B8.1 (catalogue kinds) | New kind `orchestration` beside command/skill/agent/mcpServer/permissionProfile/afterEdit; new templates as catalogue-overridable data (stage templates, spec templates) | F:A.2.5, E:B.2 |
| B8.9 (after-edit steps as policy-judged calls) | Verifier commands (test, scan, secret probe) reuse the same path: a command verifier is an ordinary shell call under the policy | E:B.3, C#6 |
| H2 (AGENTS.md) | Imports, path-scoped rules, just-in-time subtree files, a personal local file; an optional `docs/specs/constitution.md` read as standing project rules (conditional inclusion) | A#10, B#9 (F12/F14/F15) |
| H4 (Undo) | Persisted, named, whole-state checkpoints (files + conversation, restore either or both, auto-created at milestones and before recovery attempts); shadow-git compare | C#2, A#13, B#10 |
| H21 (fork and export) | Fork/rewind of the conversation and of the code independently; per-message revert | A#13 |
| H16 (headless) | A non-interactive permission mode (deny what would ask, never wait) and required ceiling flags; exit code 2 with a sentence when a mandatory flag is missing | A "below the cut" (dontAsk CI), F:A.2.4 #7 |
| B6.1 (agent.spawn/wait/stop) | Resume a finished subagent; named-agent messaging; a fork that inherits the conversation (A#14); the runtime's own records are the authoritative list; "orchestrated" agents scheduled by the host count toward the same depth cap | A#14, F:A.2.7 |
| B6.2 (delegate) | The delegated harness's session is registered as an agent of the run and measured by the existing per-harness readers; where its cost is unreadable it is `unknown`, never 0; wall-clock kill as the only hard bound | F:A.2.9b |
| B6.3 (MCP bridge) | Deferred/searchable tool loading and per-agent MCP scoping so tool descriptions do not fill the context (A#15); a skill/tool cost view | A#15 |
| B6.5 (ALM tools) | The tools compose to file a whole spec (task, subtasks, criteria, dependencies) in one approved step; nothing it files is dispatched | E:A.2 "Landing" |
| B6.6 (memory) | Model-written notes (`memory.note`, v3) stay behind the same consent and journal rules | A:row "Auto memory" |
| B3.7 / H18 area (`task.plan`) | Nothing new here; the completion gate is a separate item (TOOL.3) | B#15 |
| H8 (audit event) | Additive event families are declared by their owning items (spec.*, stage.*, orch.*, artifact.*), all facts-only, content never copied | E, F |

## 3. New items

Sizes: small = days, medium = 1-3 weeks, giant = a subsystem. First item of each group is the smallest slice that stands alone.

### SPEC - spec-driven plan mode (merges E-A1..E-A11 with A#2, A#3 first half, B#1, B#4, B#7, B#9, C#3, C#4)

| Id | Title | Size | Depends on | Why | Source |
|---|---|---|---|---|---|
| SPEC.1 | Spec artifact model: templates, R-/AC-/T- ids, pure parser under docs/specs/<slug>/ | medium | B8.1 | Everything else reads this; testable with no filesystem | E-A1; B#1, C#4 |
| SPEC.2 | spec.check: deterministic traceability (req -> criterion -> task -> verification kind) | small | SPEC.1 | Traceability without trusting a model to count | E-A2; B#4, F17-F22, F44 |
| SPEC.3 | `spec` and `spec-critic` agent profiles + scoped `spec.write` allow in the plan profile | small | B4.7, B8.4, B8.7 | Read-only for product code while artifacts are writable | E-A3 |
| SPEC.4 | spec.write / spec.gate / spec.reopen tools: hash-bound gates, journal events (uses the gated class) | medium | B8.4 (gated class), SPEC.1, SPEC.3 | A model can request a gate, never release one; edits make it stale | E-A4; A#2 |
| SPEC.5 | Person's gate action: host handler, web card with per-phase cost, TUI, VS Code, `agentop spec approve` | medium | SPEC.4, B4.6, TUI board | One implementation, four doors | E-A5 |
| SPEC.6 | Built-in `/spec*` commands and five spec-* skills (brainstorm, requirements, design, tasks, review) | medium | B8.5, B8.6, SPEC.4 | Know-how in skills keeps the base prompt lean | E-A6; A:row "Clarify-until-decision-complete" |
| SPEC.7 | Path router (spike / quick / full), default quick when unsure | small | SPEC.6 | Ceremony proportional to work | E:A phase 0; B#7 |
| SPEC.8 | Standing project rules for specs: constitution file, conditional inclusion, complexity justification | small | H2, SPEC.1 | Steering that gates design | B#9; E:A phase 3 |
| SPEC.9 | Per-phase cost and time from the journal, shown on the gate card | small | H6, SPEC.5 | Exact money per phase, unique to us | E-A8 |
| SPEC.10 | Board landing `spec.file`: task, criteria, subtasks, dependencies, staged sessions (no dispatch) | medium | B6.5, OTH.1, SPEC.2 | Spec cannot be "finished on paper"; board authoritative after filing | E-A7; A#3 |
| SPEC.11 | Independent critic pass: B6.1 subagent on a cheaper model, optional B6.2 delegation; findings triaged, never auto-applied | medium | B6.1, B6.2, SPEC.2 | Second look on the spec; also covers the "advisor/oracle" idea (A#11) | E-A9; B#3 |
| SPEC.12 | Bugfix variant: Current / Expected / Unchanged sections, regression-preservation criteria | small | SPEC.6 | Different shape from a feature spec | E-A10; F05 |

### LIFE - POC -> MVP -> product stages (merges E-B1..E-B11 with C#1, C#5, C#6, C#8, C#9, C#10, A#8). No reference ships this; the model is ours.

| Id | Title | Size | Depends on | Why | Source |
|---|---|---|---|---|---|
| LIFE.1 | ALM lifecycle model: Task.lifecycle, stage child tasks, criterion state `waived`, done rule extended | medium | OTH.1 | Stage is data on the board, not a prompt | E-B1; C#5 |
| LIFE.2 | Pure stage templates (criteria as data, verifier kinds probe/command/artifact/manual) + readiness evaluator | medium | LIFE.1, B8.1 | Bar is checkable and overridable, labelled as ours | E-B2; C#5 |
| LIFE.3 | stage.status / verify / evidence / waive / exit / reopen tools, events, promotion is a person's gated act | medium | LIFE.2, SPEC.4, ART.6 | One gate mechanism, one evidence mechanism | E-B3 |
| LIFE.4 | POC stage: poc-brief, worktree bootstrap, run-recipe verifier, poc-builder profile, keep/kill verdict | medium | LIFE.3, SPEC.6, H15, B4.7 | Smallest useful stage; works with command transcripts alone | E-B4; A#8 |
| LIFE.5 | MVP verifiers: secret probe, dependency/static scan wrapper (offline = "could not verify"), rollback proof, test-per-requirement, deployable bundle + branch (no publish) | medium | LIFE.3, B8.9 | The MVP bar made mechanical | E-B6; C#6, C#9 (small form) |
| LIFE.6 | Product stage: checklist template, readiness re-run, per-release reopen | medium | LIFE.3 | Continuing state, not a one-time gate | E-B7 |
| LIFE.7 | Stage-mandated NFR injection into spec mode (R-NFR-*) | small | SPEC.6, LIFE.2 | Raises the bar through requirements, not reminders | E-B8 |
| LIFE.8 | Stage surfaces: board and Sessions workspace view (criteria, evidence, waived N of M, cost per stage), TUI, VS Code | medium | LIFE.1, TUI board | Visible next to sessions and money | E-B9 |
| LIFE.9 | Web-output evidence: dev-server launch config, screenshot, console and network read, auto-verify after edit | giant | B6.4, B9.2, ART.10 | The real truth check for UI work; sliceable | E-B5; C#1, A#8 |
| LIFE.10 | Delegated security/review pass for a stage on another harness (optional, consented) | medium | B6.2, B6.1 | Independent reviewer, never required | E-B10 |
| LIFE.11 | Commands /poc /mvp /product /stage, three stage skills, `security-reviewer` profile | small | B8.5, B8.6, B8.7 | Entry points | E-B11 |

### ORC - native orchestration "ultracode" (F:A ORC.1-17, merged with A#1, A#9-adjacent, B#2, B#3, B#5, B#8). Feature is giant; sliced: ORC.1-6 headless engine, 8-10 person loop, 11-13 windows.

| Id | Title | Size | Depends on | Why | Source |
|---|---|---|---|---|---|
| ORC.1 | Pure core: manifest schema, static checker, estimator arithmetic, ledger (reserve/settle), step-key hashing | medium | B6.1, TOOL.1 | Pure and testable first; reuses the schema validator | ORC.1; A#1 |
| ORC.2 | Sandboxed script interpreter (WASM JS engine), verb bridge, determinism, limits, escape-test suite + security review | medium | ORC.1 | Untrusted code from day one; needs Q on the dependency | ORC.2 |
| ORC.3 | Scheduler on the AgentRunner port: concurrency, reservations, pause-on-ceiling, per-agent USD cap | medium | ORC.1, B6.1 | Hard budgets, not warnings | ORC.3 |
| ORC.4 | Journal events, agent fields, OrchestrationView projection, cost-per-phase queries; read-only `orchestration.status/result` tools | medium | ORC.1, journal | One shape all surfaces read | ORC.4; F:A.3 |
| ORC.5 | Resume and content-keyed cache with world stamps, effect guard, resume-as-launch | medium | ORC.3, ORC.4 | Edit reruns only what changed | ORC.5 |
| ORC.6 | Verb library: judge, verify (skeptics, evidence-required refutation), untilDry, critic, pipeline without barriers | medium | ORC.3 | Verification is what cuts reviewer noise | ORC.6; B#3, A#7 |
| ORC.7 | Writer isolation: worktree per writing agent, patch artifacts, explicit integrate step, dirty-checkout refusal | medium | B6.1, H15, ART.2 | Concurrent writers never share a checkout | ORC.7; A#6 |
| ORC.8 | B8 kind `orchestration`: entry, trust, precedence, backup entry, /orchestrations | medium | B8.1, B8.2, B8.3, B8.5 | Scripts as catalogue data, project scope untrusted | ORC.8 |
| ORC.9 | Built-ins as scripts: review, research, audit, verify-claims, batch-edit | medium | ORC.6, ORC.8, ART.5, TOOL.2 | `review` is the script form of TOOL.7 | ORC.9; D#1 |
| ORC.10 | Launch card + host-minted PersonConfirmation, estimate with measured basis, role->model binding, headless flags; no model-reachable launch, no keyword, no default model, no "always" | medium | ORC.1, B4.6, H16, B8.4 (person class) | The owner's lost-money incident | ORC.10 |
| ORC.11 | Web: Orchestration aside tab, fleet chip, controls, mobile version, capability-guard registration | medium | ORC.4, ORC.10, B4.6 | Windows onto one run | ORC.11 |
| ORC.12 | TUI: run pane, launch card, keys, pure row-budget function | medium | ORC.4, ORC.10, TUI board | Same words as the web | ORC.12 |
| ORC.13 | VS Code: tree view + launch webview (client of the server) | small | ORC.4, ORC.10 | Client only | ORC.13 |
| ORC.14 | `delegate` step over B6.2: soft-bound accounting, provenance for external cost | medium | B6.2, ORC.3 | Cross-harness step, honest about soft bounds | ORC.14 |
| ORC.15 | ALM: file a run under a task/subtask, per-phase cost in task metrics, report as evidence | small | ORC.4, ART.6, B6.5 | Board rollup through sessions | ORC.15 |
| ORC.16 | Unattended-approval model: deny-by-default with card pre-grants, or park as needs-you | small | ORC.3, B4.7 | A fan-out of 40 cannot open dialogs | ORC.16 |
| ORC.17 | Acceptance: run `review` on a fixture repo, kill mid-run, resume, cost per phase reconciled with the journal | small | ORC.9, ORC.5 | Umbrella proof | ORC.17 |
| ORC.18 | Task-graph scheduler: run ALM subtask dependencies as waves, one worktree per unit | medium | ORC.3, ORC.7, B6.5 | Turns the board's dependencies into a run | B#5 (F08, F41, F65, F94) |

### ART - native artifacts (F:B ART.1-12 merged with A#5, B#6, C#7, C#8, D#10). Local only, no public links.

| Id | Title | Size | Depends on | Why | Source |
|---|---|---|---|---|---|
| ART.1 | Pure core: kinds, validators, size caps, external-reference scan, secret-shape refusal, version model, deterministic text describer | medium | journal | The rules before any IO | ART.1 |
| ART.2 | Store: content-addressed blobs, journal entities/events, pinning, prune-with-expiry, backup row + lint | medium | ART.1 | Immutable, hash-tied to the producing event | ART.2 |
| ART.3 | Tools artifact.create / update / list / read + host wiring with blocked-reference feedback | medium | ART.1, ART.2, B4.6 | Writes only into the bounded store, so class auto | ART.3 |
| ART.4 | Sandboxed render route (CSP header, opaque origin), web "Rendered" section in the aside, version selector, diff, mobile viewer | medium | ART.2, B4.6 | Model HTML is untrusted code | ART.4; A#5, C#7 |
| ART.5 | Renderers for mermaid, chart, slides, findings, table (vendored, no CDN) | medium | ART.4 | Declarative kinds render the same everywhere | ART.5; D#10 |
| ART.6 | Evidence: artifact.attach pinned by hash, verifiedBy, accept/detach gestures, board evidence view | medium | ART.2, artifact.attach v2 | An agent's attachment is a claim until accepted | ART.6; C#8 |
| ART.7 | TUI: describer views, bordered source, text charts, paged slides, terminal-image detection, "open in web" line | medium | ART.1, ART.3, TUI board | Honest second-class renderer | ART.7 |
| ART.8 | VS Code webview panel (host-fetched, nested sandbox) | small | ART.4 | Same rule as the fleet screen | ART.8 |
| ART.9 | artifact.export (policy-judged) + /artifacts and `agentop artifact` commands | small | ART.3, B8.5 | Export replaces sharing | ART.9 |
| ART.10 | artifact.screenshot for html via the browser runtime (gated) | medium | B6.4, B9.2 | Evidence for web output | ART.10; C#1 |
| ART.11 | Shared-task evidence metadata (no bytes) to a central; optional per-artifact opt-in | small | ART.6 | Follows the task-files rule | ART.11 |
| ART.12 | Security review and escape tests for frames (network denial, origin isolation, SVG, raw markdown HTML) | small | ART.4 | Gate on the biggest surface | ART.12 |

### TOOL - new native tools (research D + A/B gaps not covered by a design)

| Id | Title | Size | Depends on | Why | Source |
|---|---|---|---|---|---|
| TOOL.1 | Schema-validated structured output with bounded retries (each retry journaled), for agent results and headless runs | small | B6.1 (soft), H16 (soft) | ORC and review both need it; useful alone | A#4; F:A.2.2 |
| TOOL.2 | `report.findings` tool: file, summary, failure scenario, category, severity; marked fixed/skipped after the follow-up edit | small | ART.1 (findings kind) | Structured review output surfaces can render | D#2; F:B.2.1 |
| TOOL.3 | Completion gate: open task.plan items and evidence-before-claims block "done"; no-progress detection | small | H18, B3.7 | Stops premature finishes (policy, not a hook) | B#15 (F35, F119); A:row "Stop-gate" |
| TOOL.4 | Ranked repository map under a token budget | medium | B4-CTX (soft) | Cheaper orientation than grep sweeps; embeddings not included | B#13 (F124); D#9 first step |
| TOOL.5 | LSP navigation tools: definition, references, symbols, implementations, call hierarchy (rename a stretch) | medium | H25 | Beyond diagnostics; opt-in like H25 | D#3 |
| TOOL.6 | Structured test-runner tool returning per-test results, feeding after-edit steps and verifiers | medium | B8.9 | Deterministic evidence for criteria | D#6 |
| TOOL.7 | Local review pipeline over a diff: parallel finders, refutation pass, dedupe, severity rank | medium | B6.1, TOOL.1, TOOL.2 | Precursor of ORC.9 `review`; usable before ORC | D#1; B#3 |
| TOOL.8 | Review rules file: severity, nit cap, skip paths, verification bar (separate from AGENTS.md) | small | TOOL.7 | Tunable noise | D#5 |
| TOOL.9 | Review-then-fix loop and PR comment posting through gh/glab | small | TOOL.7, H15 | Closes the loop locally | D#7 |
| TOOL.10 | Monitor tool: push background shell output lines into the loop | small | B3.5 | Long-running builds without polling | D#4 (row 24) |
| TOOL.11 | Schedule / loop / wake-up: cron with expiry, self-paced wake with a stop flag, opt-in | medium | H16, B4.6 | Recurring runs; ceilings mandatory | D#4; A#12 (local part), B#14 |
| TOOL.12 | Notebook cell edit tool | small | file.patch | Missing file type | D#10 |

### OTH - other

| Id | Title | Size | Depends on | Why | Source |
|---|---|---|---|---|---|
| OTH.1 | ALM: AcceptanceCriterion (open/met/failed + evidence refs), done refused with an open criterion, prepared-session spec/allowed-files/criteria fields | medium | none on board (M §26 is not filed) | Foundation for SPEC.10 and LIFE.1 | E:A "Landing", E-A7 |
| OTH.2 | Goal / autopilot: persisted end condition, token or dollar budget, reminders, stop conditions | medium | H18, B6.1 | Multi-turn autonomy bounded by money | A#9 |
| OTH.3 | /init project bootstrap generating AGENTS.md | small | H2, B8.5 | Common first run | A#10 |
| OTH.4 | Secrets handling: intercept keys typed into prompts, keep them out of files and journal, per-environment values | medium | B1.3 (done) | Redaction seeds exist; the intercept does not | C#10 |
| OTH.5 | Opt-in headless CI runner: issue/@mention to PR, CI-failure fix, never the default branch | giant | H16, H15, TOOL.9 | Local-first: off unless the owner opts in | D#8; A#12 |

---

## 4. Never (rejected by a recorded constraint)

- Public share link, publish, hosted copy or remix of a session or artifact -> D10 local-only, nothing leaves the machine.
- Cloud fleets, remote/cloud task execution, hosted deployment, custom domains, hosted rollback -> local-first (D10); the local form is "bundle + branch + PR" (LIFE.5).
- Free shell hooks, model-evaluated Stop hooks running scripts, `notify` command -> "no free shell hooks: veto = policy, observe = journal/events"; TOOL.3 and the verify verbs are the equivalents.
- Plugin code in-process, marketplace loader -> D9 (contract now, loader on demand).
- Model-written summaries of the context or of a phase standing in for the artifact -> CTX 6.5; phases carry approved files.
- A "yolo"/bypass mode, or any mode lifting the deny floor; "Always allow" on an orchestration; a keyword that starts a run; inheriting the session model for an orchestrated agent -> the deny floor is never lifted (INV) and F:A.2.4 invariants.
- A model-callable tool that approves a gate, releases a stage or launches a run -> person-only by construction (E:A, F:A.2.4).
- Runtime package importing server/web -> D23.
- Any capability that needs another harness installed to work -> other harnesses are precedent, never a dependency.
- A project-scope config, script or template acting before the folder is trusted -> untrusted until trusted (B8 §4).
- Reading, citing or paraphrasing openclaude/Gitlawb or any leaked Claude Code source -> standing prohibition.
- Rendered artifact with network, same-origin access, or auto-opened tab; agent-chosen filesystem path; secrets stored in an artifact -> F:B.2.5.
- Desktop computer use (screen control) -> deferred: clashes with sandbox and local-first (D#note); not filed.
- Embeddings/semantic index without an explicit consent switch -> B6.6 "no semantic retrieval in v1"; only the repo map (TOOL.4) is filed.

## 5. Owner decisions needed (deduplicated; recommendation in brackets)

Spec mode
- Q1. Is `docs/specs/<slug>/` the artifact root (configurable per project)? [Yes; it coexists with the repo's flat dated specs.] (E R1)
- Q2. Write spec artifacts through a dedicated scoped `spec.write` while `plan` stays read-only, or hold text in the store until G1? [Scoped `spec.write`.] (E R2)
- Q3. Add a new permission class `gated` (person-only, no session-allow)? Or map it onto `ask` with session-allow disabled? [New class; shared by spec, stage and orchestration.] (E R3, F person class)
- Q4. May G2 merge into G3 on the quick path (two gates)? [Yes.] (E R4)
- Q5. Default path when the router is unsure: quick? [Yes.] (E R5)
- Q6. May the critic pass send a spec to another vendor's harness? [Only with explicit per-use consent, off by default.] (E R8)

Lifecycle
- Q7. Three built-in stages with project-defined stage names allowed from day one? [Yes: three built-ins, overridable templates.] (E R11)
- Q8. Ship the MVP/product thresholds as labelled defaults ("ours"), with [E]/[I] evidence tags visible? [Yes.] (E R10)
- Q9. Show "waived N of M" on every stage card? [Yes.] (E R12)
- Q10. Does "product" mean operable and trustworthy, not deployed by us? [Yes; deploy stays out.] (E R15)
- Q11. Existing repositories: `/mvp` runs verification retroactively before any work? [Yes.] (E R16)
- Q12. Scanner needing network: report "could not verify offline" rather than met? [Yes.] (E R14)

Orchestration
- Q13. Surface name: "orchestration", with "Ultracode" as the panel label? [Yes.] (F ORC Q1)
- Q14. Ceiling defaults: 200 agents, 256 items per fan-out, concurrency 4 (max 16)? [Accept; card can raise with a warning.] (F ORC Q2)
- Q15. Accept a WASM JS engine dependency in `packages/runtime` for the script sandbox, or start with a declarative subset? [Accept, gated on the escape-test suite and security review.] (F ORC Q3)
- Q16. May the model ever suggest an orchestration in text? [No, person-initiated only in v1.] (F ORC Q4)
- Q17. Unattended agent hitting an `ask`: deny-by-default with card pre-grants, or park as needs-you? [Deny-by-default; park optional per run.] (F ORC Q5)
- Q18. May a run bill a different provider than the launching session (a visible card choice)? [Yes, shown on the card.] (F ORC Q6)
- Q19. Should `batch-edit` publish PRs? [No in v1; ends at branches and patches.] (F ORC Q7)

Artifacts
- Q20. Kinds set right (chart and slides as declarative specs, free HTML for the rest)? [Yes.] (F ART Q1)
- Q21. Caps: 5 MB text / 25 MB image per version; session and version-count totals? [Accept; visible in Settings.] (F ART Q2)
- Q22. Artifacts session-scoped in v1 (task attachment is the cross-session link), or a project gallery? [Session-scoped.] (F ART Q3)
- Q23. Shared-task evidence: metadata only on the central, or an explicit per-artifact "send bytes" opt-in? [Metadata only; opt-in later.] (F ART Q4, E R17)
- Q24. `html` artifacts run scripts with network off in v1? [Yes, behind ART.12.] (F ART Q5)
- Q25. `artifact.create` class auto, or ask for the first of a session? [Auto.] (F ART Q6)
- Q26. Announce a new artifact with a chip, never auto-open? [Yes.] (F ART Q7)

Research-raised
- Q27. Is the ALM acceptance-criteria work (M §26) filed on the ALM board as OTH.1 now, given nothing on BOARD.md covers it? [Yes; SPEC.10 and LIFE.1 wait on it.]
- Q28. File OTH.5 (headless issue-to-PR runner) at all, given local-first? [File as opt-in, low priority.]
- Q29. File OTH.2 (goal/autopilot with a budget)? [Yes; it reuses ORC's ledger idea.]
- Q30. Semantic index with embeddings behind a consent switch? [Not now; TOOL.4 first.]
- Q31. Image generation tool (provider-gated) and the below-the-cut items (network-domain allowlist proxy, shell env scrubbing, mid-turn message queueing, prompt-render diagnostics)? [Not filed; revisit after ORC and SPEC.]
- Q32. Should TOOL.7 ship before ORC (as the local review pipeline) and ORC.9 later wrap it as a script? [Yes.]

## 6. Counts (new items)

| Group | Items | small | medium | giant |
|---|---|---|---|---|
| SPEC | 12 | 6 | 6 | 0 |
| LIFE | 11 | 2 | 8 | 1 |
| ORC | 18 | 4 | 14 | 0 |
| ART | 12 | 4 | 8 | 0 |
| TOOL | 12 | 7 | 5 | 0 |
| OTH | 5 | 1 | 3 | 1 |
| **Total** | **70** | **24** | **44** | **2** |

ORC as a whole is a giant feature; it is filed as sliced items. Section 2 lists 18 scope additions to existing items (no new filing).
