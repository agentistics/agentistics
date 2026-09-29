# B — Coding-agent features and methods (Kiro, Spec Kit, Tessl, superpowers, BMAD, Agent OS, Claude Code multi-agent, OpenHands, Devin, Codex cloud, Jules, claude-squad, Cline, Roo, Aider, Goose)

Scope note: only what the fetched page text states. Several pages were 404s, redirects or empty (Tessl docs, BMAD workflow-map, Goose subagents/permissions/creating-plans, Roo browser-use, Cline hooks/workflows/focus-chain page, Codex best-of-N search, OpenHands delegation, LangGraph, Kilo, Conductor, Crush). Rows built on search-result summaries say so in the Mechanism column. Nothing here comes from Gitlawb/openclaude or leaked source.

"Ours" is judged against INVENTORY.md (ids: B6.x, B8, H-items, B4.x, B9.x, constraints D9 etc.). Rows marked "product" refer to the shipped analytics/session-manager/ALM product, not the native harness.

## Source key (full URLs)

| Key | URL |
|---|---|
| K1 | https://kiro.dev/docs/specs/ |
| K2 | https://kiro.dev/docs/specs/quick-spec/ |
| K3 | https://kiro.dev/docs/specs/bugfix-specs/ |
| K4 | https://kiro.dev/docs/specs/feature-specs/ |
| K5 | https://kiro.dev/docs/specs/best-practices/ |
| K6 | https://kiro.dev/docs/hooks/ |
| K7 | https://kiro.dev/docs/steering/ |
| SK1 | https://github.com/github/spec-kit |
| SK2 | https://github.github.com/spec-kit/ |
| SK3 | https://github.com/github/spec-kit/blob/main/spec-driven.md |
| SK4 | https://github.github.com/spec-kit/quickstart.html |
| SK5 | https://raw.githubusercontent.com/github/spec-kit/main/templates/tasks-template.md |
| T1 | SEARCH: Tessl spec-driven development framework docs spec registry (search summary only) |
| T2 | https://github.com/tesslio/spec-driven-development-tile |
| T3 | https://tessl.io/blog/tessl-launches-spec-driven-framework-and-registry |
| SP0 | https://github.com/obra/superpowers |
| SPx | https://raw.githubusercontent.com/obra/superpowers/main/skills/<skill>/SKILL.md, with skill = brainstorming (SPB), writing-plans (SPW), subagent-driven-development (SPS), verification-before-completion (SPV), systematic-debugging (SPD), executing-plans (SPE), test-driven-development (SPT), receiving-code-review (SPR), dispatching-parallel-agents (SPP), finishing-a-development-branch (SPF), writing-skills (SPK) |
| AO | https://buildermethods.com/agent-os |
| B1 | https://docs.bmad-method.org/ |
| B2 | https://docs.bmad-method.org/plan/choose-a-planning-path/ |
| B3 | https://docs.bmad-method.org/reference/skills-and-agents/ |
| B4 | https://docs.bmad-method.org/build/review-a-change/ |
| B5 | https://docs.bmad-method.org/customize/run-multi-agent-discussions/ |
| B6 | https://docs.bmad-method.org/build/build-a-change/ |
| B7 | https://docs.bmad-method.org/build/autonomous-development-loops/ |
| B8 | https://github.com/bmad-code-org/BMAD-METHOD |
| B9 | SEARCH: BMAD method docs workflow map analyst PM architect SM dev implementation readiness sprint-planning create-story (search summary only; older BMM vintage) |
| CT | https://code.claude.com/docs/en/agent-teams |
| CS | https://code.claude.com/docs/en/sub-agents |
| CW | https://code.claude.com/docs/en/workflows.md |
| CU | https://code.claude.com/docs/en/ultrareview.md |
| CM | https://code.claude.com/docs/en/cross-session-messaging.md |
| CA | https://code.claude.com/docs/en/agent-view.md |
| CX | https://learn.chatgpt.com/docs/cloud |
| J1 | https://jules.google/docs/ |
| J2 | https://jules.google/docs/changelog/2025-08-083/ |
| J3 | https://jules.google/docs/changelog/ |
| J4 | SEARCH: Jules Google critic agent code review before submit OR parallel tasks (search summary) |
| D1 | https://docs.devin.ai/product-guides/creating-playbooks |
| D2 | https://docs.devin.ai/work-with-devin/advanced-capabilities |
| D3 | https://cognition.com/blog/devin-can-now-manage-devins |
| D4 | SEARCH: Devin docs interactive planning Ask Devin / Devin Wiki / Devin Review (search summary) |
| D5 | SEARCH: Devin docs parallel sessions managed Devins (search summary) |
| OH | https://docs.openhands.dev/usage/prompting/microagents-overview |
| CSQ | https://github.com/smtg-ai/claude-squad |
| CL1 | https://docs.cline.bot/prompting/cline-memory-bank |
| CL2 | https://docs.cline.bot/features/plan-and-act |
| CL3 | https://docs.cline.bot/features/checkpoints |
| CL4 | https://docs.cline.bot/customization/cline-rules |
| CL5 | https://docs.cline.bot/core-workflows/using-commands.md (same content at https://docs.cline.bot/features/slash-commands/new-task) |
| CL6 | https://docs.cline.bot/usage/kanban.md |
| CL7 | https://docs.cline.bot/features/subagents.md |
| CL8 | https://docs.cline.bot/features/auto-approve.md |
| CL9 | https://docs.cline.bot/cli/scheduling.md |
| CL10 | https://docs.cline.bot/customization/skills.md |
| CL11 | https://cline.bot/blog/cline-v3-25 |
| CL12 | SEARCH: docs.cline.bot focus chain todo list (search summary) |
| CL13 | SEARCH: Cline browser_action tool computer use docs (search summary) |
| CL14 | https://docs.cline.bot/core-workflows/working-with-files.md |
| R1 | https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks |
| R2 | https://roocodeinc.github.io/Roo-Code/features/custom-modes |
| R3 | https://roocodeinc.github.io/Roo-Code/basic-usage/using-modes |
| R4 | https://roocodeinc.github.io/Roo-Code/features/codebase-indexing |
| R5 | https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing |
| R6 | https://roocodeinc.github.io/Roo-Code/features/checkpoints |
| R7 | https://roocodeinc.github.io/Roo-Code/features/task-todo-list |
| R8 | https://roocodeinc.github.io/Roo-Code/features/slash-commands |
| R9 | https://roocodeinc.github.io/Roo-Code/features/marketplace |
| R10 | https://roocodeinc.github.io/Roo-Code/features/rooignore |
| A1 | https://aider.chat/docs/repomap.html |
| A2 | https://aider.chat/docs/usage/lint-test.html |
| A3 | https://aider.chat/docs/usage/watch.html |
| A4 | https://aider.chat/docs/usage/modes.html |
| A5 | https://aider.chat/docs/usage/commands.html |
| A6 | https://aider.chat/docs/more/edit-formats.html |
| A7 | https://aider.chat/docs/config/model-aliases.html |
| A8 | https://aider.chat/docs/usage/caching.html |
| A9 | https://aider.chat/docs/git.html |
| A10 | https://aider.chat/docs/usage/copypaste.html |
| G1 | https://goose-docs.ai/docs/guides/recipes/ |
| G2 | https://goose-docs.ai/docs/guides/context-engineering/slash-commands |
| G3 | https://goose-docs.ai/docs/guides/recipes/subrecipes |
| G4 | https://goose-docs.ai/docs/guides/recipes/recipe-reference |
| G5 | https://goose-docs.ai/docs/guides/context-engineering/subagents/ |
| G6 | https://goose-docs.ai/docs/guides/recipes/session-recipes/ |
| G7 | https://goose-docs.ai/docs/getting-started/using-extensions/ |
| G8 | https://goose-docs.ai/docs/guides/context-engineering/custom-agents |
| G9 | https://goose-docs.ai/docs/guides/context-engineering/using-persistent-instructions |
| G10 | https://goose-docs.ai/docs/guides/context-engineering/hooks |
| G11 | https://goose-docs.ai/docs/tutorials/rpi |
| G12 | https://goose-docs.ai/docs/guides/context-engineering/ |
| G13 | SEARCH: goose lead worker model multi-model (search summary) |
| G14 | SEARCH: goose /plan planning mode planner model (search summary) |
| G15 | SEARCH: goose goosehints context engineering memory (search summary) |

## 1. Feature table

Theme codes: ultracode, artifacts, poc-mvp-product, spec-plan-mode, none. Ours codes: have / planned / partial / missing / never.

### 1a. Spec-driven planning and gates

| Capability | Products | What it does | Mechanism | Source | Ours | Theme |
|---|---|---|---|---|---|---|
| F01 Three-phase spec (requirements, design, tasks) as durable files | Kiro | Turns a feature into three reviewable documents before code | Per-spec folder in .kiro/specs holding requirements.md (or bugfix.md), design.md, tasks.md; each phase gated for approval in the normal flow | K1, K2 | missing (task.plan is an in-run checklist only; B4.7 plan profile is a permission mode, not an artifact flow) | spec-plan-mode |
| F02 Requirements-first vs design-first workflows | Kiro | Lets a spec start from behaviour or from a technical design and derive the other | Two variants of the same three-phase flow; design-first accepts architecture/pseudocode and produces feasible requirements; can upload diagrams | K4, K5 | missing | spec-plan-mode |
| F03 EARS-style requirement statements | Kiro | Uniform "when X the system shall Y" requirements that map to tests and tasks | Notation convention in requirements.md; claimed to give clarity, testability, traceability | K4 | missing | spec-plan-mode |
| F04 Analyze Requirements pass | Kiro | Finds inconsistencies, ambiguities, conflicts and gaps before design | Explicit step run before advancing to design | K4, K5 | missing | spec-plan-mode |
| F05 Bugfix spec with regression-preservation clause | Kiro, Spec Kit (bug extension) | Records defect behaviour, expected behaviour and behaviour that must stay unchanged; then root cause and fix | Kiro: bugfix.md with Current/Expected/Unchanged sections, design with root cause and properties, tasks with property-based tests. Spec Kit: bug-assess, bug-fix, bug-test writing .specify/bugs/<slug>/ with verified/partial/failed | K3, SK1 | missing (H-items have no bug flow; systematic-debugging is a skill idea only) | spec-plan-mode |
| F06 Quick spec (no approval gates) | Kiro | Generates all three artifacts in one pass after upfront questions, for well-understood work | Mode chosen at session start or via agent picker; artifacts still saved to .kiro/specs | K2 | missing | poc-mvp-product |
| F07 Spec sync when requirements change | Kiro | Re-maps tasks after requirements or design edits | "Sync Files" action; specs editable directly or via chat | K5 | missing | spec-plan-mode |
| F08 Dependency-wave parallel task execution | Kiro, Spec Kit | Runs independent tasks concurrently in waves; sequences dependent ones | Kiro: dependency graph analysis, waves, "Run all Tasks". Spec Kit: [P] marker on tasks with no conflicts plus parallel groups in tasks.md | K1, K5, SK3 | missing (B6.1 spawn/wait exists as tool but no task-graph scheduler) | ultracode |
| F09 Task completion auto-detection | Kiro | Scans the codebase to mark incomplete tasks that are already done | Codebase scan against tasks.md | K5 | missing | spec-plan-mode |
| F10 Property-based tests as spec validation | Kiro | Generates properties proving the bug exists, is fixed, and unchanged code still works | Tasks phase of a bugfix spec | K3, K5 | missing | spec-plan-mode |
| F11 Spec import and spec-as-context | Kiro | Pulls requirements from Jira/Confluence via MCP; references a spec in chat | MCP connections; "#spec" context provider; specs versioned in the repo, shared by submodule/package | K5 | missing (B6.3 MCP bridge planned; no spec provider) | spec-plan-mode |
| F12 Steering files with inclusion modes | Kiro, Cline, OpenHands, Roo | Persistent project knowledge loaded always, by file pattern, on demand, or by description match | Kiro: .kiro/steering with front-matter inclusion always/fileMatch/manual/auto; foundation files product.md, tech.md, structure.md auto-generated; workspace over global; team distribution. Cline: paths front-matter globs. OpenHands: path-triggered rules and keyword-triggered skills | K7, CL4, OH | partial (H2 AGENTS.md planned, B8 skills planned; no conditional/pattern inclusion) | spec-plan-mode |
| F13 Live file references inside steering | Kiro | Pulls a workspace file into steering so it stays current | Reference syntax pointing at a workspace path | K7 | missing | spec-plan-mode |
| F14 Project constitution | Spec Kit | Project-wide principles written once and checked by every later step | /speckit-constitution artifact; nine articles in the reference example (library-first, CLI mandate, test-first, simplicity, anti-abstraction, integration-first; three project-defined) | SK1, SK3, SK4 | missing | spec-plan-mode |
| F15 Phase -1 gates with complexity tracking | Spec Kit | Blocks over-engineering by checklists in the plan template; failures need a written justification | Simplicity (max 3 projects), anti-abstraction, integration-first gates in plan.md; exceptions recorded in a Complexity Tracking section | SK3 | missing | spec-plan-mode |
| F16 Explicit ambiguity markers and clarify step | Spec Kit, Tessl tile | Forces open questions to be marked rather than guessed; none may remain before implementation | [NEEDS CLARIFICATION] markers in spec/plan; /speckit-clarify integrates answers; Tessl tile asks one question at a time | SK3, SK4, T2 | partial (ask.user exists as a tool; no marker/gate discipline) | spec-plan-mode |
| F17 Quality checklist as gate | Spec Kit | Generates a checklist proving the spec is complete/clear; implement is blocked on unchecked items | /speckit-checklist, then /speckit-implement gates on unchecked items | SK4, SK3 | missing | spec-plan-mode |
| F18 Read-only cross-artifact analysis | Spec Kit | Reports conflicts and gaps across spec, plan and tasks without editing | /speckit-analyze; fixes must be made at the source artifact | SK4 | missing | spec-plan-mode |
| F19 Converge loop | Spec Kit | Compares code to spec/plan/tasks, appends new tasks for gaps, repeats until "Converged" | /speckit-converge alternating with /speckit-implement | SK1, SK4 | missing | spec-plan-mode |
| F20 Auto-numbered feature branch and spec folder | Spec Kit | /speckit.specify scans existing specs, picks next number, creates branch and specs/<branch>/ | Numbering 001.., semantic branch name | SK3 | missing | spec-plan-mode |
| F21 Plan artifact set | Spec Kit | Plan phase writes plan.md, research.md, data-model.md, contracts/, quickstart.md | Template-driven; research gathers library/perf/security context; quickstart holds validation scenarios | SK3 | missing | spec-plan-mode |
| F22 Story-labelled, TDD-ordered task list | Spec Kit | Tasks carry ID, optional [P], story tag (US1..), exact file paths; phases Setup, Foundational, per-story P1..P3, Polish; tests before code | tasks-template.md; per-story checkpoint and independent testability; contracts then tests then source ordering | SK5, SK3 | partial (product ALM has subtasks; native task.plan has no story linkage) | spec-plan-mode |
| F23 Idea assessment extension (go / clarify / kill) | Spec Kit | Pre-spec funnel: intake, research, define, shape, decide with a verdict | .specify/assessments/<slug>/ markdown ending in a decision document | SK1, SK2 | missing | poc-mvp-product |
| F24 Extensions, presets, workflows, bundles | Spec Kit | Customise process by installable packs; 38 agent integrations; project-local template overrides | specify extension add; catalogs incl. private/offline | SK1, SK2 | partial (B8 installer+lockfile planned; D9 forbids in-process plugin code) | none |
| F25 Executable spec files with test links | Tessl | Spec markdown with front matter targets and inline links to tests; spec-first edits | .spec.md; test-link annotation; generate/describe directives; skills requirement-gathering, spec-writer, spec-verification, work-review; rules spec-before-code, one-question-at-a-time | T2, T3, T1 | missing | spec-plan-mode |
| F26 Spec registry of library usage specs | Tessl | 10,000+ pre-built usage specs meant to reduce API hallucination and version mixups | Hosted registry (open beta) | T3, T1 | missing (needs a hosted service; local-first) | none |
| F27 Idea-to-plan brainstorming with hard gate and path classification | superpowers | No implementation until a path's prerequisites are done; classify as spike, bounded or architectural and announce it | Spike: probe plan, approval, cheap investigation, no kept code. Bounded: one-question-at-a-time then short in-chat design and explicit approval. Architectural: 2-3 approaches, design in sections, written spec at docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md, self-review, user review, then writing-plans | SPB | missing (nearest: B4.7 plan profile) | poc-mvp-product |
| F28 Just-in-time visual companion | superpowers | Offers visuals only when they add clarity during brainstorming | Offer step in the architectural path | SPB | missing | artifacts |
| F29 Plan-writing discipline | superpowers | Plans list files, interfaces, exact steps with verification; no placeholders; five-point self-review (spec coverage, step scan, type consistency, review-focus tests, proportion) | docs/superpowers/plans/YYYY-MM-DD-<feature>.md with header (goal, architecture, tech stack, spec path, global constraints, "review focus" failure classes) and checkbox steps | SPW | missing | spec-plan-mode |
| F30 Fresh subagent per task with two-stage review | superpowers | Each task gets an isolated implementer prompt (brief file, report file, interfaces, constraints) then spec-compliance review, then code-quality review | Controller never inherits history to workers; statuses DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED; final whole-branch review on strongest model; ledger of rulings | SPS | partial (B6.1 subagents planned; no review pipeline) | ultracode |
| F31 Bounded fix loop with model escalation | superpowers | Reviewer findings go back to the original implementer for rounds 1-3, a stronger fresh implementer for rounds 4-5, then human-style adjudication | Round counter, resume vs fresh dispatch, breaker at round 5, controller never fixes itself | SPS | missing | ultracode |
| F32 Model-tier routing by task class | superpowers, Claude Code | Cheap model for mechanical tasks, standard for integration, strongest for design and final review; escalate on stuck loops | Guidance table; Claude Code: model resolved per invocation, then definition, then env, then session model | SPS, CS | partial (B6.1 budgeted; H24 model change mid-session; no per-agent routing table) | ultracode |
| F33 Inline plan execution with decision ledger | superpowers | Executes plan in-session with per-step tests, records every ruling/deviation, stops only on irreversible, security, external or broken-plan conditions | Ledger trusted over memory after compaction; final whole-branch review; delete workspace | SPE | partial (journal/audit H8 records actions but no ruling ledger) | spec-plan-mode |
| F34 Test-first iron law | superpowers, Spec Kit | No production code without a failing test; code written first is deleted; rationalisation table | Discipline skill text; Spec Kit Article III makes it a constitution rule | SPT, SK3 | missing (skills B8 planned could carry it) | spec-plan-mode |
| F35 Evidence-before-claims gate | superpowers | Must run the verifying command and read its output before saying work is done | Gate function; forbids "should/probably" language and trusting agent reports unverified | SPV | partial (H18 loop guard, after-edit steps B8 planned; no completion-claim gate) | ultracode |
| F36 Systematic debugging with three-fix limit | superpowers | Four phases root cause, pattern, hypothesis, implementation; after three failed fixes question the architecture | Skill discipline | SPD | missing | none |
| F37 Code-review reception rules | superpowers | Verify feedback against code, push back with reasoning, no performative agreement, clarify before implementing | Skill discipline | SPR | missing | none |
| F38 Parallel-dispatch criteria | superpowers | Use parallel agents only for 3+ independent failure domains with no shared state; prompts scoped, self-contained, with output spec; integrate by conflict check plus full test run | Skill guidance | SPP | missing | ultracode |
| F39 Branch-finish menu | superpowers | Verify tests, detect environment, offer merge/PR/keep (discard only on typed confirmation), clean worktree | Menu differs for detached HEAD | SPF | partial (H15 git write tools planned) | none |
| F40 Skills written test-first; description-only triggering | superpowers | Baseline agent behaviour without the skill, then minimal skill; description must state when to use, never summarise the workflow | Writing-skills discipline | SPK | planned (B8 skills SKILL.md + skill.load) | none |
| F41 Isolated worktree with clean baseline | superpowers | Creates a worktree on a new branch, runs setup, verifies tests are green before work | Worktrees skill | SP0 | missing (edit checkpoint is in-memory only) | ultracode |
| F42 Scale-adaptive delivery paths | BMAD | Vague idea gets the full loop, big clear idea plan-first, small change goes straight to build; trivial work skips the method | Four paths (trivial, one session, epic-sized, project-sized) chosen by an intent-definition gate and a size gate (risk, unclear requirements, reach, coordination) | B1, B2, B8 | missing | poc-mvp-product |
| F43 Planning skill chain | BMAD | Brainstorm, forge-idea, deep-recon, product-brief, prfaq, prd, ux, spec, architecture, ticket | Each writes a named artifact: brainstorm.html, forge-report.html, research-<topic>.md, brief-<slug>.md, prfaq-<slug>.md, prd-<slug>.md, DESIGN.md/EXPERIENCE.md, spec-<slug>.md, architecture-<slug>.md, tickets.toml plus leaf files | B2, B3 | missing | poc-mvp-product |
| F44 Implementation-readiness check | BMAD (older vintage) | Validates PRD-to-architecture alignment, architecture-to-stories traceability, story feasibility before sprint work | Required step between solutioning and implementation | B9 | missing | spec-plan-mode |
| F45 Persona agents with menu codes | BMAD | Analyst, PM, Architect, Developer, UX Designer (Technical Writer on hiatus) each with skill id and codes | Persona skills invoked by name | B3 | partial (B8 agent profiles planned) | none |
| F46 Build workflow with human checkpoints | BMAD | Clarify from evidence, plan (approve), implement, independent review with triage, verify and local commit, present next steps | Plan file records decisions and status; unrelated findings go to deferred-work.md; final confirmation before push | B6 | missing | spec-plan-mode |
| F47 Unattended build loop with status machine | BMAD | One ticket per invocation; plan file status draft, ready-for-dev, in-progress, built, blocked; halts on unclear intent, no subagents, dirty tree or non-convergent review (over 5 loops) | Never picks the next ticket; saves attempted change as a patch when intent breaks | B7 | missing | ultracode |
| F48 Multi-lens parallel code review with triage | BMAD | Several reviewers each apply a lens; triage verifies, assigns severity, dismisses noise, routes to patch / defer / decision-needed | Findings appended to the plan's review section; never changes ticket status | B4 | missing (B8 /review planned as command) | ultracode |
| F49 Party mode multi-persona discussion | BMAD | Personas debate in one conversation; human moderates; four modes session/auto/subagent/agent-team | Writes party-<slug>.html keepsake | B5 | missing | artifacts |
| F50 Advanced elicitation | BMAD | Re-examines output via pre-mortem, inversion and similar methods | Core skill | B3 | missing | spec-plan-mode |
| F51 Course-correct, retrospective, walkthrough, project-context | BMAD | Change proposal mid-sprint; epic retrospective; guided human review; repo instructions for agents | Named skills | B3 | missing | poc-mvp-product |
| F52 Standards discover / inject / shape-spec | Agent OS | Extracts a codebase's patterns into standards, injects relevant ones into context, shapes specs with guided questions in plan mode, product planning | agent-os/ folder of markdown; slash commands in Claude Code; command names not stated on the page | AO | partial (H2 AGENTS.md; no discovery) | spec-plan-mode |
| F53 Deep-planning command | Cline | Silent investigation, questions, writes implementation_plan.md, opens a fresh task seeded with the plan | Four-step command | CL5, CL11 | missing | spec-plan-mode |
| F54 Research, plan, implement recipes | Goose | Research phase spawns three parallel sub-agents (locate, analyse, find patterns) into a research document; plan phase asks questions and writes phased plan with success criteria; implement executes phase by phase with verification; iterate recipe refines | Four recipes rpi-research/plan/implement/iterate | G11 | missing | spec-plan-mode |
| F55 Interactive plan approval before work | Devin, Jules, Kiro | Shows relevant files and an initial plan, user edits/approves before autonomous work | Devin: plan in seconds with findings (search summary). Jules: plan review, Interactive Plan questions, plus a Planning Critic reviewing auto-approved plans | J1, J3, D4 | partial (B4.7 plan profile planned) | spec-plan-mode |
| F56 Plan/Act split with separate models per mode | Cline, Roo, Aider | Read-only exploration mode then acting mode keeping context; stronger model to plan, cheaper to act | Cline: modes with per-mode model. Roo: Architect mode edits markdown only, Orchestrator no tools, sticky model per mode. Aider: architect model proposes, editor model writes edits | CL2, R3, A4 | partial (B4.7 default/plan/accept-edits profiles; H24 model change; no per-mode model) | spec-plan-mode |
| F57 Playbooks / recipes as reusable procedure prompts | Devin, Goose | Reusable task prompt with sections and short macros; versioned | Devin playbook sections Procedure, Specifications, Advice, Forbidden Actions, Required from User; "!macro" attach; version history. Goose recipes: title, instructions/prompt, parameters, extensions, settings, sub_recipes, retry checks, JSON response schema | D1, G4, G1 | partial (B8 custom markdown commands planned; no params/schema/retry) | spec-plan-mode |

### 1b. Multi-agent orchestration ("ultracode")

| Capability | Products | What it does | Mechanism | Source | Ours | Theme |
|---|---|---|---|---|---|---|
| F58 Subagent definition files | Claude Code, Goose, Cline | Named workers with own prompt, tools, model, permissions | Markdown+front matter: tools allowlist, disallowedTools, model, permissionMode, maxTurns, skills, mcpServers, hooks, memory scope, background, isolation, effort; scopes managed > flag > project > user > plugin | CS, G8 | planned (B8 agent profiles) | ultracode |
| F59 Spawn restrictions and depth/concurrency caps | Claude Code, Goose | Bounds fan-out | Allowlist of spawnable agent names; default 20 concurrent, depth 3 (both env-configurable); Goose subagents cannot spawn subagents, 25 turns and 5-minute defaults | CS, G5 | planned (B6.1 depth cap 2, budgeted) | ultracode |
| F60 Resume a finished subagent | Claude Code | Continue a completed worker with its full context by id or name | SendMessage; transcript stored per agent; survives compaction; one-shot built-ins cannot resume | CS | missing | ultracode |
| F61 Foreground vs background subagents | Claude Code | Blocking worker vs concurrent one whose permission prompts surface in the main session | Flag/frontmatter; background gets a filtered tool list | CS | partial (B6.1 spawn/wait) | ultracode |
| F62 Fork (subagent inheriting the conversation) | Claude Code | Copies full conversation into a worker; forks cannot fork | Fork mode | CS | partial (H21 fork/export is session-level) | ultracode |
| F63 Persistent subagent memory | Claude Code | Per-agent memory directory scoped user/project/local; first 200 lines/25 KB loaded | memory front-matter field | CS | planned (B6.6 memory; structured facts, no semantic retrieval v1) | none |
| F64 Read-only research subagents | Claude Code, Cline | Fan out parallel explorers that cannot edit, use browser, MCP or nest, returning a report | Explore/Plan built-ins; Cline subagents limited to read-only commands and file/code search | CS, CL7 | planned (B6.1) | ultracode |
| F65 Per-worker worktree isolation | Claude Code, claude-squad, Cline Kanban, Devin, Jules, Codex cloud | Each parallel worker edits its own copy so edits cannot collide | Claude Code isolation: worktree; claude-squad tmux + git worktree per session; Kanban worktree per card, removed when the card is trashed; Devin/Jules/Codex use separate VMs/cloud environments | CS, CSQ, CL6, D2, J4, CX | missing natively (product session manager binds tmux sessions, not worktrees) | ultracode |
| F66 Agent teams (lead + peers) | Claude Code | Independent sessions coordinated by a lead; peers message each other; experimental, one team per session, no nested teams, no resume of in-process teammates | Team config and per-agent JSON mailbox files; shared task list with pending/in-progress/completed and dependencies; file-lock claims; idle notifications carry final answer; split panes via tmux/iTerm2 | CT | partial (product ALM has claims/leases/dependencies but drives other harnesses; native B6.1 has no peer messaging) | ultracode |
| F67 Teammate quality gates | Claude Code | Reject task creation/completion or keep an idle teammate working | Hooks TeammateIdle, TaskCreated, TaskCompleted with exit code 2 giving feedback | CT | partial (product ALM done_needs_session / blocked_needs_reason are analogues; D9 and "no free shell hooks" forbid this mechanism) | ultracode |
| F68 Plan-approval handshake for teammates | Claude Code | A teammate spawned under a plan-mode lead stays read-only until it sends a plan approval request | Approval is automatic in the lead session per the page | CT | missing | spec-plan-mode |
| F69 Adversarial multi-hypothesis debate | Claude Code | Spawn several investigators who try to disprove each other, to avoid anchoring | Prompt pattern using teams | CT | missing | ultracode |
| F70 Dynamic workflow scripts | Claude Code | A script (not the model turn by turn) holds loops, branching and intermediate results; Claude context only sees the final answer | Plain JS with agent(), pipeline() per item, parallel(), phase(), log(), args global; optional JSON schema per agent with validation retries (default 5); no imports, no filesystem; meta block name/description/phases | CW | missing (largest gap for theme 1) | ultracode |
| F71 Deterministic replay and resume of a run | Claude Code | Relaunch replays agents in start order; completed agents return saved results; first divergent or failed agent and everything after reruns | Date.now, Math.random and bare new Date throw inside scripts; results saved under the session directory; resumable within same session | CW | missing | ultracode |
| F72 Hard runtime caps and cost flags for runs | Claude Code | Bounds a runaway script | 16 concurrent agents default (1-256), 4096 items per fan-out, 1000 agents per run; warning above 25 agents or ~1.5M projected tokens; size guideline small/medium/large/unrestricted advised to the model | CW | partial (B6.1 budgeted subagents; no run-level caps) | ultracode |
| F73 Plan-approval prompt before a run | Claude Code | Shows phase list, option to view raw script, Once/Always/Deny; rule Workflow(<name>) approves a saved one | Behaviour depends on permission mode; skipped in bypass and headless | CW | partial (B4.7 permission profiles, policy layers) | ultracode |
| F74 Run dashboard with pause/stop/restart | Claude Code | Per-phase agent counts, tokens, elapsed; drill into agent prompt/tool calls/result; pause, stop agent, restart agent, save script | /workflows view with key controls | CW | missing (TUI inspector/timeline panels planned but not for runs) | ultracode |
| F75 Save workflow as command; plugin distribution | Claude Code | Turn a good run into /name in project or home workflows folder; ship in plugins with namespace | Save dialog; closest .claude/workflows wins; symlink refusal | CW | partial (B8 commands registry; D9) | ultracode |
| F76 Ultracode effort level and keyword trigger | Claude Code | xhigh reasoning plus automatic workflow planning for every substantive task; or the word in a prompt opts in one task | Keyword only counts in human-typed prompts (not -p, webhooks, scheduled or relayed text); disables size warning and concurrency limit for the session | CW | missing | ultracode |
| F77 Prompt-cache-aware fan-out | Claude Code | Sibling agents share a cached prefix; first agent starts up to 5 s early so the rest read its cache; cache TTL setting | Prefix stagger setting | CW, CT | missing | ultracode |
| F78 Pause on usage limit | Claude Code | Agents wait for the limit reset and resume (max two waits) instead of failing | Interactive subscription sessions only | CW | partial (B9.3 visible rate limits) | ultracode |
| F79 Bundled research workflow with vote and unverified list | Claude Code | Fan-out searches, cross-check sources, vote per claim, cited report; claims that could not be checked are listed unverified, not refuted | /deep-research | CW | missing (B6.7 web.fetch/search planned) | ultracode |
| F80 Adversarial verification of findings | Claude Code | Independent agents challenge each finding before it is reported; drafts a plan from several angles then weighs them | Workflow pattern | CW | missing | ultracode |
| F81 Loop-until-check-passes and loop-until-no-new-findings | Claude Code | Runs a checker, fixes, repeats until pass or two rounds without progress; discovery rounds stop when nothing new | Script control flow | CW | partial (H18 loop guard) | ultracode |
| F82 Per-item isolated migration | Claude Code | Discover files, transform each in an isolated copy, verify each | Fan-out plus isolation | CW | missing | ultracode |
| F83 Cloud multi-agent code review with independent reproduction | Claude Code (ultrareview) | Fleet of reviewers in a cloud sandbox; each finding reproduced before reporting; --json, exit codes, optional PR comment | Cloud session; diff limits 500 files/8000 lines; free runs then paid credits | CU | never as cloud (local-first); local variant partial via B8 /review | ultracode |
| F84 Cross-session messaging | Claude Code | List and message other sessions, ask for one notice when another goes idle | Per-session Unix socket (named pipe on Windows), token, inbound accept/hold/refuse, dedupe/rate limits, permission-mode-aware default, messages never count as user consent | CM | partial (product event channel and sendText to sessions; no native tool) | ultracode |
| F85 Background session manager | Claude Code agent view, claude-squad | Dispatch many sessions, see grouped states, peek, attach, logs, stop, pin, filter, JSON output | claude agents, --bg, attach, logs, stop; claude-squad uses tmux per agent | CA, CSQ | have (product for other harnesses); planned native (B4.6) | ultracode |
| F86 Managed child sessions with budgets | Devin | Coordinator spawns child sessions with prompts, playbooks, tags and compute limits; messages, sleeps, terminates them; reads their trajectories; resolves conflicts | Each child in its own VM | D2, D3, D5 | partial (B6.1 budgeted; B6.5 ALM tools; product claims/leases) | ultracode |
| F87 Orchestrator that cannot act (boomerang) | Roo | Orchestrator mode has no read/write/command tools; delegates via new_task with an explicit message; only a summary returns via attempt_completion | Tool restrictions per mode | R1, R3 | missing | ultracode |
| F88 Subrecipes as tools | Goose | Each subrecipe becomes a tool with parameters, runs in an isolated session, no nesting, optional parallel | sub_recipes registration | G3, G1 | missing | ultracode |
| F89 Model-role split (lead/worker; planner model) | Goose (removed), Aider | Strong model plans, cheap model executes; Goose later replaced lead/worker by a planning mode then removed the CLI planning mode | Search summaries: GOOSE_PLANNER_* settings existed then were removed | G13, G14, A4 | partial (H24) | ultracode |
| F90 Parallel attempts (best-of-N) | Codex cloud, Jules | Run several attempts at the same task, compare, pick one | Codex: parallel environments; Jules: --parallel flag | CX, J3 | missing; cloud variants never | ultracode |
| F91 Delegation from issue trackers/chat | Codex cloud, Jules, Devin | Start work from GitHub/GitLab/Linear/Slack, return a PR | Integrations | CX, J3 | never (local-first) | none |
| F92 Critic before submit | Jules | Critic agent reviews each generated patch and sends it back for fixes before the user sees it | Actor-critic loop | J2, J4 | missing | ultracode |
| F93 Delegate to another harness | claude-squad | Run Claude Code, Codex, Gemini, Aider side by side | tmux+worktree sessions | CSQ | planned (B6.2); have in product | ultracode |
| F94 Board-driven agent dispatch | Cline Kanban | Cards start agents in worktrees; dependency chains auto-start next cards; inline diff-line comments steer agents; Commit or Open PR | Kanban with task linking | CL6 | partial (product ALM board with claims and task_next; no auto-start or worktree binding) | ultracode |
| F95 Scheduled / recurring agent runs | Cline, Goose, Devin, Jules | Cron-style recurring tasks with history and cost | Cline: schedule wizard, persists across restarts, results to messaging; Goose: schedule with cron; Devin/Jules scheduled sessions | CL9, G6, D2, J1 | missing | none |
| F96 Session analysis of past runs | Devin | Examine past sessions for why they succeeded or failed; coordinator reads child trajectories | Trajectory reading | D2, D3 | partial (canonical journal exists; no analysis agent) | ultracode |
| F97 Message-safety rules between agents | Claude Code | Peer messages never grant permission or change config; commands in text are not executed | Enforced on receipt | CT, CM | missing (needed if B6.1/B6.2 add messaging) | ultracode |

### 1c. Artifacts

| Capability | Products | What it does | Mechanism | Source | Ours | Theme |
|---|---|---|---|---|---|---|
| F98 Rendered HTML keepsakes for planning steps | BMAD | Brainstorming, idea-forging and multi-persona sessions write a self-contained HTML document plus optional markdown | brainstorm.html, forge-report.html, party-<slug>.html | B2, B3, B5 | missing (artifact.attach is v2 evidence only) | artifacts |
| F99 Design documents with sequence diagrams | Kiro | design.md includes architecture and sequence diagrams; diagram images can seed design-first | Spec design phase | K1, K5 | missing | artifacts |
| F100 Artifact tool available to agents | Claude Code | The tool list of background subagents includes an Artifact tool | Listed among tools kept for background subagents | CS | missing (product web has an artifacts aside that only shows files/diffs) | artifacts |
| F101 Auto data visualiser | Goose | Built-in extension that generates visualisations automatically | Extension | G7 | missing | artifacts |
| F102 Browser action with screenshots | Cline | Drives a Chromium window, returns a screenshot and console logs after each action | Puppeteer; one action per message; needs a screen-aware model | CL13 | planned (B6.4 browser runtime via delegation) | artifacts |
| F103 Repository wiki and cited Q&A | Devin | Indexes repos for cited answers, wiki and PR review views | Ask Devin, DeepWiki, Devin Review (search summary) | D4 | missing | artifacts |
| F104 Computer-control extension | Goose | Web scraping, file caching, automation | Built-in Computer Controller extension | G7 | missing (B6.4 planned, gated) | none |

### 1d. Idea to POC to MVP to product

| Capability | Products | What it does | Mechanism | Source | Ours | Theme |
|---|---|---|---|---|---|---|
| F105 Feasibility spike path | superpowers | "Can we" questions get a probe plan, approval, cheap investigation, findings; nothing kept | Path 1 of brainstorming | SPB | missing | poc-mvp-product |
| F106 Right-sized process selection | BMAD, Kiro, superpowers | Match ceremony to size: quick spec vs full spec; bounded vs architectural; trivial vs project-sized | See F06, F27, F42 | B2, K2, SPB | missing | poc-mvp-product |
| F107 Project-sized parallel epic streams with shared contracts | BMAD | PRD, UX, architecture as shared contracts coordinating several epic builds, then integration checks | Project path | B2 | missing | poc-mvp-product |
| F108 Ticket tree (initiative, epic, story) | BMAD | tickets.toml plus leaf files; break spec into stories and track | bmad-ticket | B2, B3 | partial (product ALM is exactly a task/subtask board; native harness has no link until B6.5) | poc-mvp-product |
| F109 Learn-and-adjust loop | BMAD, Jules | Retrospective feeds planning; Jules learns preferences and proactively suggests tasks (TODO scan) | bmad-retrospective; Jules Memory and Suggested Tasks | B1, B3, J3 | missing | poc-mvp-product |
| F110 Product planning aligned to mission | Agent OS | Product-level planning step before specs | Stage in the four-stage flow | AO | missing | poc-mvp-product |
| F111 Alternate implementations from one spec | Spec Kit | Generate several implementation approaches for different optimisation targets | Stated principle | SK3 | missing | poc-mvp-product |
| F112 Batch operations across modules | Devin | Launch many sessions for repeated work | Batch dispatch | D2 | partial (product `session batch` for other harnesses) | ultracode |

### 1e. Context, memory, skills, commands

| Capability | Products | What it does | Mechanism | Source | Ours | Theme |
|---|---|---|---|---|---|---|
| F113 Progressive-disclosure skills | Cline, OpenHands, superpowers | Name/description loaded first, full instructions when triggered, resources on demand (~100 tokens per skill for metadata) | SKILL.md with name matching directory; auto-match or slash command; search paths incl. .claude/skills | CL10, OH | planned (B8 skills + skill.load) | none |
| F114 Keyword- and path-triggered skills | OpenHands | Skills fire on trigger words; path rules inject when a matching file is first touched and are not advertised | triggers / paths metadata | OH | missing | none |
| F115 Cross-tool rule ingestion | Cline, Kiro, Jules, Goose | Reads AGENTS.md and other tools' rule files | Detect .cursorrules, .windsurfrules, AGENTS.md | CL4, K7, J1, G15 | planned (H2 AGENTS.md; others missing) | none |
| F116 Rule generator | Roo (/init), Cline (/newrule), Kiro | Scans codebase and writes assistant configuration | /init writes .roo/rules-* ; /newrule writes .clinerules | R8, CL5, K7 | missing | poc-mvp-product |
| F117 Custom modes with tool groups and edit regex | Roo | Modes carry role, whenToUse, tool groups read/edit/command/mcp, file-regex edit limit, per-mode rule folders, YAML export/import, project overrides global | .roomodes / custom_modes.yaml | R2, R3 | partial (B8 agent profiles + permission profiles; no edit regex) | spec-plan-mode |
| F118 Memory bank files | Cline | Six markdown files (project brief, product, active context, patterns, tech, progress) read at session start | Rules-based convention | CL1 | partial (B6.6 memory derived from journal, consent-gated) | none |
| F119 Focus chain / persistent checklist | Cline, Roo | Checklist re-injected every ~6 messages so a long task stays on plan; Roo can block completion with open todos and require todos for delegated tasks | Cline default 6-message reminder; Roo settings newTaskRequireTodos, preventCompletionWithOpenTodos | CL11, CL12, R7 | partial (task.plan in-run checklist; no re-injection or completion gate) | spec-plan-mode |
| F120 Per-turn persistent instructions | Goose | Text or file injected into the model's working context every turn (64 KB cap), editable mid-session | Two env variables | G9 | missing | none |
| F121 Memory extension | Goose, Jules | Tag-based recall of preferences; Jules learns from corrections | MCP memory server; Jules Memory | G15, J3 | planned (B6.6, memory.note v3) | none |
| F122 Task handoff to a fresh context | Cline | /newtask packages plan, progress, files, next steps into a clean task | Command | CL5 | never as model-written summary (CTX 6.5); H21 fork/export is the allowed cousin | none |
| F123 Conversation summarisation and auto-compact | Cline, Roo | /smol; auto compact near limit; Roo condense at threshold with same model, token/cost metrics | Model-written summary | CL5, CL11, R5 | never (CTX 6.5); B4-CTX deterministic eviction is the alternative | none |
| F124 Ranked repository map | Aider | Graph-ranked symbol map fitted to a token budget (default 1000) that grows when no files are open | Dependency graph ranking across files | A1 | missing (B4-CTX index is different) | none |
| F125 Semantic codebase index | Roo | Embedding-based search with tree-sitter chunking and a vector store, respecting ignore files | codebase_search tool | R4 | missing; B6.6 defers semantic retrieval from v1 | none |
| F126 Prompt caching with keepalive pings | Aider, Claude Code | Caches system prompt/map/files; pings to keep the 5-minute cache alive; longer TTL setting for subagents | --cache-prompts, --cache-keepalive-pings | A8, CS | missing | none |
| F127 @-mentions for context | Cline, Kiro, Claude Code | Reference files/folders, specs, agents inline | @ path; #spec; @agent | CL14, K5, CS | partial (H20 /add-dir) | none |
| F128 Custom slash commands as markdown | Roo, Goose, Cline | Files whose name becomes the command; front matter description, argument-hint, mode; Goose maps commands to recipes | .roo/commands; Goose config | R8, G2, CL5 | planned (B8 commands registry) | none |

### 1f. Safety, policy, quality loops, ergonomics

| Capability | Products | What it does | Mechanism | Source | Ours | Theme |
|---|---|---|---|---|---|---|
| F129 Shadow-git checkpoints | Cline, Roo | Snapshot after each action in a private repo; restore files, task only, or both; compare diff | Separate git repo | CL3, R6 | partial (in-memory edit checkpoint; H4 /undo planned) | none |
| F130 Auto-approve categories | Cline | Eight per-tool categories with safe vs all commands decided per command | Approval matrix | CL8 | have (policy allow-once/prefix/deny; B4.7 profiles) | none |
| F131 YOLO mode | Cline | Approves everything | Toggle | CL8 | never (deny floor cannot be lifted) | none |
| F132 Ignore file access control | Roo | .rooignore blocks read/write and known read commands; cannot edit its own rules | Gitignore syntax | R10 | partial (folder trust, deny floor; no ignore file) | none |
| F133 Auto lint/test loop after edits | Aider | Runs linter/tests after each edit and feeds errors back to fix | --auto-lint, --test-cmd/--auto-test | A2 | planned (B8 after-edit steps judged by policy) | none |
| F134 Auto-commit with attribution and undo | Aider | Commits each change with a generated Conventional-Commit message (weaker model), separates dirty work, /undo reverts | Git integration | A9 | planned (H15, H4) | none |
| F135 Comment-triggered edits | Aider | AI/AI!/AI? comments in any editor trigger changes or questions | File watcher | A3 | missing | none |
| F136 Edit formats | Aider | whole, diff, fenced diff, udiff, editor variants chosen per model | Format switch | A6 | partial (file.patch context-located) | none |
| F137 Lifecycle hooks | Kiro, Goose, Claude Code | Events before/after tools, file writes, prompt submit, stop, task execution; command or agent-prompt actions; some can block | Kiro JSON in .kiro/hooks; Goose 11 events, only PreToolUse and Stop can block | K6, G10 | never as free shell hooks (veto=policy, observe=journal/events); H8/H17 cover the observe side | none |
| F138 Marketplace for modes/MCP | Roo | One-click install project or global | Catalog | R9 | partial (B8 installer+lockfile, source undecided; D9) | none |
| F139 Model aliases | Aider | Short names, mid-chat switch | /model alias | A7 | partial (H24) | none |
| F140 Voice input | Aider | /voice records and transcribes | Command | A5 | missing | none |
| F141 Clipboard/web-chat bridge | Aider | Copy context for a web LLM and auto-load the reply | /copy-context, --copy-paste | A10 | missing | none |
| F142 Trust gating of project-defined agents | Claude Code | Project-level agent definitions are re-applied only for trusted folders | Folder trust | CT | planned (folder trust B8) | none |
| F143 Output scanning of subagent text | Claude Code | Informational flags on instruction-like text in subagent output | Scan without removal | CS | missing | none |
| F144 Headless / API / CLI access | Jules, Goose, Claude Code | Programmatic task creation, JSON output | jules remote new; goose run; ultrareview --json | J3, G6, CU | planned (H16 headless --json) | none |
| F145 PR feedback loop | Jules | Reads PR comments and pushes fix commits | GitHub integration | J3 | missing | none |
| F146 Environment snapshots and setup scripts | Jules, Codex cloud | Cached environment setup for repeatable runs | Setup scripts/snapshots | J1, J3, CX | partial (optional Docker sandbox; no snapshots) | none |

## 2. Spec-driven methods, phase by phase

Note: the phrases "who approves" below are limited to what pages say; where a page names only "review" it is reported as unspecified.

### Kiro (K1, K2, K3, K4, K5, K7, K6)
- Phases (feature spec): Requirements, Design, Tasks. Bugfix spec: Bugfix Analysis, Design, Tasks. Two entry variants: Requirements-First (behaviour first, design derived) and Design-First (design first, requirements derived).
- Artifacts: .kiro/specs/<spec>/requirements.md (EARS user stories with acceptance criteria) or bugfix.md (Current, Expected, Unchanged behaviour); design.md (architecture, sequence diagrams, implementation considerations; for bugs root cause, fix strategy, properties); tasks.md (discrete trackable tasks with live status). Steering files (product.md, tech.md, structure.md and user-written) supply persistent context.
- Gates: standard specs have approval gates between the three phases (page names no specific approver; product/engineering stakeholder review is the stated use). Analyze Requirements runs before design. Quick Spec removes the gates and generates all three after upfront clarifying questions.
- Traceability: each requirement is claimed to map directly to test cases and implementation tasks; "Sync Files" refreshes the task mapping when requirements or design change; specs are referenced in chat with a #spec provider.
- Execution and verification: tasks run one at a time, in batch, or "Run all Tasks" in dependency waves with independent tasks concurrent; completion is detected by scanning the codebase; bugfix specs validate with property-based tests (bug present before, fixed after, unchanged code still works). Hooks can fire Pre/Post Task Execution.

### GitHub Spec Kit (SK1, SK2, SK3, SK4, SK5)
- Phases (full path): constitution (once per project), specify, clarify, plan, checklist, tasks, analyze, implement, converge. Short path: specify, plan, tasks, implement, converge.
- Artifacts: constitution document; specs/<NNN-branch>/spec.md (what and why, user stories, acceptance criteria, ambiguity markers); plan.md (technical decisions, Phase -1 gates, complexity tracking); research.md; data-model.md; contracts/; quickstart.md (validation scenarios); tasks.md (IDs T001.., [P], story tag US1.., exact file paths; phases Setup, Foundational, per-story by priority, Polish; per-story checkpoints). Extensions add .specify/bugs/<slug>/ and .specify/assessments/<slug>/ (decision document).
- Gates: no ambiguity markers may remain before implementation; requirement-completeness checklist (testable, measurable); Phase -1 gates (simplicity, anti-abstraction, integration-first) with written exceptions; /speckit-checklist items gate /speckit-implement; /speckit-analyze is read-only and reports conflicts; Article III requires tests written, approved by the user and seen failing before implementation. The approver named is the user for tests; the rest is LLM self-gating.
- Traceability: story labels on every task tie it to a spec user story; contracts and entities in plan drive tasks; analyze reports spec/plan/tasks conflicts; converge re-verifies code against all three and appends tasks for gaps until status "Converged".
- Execution: implement runs tasks in dependency order; file-creation order contracts, then tests (contract, integration, e2e, unit), then source; [P] tasks may run concurrently.

### Tessl (T1, T2, T3; the docs pages returned 404 so this rests on the tile repo, blog and a search summary)
- Phases (tile): requirement gathering (one clarifying question at a time), stakeholder approval, implementation against approved specs, review.
- Artifacts: .spec.md files with front matter (name, description, target file patterns) and inline links from requirements to test files; the framework describes generate/describe directives and a three-part spec (component description, capabilities linked to tests, public API); registry "usage specs" for libraries.
- Gates: rule spec-before-code always applies; stakeholder approval is a phase; spec-verification keeps implementation and tests in sync; work-review validates completed work against approved specs.
- Traceability: capability-to-test links inside the spec; edits flow spec first then code. Approver: "stakeholder", unspecified.

### superpowers (SP0, SPB, SPW, SPS, SPE, SPT, SPV, SPD, SPF)
- Phases: brainstorming (spike / bounded / architectural), isolated worktree, writing plans, implementation (subagent-driven or inline), test-driven development inside tasks, code review, branch completion.
- Artifacts: docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md (architectural path only); docs/superpowers/plans/YYYY-MM-DD-<feature>.md (header with goal, architecture, tech stack, spec path, global constraints, review-focus failure classes; tasks with files, interfaces, checkbox steps); per-task brief file and report file; ledger of rulings; workspace deleted at the end.
- Gates: hard gate blocking any implementation until the path's prerequisites are done; bounded path needs explicit approval of the in-chat design; architectural path needs the user to review the written spec, and writing-plans is the only permitted next step; plan self-review (coverage, step scan, type consistency, review-focus tests, proportion); per task, spec-compliance then code-quality review by a separate agent; fix loop rounds 1-5 with breaker adjudication; final whole-branch review on the strongest model; branch completion decision is the human's (typed confirmation to discard).
- Traceability: self-review points each spec requirement at its task; review-focus tests are pinned to owning tasks; the extracted requirements brief travels with each dispatch.
- Execution and verification: fresh subagent per task with no session history (or inline with per-step tests); red-green-refactor; evidence-before-claims; three-fix limit in debugging.

### BMAD (B1, B2, B3, B4, B6, B7, B8, B9)
- Current docs: delivery loop Clarify, Plan, Build and verify, Learn and adjust; four paths trivial, one session, epic-sized, project-sized. Older vintage (search summary): Analysis (optional), Planning (PRD), Solutioning (architecture, epics and stories, implementation readiness), Implementation (sprint planning, create-story, dev-story, code-review).
- Artifacts: see F43; build writes a plan file (decisions and status: draft, ready-for-dev, in-progress, built, blocked) plus deferred-work.md; review appends findings to the plan; retrospective closes an epic; tickets in tickets.toml plus leaf files.
- Gates: intent-definition gate (complete enough for someone to build without guessing, input under about 40 pages); size gate; plan approval before implementation; triage after review (verify, severity, dismiss, route to patch/defer/decision-needed); final human confirmation before push; older vintage's required steps and implementation-readiness check (PRD-architecture alignment, architecture-story traceability, feasibility); unattended loop halts at blocked or after 5 non-converging review iterations.
- Traceability: stories descend from spec/PRD via tickets; readiness check verifies architecture-to-story traceability (search summary only); the plan file links a build to its ticket.
- Execution: one ticket per build session, dispatched by a human or orchestrator (the auto loop never picks the next ticket); independent reviewers with lenses; verification stage fixes in-scope problems and commits locally.

### Agent OS (AO; thin evidence)
- Stages: discover standards, inject standards, product planning, shape spec. Artifacts are markdown under agent-os/. The page names no gates, no task format and no verification step; commands (plan-product, write-spec, create-tasks, implement) were requested but are not described. Do not design from this source beyond "extract standards, inject them, shape specs with guided questions".

## 3. Orchestration patterns

| Pattern | Who | Cost bounding | Isolation | Merge of results |
|---|---|---|---|---|
| Subagents (delegated workers) | Claude Code (CS), Cline (CL7), Goose (G5) | Concurrency 20 default and depth 3 (Claude Code); maxTurns per agent; Goose 25 turns, 5-minute timeout, no nesting; Cline read-only with own token budget | Own context window; optional worktree (Claude Code); tool allowlists | Result returns to caller; only the top-level summary reaches the main context; resumable |
| Fork | Claude Code (CS) | Counts as a full copy of conversation | Inherits history; forks cannot fork | Same as subagent |
| Agent teams | Claude Code (CT) | Advice 3-5 teammates, 5-6 tasks each; token cost linear; model per teammate | Own context and session; own files by convention (split work by files); permissions inherited from the lead | Lead synthesises; shared task list with dependency unblocking and file-lock claims; idle notice carries final answer; hooks can veto |
| Scripted workflows | Claude Code (CW) | Size guideline; 16 concurrent, 4096 items, 1000 agents caps; large-run warning at 25 agents or 1.5M tokens; run a small slice first; pause on usage limit | Script runs in an isolated runtime with no filesystem; agents can use isolated copies per item | Intermediate results stay in script variables; script filters/reduces; a single agent can rank and dedupe; adversarial verification and votes before reporting |
| Saved/parameterised recipes and subrecipes | Goose (G1, G3, G4), Claude Code saved workflows (CW), Devin playbooks (D1) | Recipe settings max_turns; retry limits | Subrecipe sessions isolated, no nesting | Subrecipe output returns to parent; structured response schema |
| Boomerang orchestration | Roo (R1) | Orchestrator has no tools, so it cannot burn context on files | Each subtask in its own mode/context | Only the completion summary returns to the parent |
| Managed child sessions | Devin (D2, D3, D5) | Compute-unit limits per child; monitor consumption; sleep or terminate | Own VM per child | Coordinator resolves conflicts and compiles; reads child trajectories to improve later splits |
| Parallel attempts / best-of-N | Codex cloud (CX), Jules (J3) | Bounded by cloud plan; not stated otherwise | Separate cloud environments/VMs | Human compares attempts and picks; open PR from the chosen one |
| Playbooks / recipes as procedure | Devin (D1), Goose (G4) | Not a cost device | n/a | Postconditions listed in the playbook's Specifications section |
| Critic / reviewer agents | Jules critic and Planning Critic (J2, J3), BMAD multi-lens review (B4), superpowers two-stage review (SPS), Claude ultrareview (CU) | Jules: inside generation loop; superpowers: 5-round fix loop with breaker; BMAD: 5 iterations before blocked; ultrareview: paid credits | Separate reviewer contexts; ultrareview in cloud sandbox | Triage (verify, severity, dismiss, route) or reproduction before reporting |
| Party / debate | BMAD (B5), Claude teams (CT) | Mode chosen from session (one model voices all) to agent-team; hypothesis debate | Personas independent only when it matters | Human moderates; consensus or HTML keepsake |
| Session fleets for humans | claude-squad (CSQ), Claude agent view (CA), Cline Kanban (CL6), Conductor not fetched | Not bounded by tool; human-driven | tmux + git worktree per session/card | Human reviews diffs, commits or opens PR; done cards trash worktree |
| Cross-session messaging | Claude Code (CM) | Message size cap about 1M chars; burst refusal; loop throttling; 50 queued | Per-session socket, token auth | Plain text to peer; idle notice subscription (12 h expiry) |
| Parallel dispatch by independence | superpowers (SPP) | 3+ independent domains only | Different domains, no shared state | Read summaries, check for edit conflicts, run the full suite, spot-check |

## 4. Top 15 gaps (missing or partial, highest leverage)

1. Spec-driven plan mode as durable, gated artifacts (F01, F14, F27, F29; requirements/design/tasks files, approval gates, constitution) — giant
2. Deterministic workflow-script runtime (agent/pipeline/parallel/phase, schemas, args, replay, caps; F70-F76) — giant
3. Verification layer: independent reproduction, votes, critics, two-stage review with triage (F48, F80, F92, F30) — giant
4. Requirements-to-task traceability plus completion gates (story tags, converge loop, analyze, readiness; F17-F22, F44) — medium
5. Task-graph scheduler running dependency waves, one worktree per unit (F08, F41, F65, F94) — medium
6. Rendered artifact tool for specs, diagrams and reports, written as files the UI can show (F98, F99, F100) — medium
7. Right-sized path router: spike, quick spec, bounded, architectural, epic, project (F06, F27, F42, F105) — medium
8. Read-only research fan-out and structured-output subagents with model routing and caps (F58-F64, F32) — medium
9. Steering/constitution with conditional inclusion and gates (F12, F14, F15, F114) — small
10. Shadow-git checkpoints with restore files/task/both and compare (F129) — medium
11. Agent profiles with per-mode tool groups, edit restrictions and sticky models (F117, F56, F87) — medium
12. Reusable recipes with parameters, retry checks and response schemas (F57, F88) — medium
13. Ranked repository map under a token budget (F124) — medium
14. Scheduled runs and run dashboard (F95, F74) — medium
15. Persistent focus checklist with completion gate on open todos, plus evidence-before-claims gate (F119, F35) — small
