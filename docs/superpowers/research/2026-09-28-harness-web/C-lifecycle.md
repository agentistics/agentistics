# C - Lifecycle (POC -> MVP -> product) and native artifacts: market research

Date: 2026-09-28. Method: vendor docs / help centers / blogs only, ~31 page fetches. Every claim cites the URL it came from. Nothing from Gitlawb/openclaude or leaked Claude Code source was opened. "Ours" is judged against `research-salvage/INVENTORY.md`.

Evidence caveats: WebFetch summarises pages through a small model, so wording is paraphrase of a summary, not a quote. A few claims come from search-result snippets of the named URL (marked "snippet"). Pages that did not say something are listed under "Not confirmed".

## 1. Capability table

Ours legend: have / planned / partial / missing / never (cites constraint). Theme: A = artifacts, L = poc-mvp-product, - = none.

| # | Capability | Products | What | Mechanism | Source URL | Ours | Theme |
|---|---|---|---|---|---|---|---|
| 1 | Prompt -> running app in a live preview | Lovable, v0, Bolt, Replit, AI Studio, Firebase Studio | A sentence produces a working app shown beside the chat | Split editor: chat + live preview; user can click through it. v0 previews run the full app (server code, API routes, DB connections, env vars) inside a Vercel Sandbox VM, replacing older browser-only previews | https://docs.lovable.dev/introduction/getting-started ; https://v0.app/docs/faqs ; https://ai.google.dev/gemini-api/docs/aistudio-build-mode | missing (B6.4 browser runtime is planned but is a verifier, not a preview host) | A/L |
| 2 | Run project's dev server and open it in a pane, agent uses it | Claude Code Desktop | Agent starts dev server, opens it in a Browser pane, tests API endpoints and reads server logs | Server config stored in a per-project launch file; "auto-verify" after every edit is on by default and can be turned off per project | https://code.claude.com/docs/en/desktop | missing (shell.start exists; no preview pane/launch config) | A |
| 3 | Visual self-verification: screenshot, DOM, click, forms | Claude Code (Desktop + Chrome), Cursor, Replit | Agent looks at the rendered UI as an image and fixes discrepancies | Screenshots fed to the file-reading tool so the model sees pixels; console + network logs read selectively to save context; browser state persists per workspace | https://cursor.com/docs/agent/browser ; https://code.claude.com/docs/en/desktop ; https://code.claude.com/docs/en/chrome (snippet) | planned (B6.4 gated Playwright via delegation; B9.2 image input) | A |
| 4 | Agent-driven app testing with a replay report | Replit Agent | Agent drives a real browser through the app, checks UI, features, integrations, accessibility | Runs periodically when it judges enough changed, not every message; produces an interactive video replay; hands control to the human on a login wall, skips after 10 min; only Full-stack JS and Streamlit | https://docs.replit.com/replitai/app-testing | missing (B6.4 planned; no replay artifact; artifact.attach v2 could hold one) | A/L |
| 5 | Plan mode before code | Replit, Lovable, Bolt, Kiro | Agent explores and produces an ordered plan the person reviews before any code changes | Lovable: dedicated plan view (strategy, assumptions, components, steps, optional architecture diagram), editable, version history, approval switches to Build; code changes only after approval. Replit: ordered task list. Bolt: "talk it through before it writes code" | https://docs.lovable.dev/features/plan-mode ; https://docs.replit.com/replitai/agent ; https://support.bolt.new/ | partial (task.plan is the model's in-run checklist; B4.7 plan permission profile planned; no reviewable/versioned plan document) | L |
| 6 | Cheap "chat/discuss" mode distinct from build | Lovable | Discussion with no plan and no code change | Priced as chat work, drawn from a daily allowance first | https://docs.lovable.dev/features/plan-mode | partial (plan profile planned; cost line H6 planned) | L |
| 7 | Whole-state checkpoints and rollback | Replit | Snapshot of files, AI conversation context, environment config, agent memory, DB contents | Auto-created at feature completion, milestones, stable-after-test states, and before error-recovery attempts; rollback restores conversation context too; DB restore is opt-in; roll backward and forward | https://docs.replit.com/replitai/checkpoints-and-rollbacks | partial (in-memory edit checkpoint only; H4 /undo planned; sessions persist so conversation is restorable, DB/env snapshot missing) | L |
| 8 | Version history restore | Lovable, Bolt, ChatGPT canvas | Every change is a restorable version | Lovable: each change saved as a version. Bolt: version history in chat. Canvas: arrows to browse versions, restore, "show changes" diff | https://docs.lovable.dev/introduction/getting-started ; https://support.bolt.new/integrations/git (snippet) ; https://help.openai.com/en/articles/9930697 (snippet) | partial (H4 /undo, H21 fork/export planned) | A/L |
| 9 | Deployment rollback (separate from code rollback) | Replit, Vercel/v0 | Restore a previous successful deployment in one click | Replit re-promotes the existing image and skips the build steps. Vercel checklist names stage / promote / rollback as an operations item | https://blog.replit.com/introducing-deployment-rollbacks (snippet) ; https://vercel.com/docs/production-checklist | missing (no deploy concept in inventory) | L |
| 10 | Publish = snapshot to a URL | Lovable, Replit, Bolt | One action publishes; later edits do not go live until republished | Lovable: live site is a snapshot; "Publish changes" reopens the dialog; no staging environment, straight to production. Replit: snapshot of files and dependencies deployed to Google Cloud. Bolt: built-in hosting (default) or Netlify | https://docs.lovable.dev/features/publish ; https://docs.replit.com/cloud-services/deployments/about-deployments ; https://support.bolt.new/building/deploy | missing; also brushes "local-first, nothing leaves the machine by default" so it must be an explicit opt-in adapter, not a default | L |
| 11 | Deployment target choice by workload | Replit | Autoscale, Static, Reserved VM, Scheduled | Chosen at publish via a decision tree; warns not to persist data on a published app's filesystem | https://docs.replit.com/cloud-services/deployments/about-deployments | missing | L |
| 12 | PR-gated publish, never push to main | v0 | Publish = create or reuse the chat's PR, merge, wait for production deploy | Auto working branch on first code change, auto commit per change, "never pushes directly to main"; without GitHub it deploys to the connected Vercel project | https://v0.app/docs/faqs | missing (H15 git write tools planned; no branch-per-chat policy) | L |
| 13 | Two-way Git sync | Bolt, v0, AI Studio, Lovable | Project mirrors to a GitHub repo, edited elsewhere, synced back | Bolt: backup + branches; v0: two-way; AI Studio: sync or ZIP export | https://support.bolt.new/integrations/git (snippet) ; https://vercel.com/docs/git (snippet via search) ; https://ai.google.dev/gemini-api/docs/aistudio-build-mode | partial (git.* read tools have; H15 write tools planned) | L |
| 14 | Automatic pre-publish security scan | Lovable | Quick scan on every publish: DB access rules / row-level security, dependency audit, MCP exposure; Deep agentic code review on demand | Runs when publish dialog opens (~10 s); critical findings warn, do not block by default; admins can enable "block publishing with critical issues"; dependency audit re-runs when dependency files change; optional auto-fix of eligible critical findings; Wiz / Aikido integrations | https://docs.lovable.dev/features/publish ; https://docs.lovable.dev/features/security | missing (B8 "after-edit steps judged by policy" is the closest hook) | L |
| 15 | Pre-deploy static-analysis scan + "Fix with Agent" | Replit | Semgrep-backed scan before deployment | Findings can be handed back to the agent to fix | https://replit.com/blog/safe-vibe-coding | missing | L |
| 16 | Secrets kept out of prompts and client code | Replit, Lovable, AI Studio | Redirect pasted keys to a secrets tool; keys stay server-side | Replit intercepts keys typed in prompts; Lovable detects API keys and guides storage; AI Studio stores keys server-side only | https://replit.com/blog/safe-vibe-coding ; https://docs.lovable.dev/features/security ; https://ai.google.dev/gemini-api/docs/aistudio-build-mode | partial (deny floor + policy exist; no secrets store or prompt-key interception; origin-bound MCP credentials planned in B8) | L |
| 17 | Dev vs prod database separation | Replit | Two databases so dev work cannot touch live user data | Announced as "coming soon" in the post | https://replit.com/blog/safe-vibe-coding | missing | L |
| 18 | Managed backend on prompt (DB + auth) | Firebase Studio, AI Studio, Lovable, Bolt | Agent wires a database and sign-in without the person doing infra | Firebase Studio: Firestore + Authentication set up automatically; AI Studio: Firestore, Auth, server-side Node runtime; Bolt: built-in database; Lovable: built-in backend (Cloud) | https://firebase.google.com/docs/studio ; https://ai.google.dev/gemini-api/docs/aistudio-build-mode ; https://support.bolt.new/ ; https://docs.lovable.dev/features/publish | never/missing: not a native-harness core concern; would be a template/skill, not a hosted service | L |
| 19 | Deploy-visibility / access control | Lovable, Replit | Public vs workspace-only vs named people for the published app | Lovable Business+: Public / Workspace / Custom; Replit: access controls on Pro/Enterprise | https://docs.lovable.dev/features/publish ; https://docs.replit.com/cloud-services/deployments/about-deployments | missing | L |
| 20 | Custom domain | Lovable, Bolt, Replit | Attach own domain after publish | Paid plans; shows "being set up" until DNS propagates | https://docs.lovable.dev/features/publish ; https://support.bolt.new/building/deploy | missing / low value for a local harness | L |
| 21 | Production checklist as an explicit gate | Vercel | Five-category launch checklist | Operational excellence (incident plan, stage/promote/rollback), security (CSP/headers, deployment protection, WAF, lockfiles committed, rate limiting, access roles, audit logs), reliability (observability, caching), performance (Web Vitals, image/script/font optimisation), cost (spend alerts) | https://vercel.com/docs/production-checklist | missing (the only vendor doc found that is literally a launch checklist) | L |
| 22 | Spec-driven artifacts: requirements / design / tasks | Kiro | Three files per feature (requirements with EARS acceptance criteria, design, tasks) | Requirements-First or Design-First; optional analysis step to find contradictions before design; Quick Spec skips approval gates for well-understood features | https://kiro.dev/docs/specs/feature-specs/ ; https://kiro.dev/docs/specs/ (snippet) | partial (ALM board has tasks/subtasks/blocked/done-needs-session; B8 skills + custom commands can carry the templates; no spec artifact type) | L |
| 23 | Requirements-to-tests traceability (property-based) | Kiro | Properties extracted from EARS requirements, run against generated code | Design -> execution -> feedback; failures route to fix code / adjust test / refine requirement; docs state it is evidence, not proof | https://kiro.dev/docs/specs/correctness/ | missing (artifact.attach "evidence against a task criterion" v2 is the natural slot) | L |
| 24 | Constitution + staged commands + gates | GitHub Spec Kit | constitution -> specify -> clarify -> plan -> tasks -> analyze -> implement | Constitution holds non-negotiable principles (test-first, simplicity); spec gates: no unmarked ambiguity, testable requirements, measurable success criteria; plan gates: simplicity (max 3 projects initially), anti-abstraction, integration-first; analyze checks plan against constitution before coding; tests written and confirmed failing before implementation | https://github.com/github/spec-kit/blob/main/spec-driven.md | partial (AGENTS.md H2 = constitution analogue; custom commands B8; no gate engine) | L |
| 25 | Scale-adaptive method with entry points | BMAD | One loop (clarify, plan, build+verify, learn) entered at different depths by size of work | Vague idea enters at clarify, clear big idea at plan, small change straight to build; thinking skills vs building skills | https://docs.bmad-method.org/ | partial (skills + agent profiles planned) | L |
| 26 | Persistent project steering files | Kiro | product / tech / structure markdown loaded per session | Inclusion modes: always, conditional on file pattern, manual reference, auto by relevance; workspace, global, team scopes; also reads AGENTS.md (always-on) | https://kiro.dev/docs/steering/ | planned (H2 AGENTS.md; skills B8) | L |
| 27 | Render artifacts natively: HTML, SVG, Mermaid, React, docs | Claude artifacts | Side-panel rendering of interactive pages, diagram formats, and template docs/slides/design | Iterate by chat or direct edit; private by default, publish to public link, others can remix | https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them | partial (web "artifacts aside" shows files/diffs a session produced; Studio editor; no native render of HTML/Mermaid from a native session; public link = never per D10 if it means a share link of a session, though a per-artifact local export is fine) | A |
| 28 | Artifact with its own persistence / AI / connectors | Claude artifacts | Artifacts store up to 20 MB between sessions (personal or shared), can call the model, can read connected apps | Usage of embedded AI counts against each viewer's plan, not the creator's | https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them | never for shared/hosted storage (D10, local-first); local-only storage capability is missing | A |
| 29 | Canvas: co-editing document/code with in-place edits | ChatGPT canvas | Separate editing window; sandboxed React/HTML preview; Python execute button with console; version arrows + change diff | Note: help-center snippet says canvas is no longer offered on GPT-5.5 models, writing/code moved into chat blocks | https://help.openai.com/en/articles/9930697 (snippet) | missing (a lesson: the market's editing window is being folded back into chat) | A |
| 30 | Diagram generation in agent chat | Copilot Chat, Lovable plan, Figma MCP | Mermaid fenced blocks render in chat; Lovable plans may include architecture diagrams; Figma MCP reads FigJam diagrams as input | Copilot: emit a fenced mermaid block; known issue: diagram redraws on every streamed token | https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/creating-diagrams ; https://github.com/microsoft/vscode/issues/319248 ; https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server | missing (TUI cannot render; web could) | A |
| 31 | Design-to-code from Figma | Figma MCP, Cursor, Claude Code (Chrome) | Frame link -> node id -> design context (variables, components, layout) -> code; Code Connect maps to the repo's real components | Then open result in a browser and compare with the mock | https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server ; https://cursor.com/docs/agent/browser ; https://code.claude.com/docs/en/chrome (snippet) | planned via B6.3 MCP bridge (no native Figma work needed) | A |
| 32 | Design mode / visual point-and-tweak | Lovable, v0, Cursor | Point at an element and describe or edit it visually | Lovable: "visual pointing" edits; Cursor: agent adjusts UI from screenshots | https://docs.lovable.dev/introduction/getting-started ; https://cursor.com/docs/agent/browser | missing | A |
| 33 | Multi-artifact project sharing one backend | Replit | Web app, mobile app, slides, video in one project | Single project, shared backend | https://docs.replit.com/replitai/agent | missing / not needed | L |
| 34 | Autonomy tiers as a paid/scoped dial | Replit | Free / Power / Max capability tiers, confirmation before paid actions | Not a safety dial, a capability+price dial | https://docs.replit.com/replitai/agent | partial (B4.7 permission profiles are a safety dial, correctly different; H6 cost line) | L |
| 35 | Prototype-to-code-editor handoff | Firebase Studio, v0 | Start prompting, then drop to code editor for custom logic, then production deploy | Firebase Studio: Code OSS workspace; v0: built-in VS Code-style editor. Firebase Studio is sunsetting 2027-03-22, existing workspaces migrate to AI Studio / Antigravity | https://firebase.google.com/docs/studio ; https://v0.app/docs/faqs | have (the native harness IS the code surface; Studio editor exists) | L |
| 36 | Build-mode deploy to a container platform or ZIP export | AI Studio | Deploy to Cloud Run, or export ZIP, or sync to GitHub | Three exits, none forced | https://ai.google.dev/gemini-api/docs/aistudio-build-mode | missing (export = H21 planned) | L |
| 37 | Publish-as-MCP-server | Lovable | Published app exposed as an MCP server; deep scan runs automatically when MCP access is unauthenticated | Security scan escalates by exposure | https://docs.lovable.dev/features/security | missing (novel; note the exposure-triggered scan pattern) | L |

Row count: 37.

Not confirmed by the pages I could fetch (do not treat as evidenced): Bolt's environment/secrets handling and redeploy behaviour (deploy page silent); v0's database integrations, design mode and Figma import (docs overview silent); Kiro hooks (steering page fetch did not mention them); Replit Agent autonomy beyond the three tiers; Claude Code's own Mermaid rendering (Desktop docs mention HTML/PDF/image/video opening in the Browser pane, nothing on Mermaid).

## 2. Lifecycle stages as the market does them

Finding up front: none of the prototype builders fetched has a named POC / MVP / product stage. What they have is a sequence of gates (plan -> build -> verify -> publish) and, at most, environment separation. The staged vocabulary comes from spec methods and Vercel's checklist, not from the builders.

**Replit Agent.** Stages actually present: (a) optional Plan mode, (b) build with autonomous browser testing, (c) checkpoints as an always-on safety net, (d) publish to one of four deployment types, (e) deployment rollback. What changes between them: build state is a whole-context checkpoint (files, conversation, env, memory, DB); publish changes it to a snapshot of files plus dependencies on cloud infrastructure with monitoring, analytics, custom domains and access controls; a pre-deploy Semgrep scan and secrets redirection sit on the path; a separate dev/prod database was announced. Sources: https://docs.replit.com/replitai/agent ; https://docs.replit.com/replitai/checkpoints-and-rollbacks ; https://docs.replit.com/cloud-services/deployments/about-deployments ; https://replit.com/blog/safe-vibe-coding ; https://docs.replit.com/replitai/app-testing.

**Lovable.** Chat mode (discuss, no changes) -> Plan mode (reviewed, editable, versioned plan) -> Build mode (starts only on approval) -> preview -> Publish. Between build and publish the quality bar rises by one thing: an automatic Quick security scan (RLS, dependencies, MCP exposure), optionally a Deep agentic review. There is no staging environment; publish goes straight to production, and the live site is a snapshot. Access control and custom domains are plan-tier features. Sources: https://docs.lovable.dev/features/plan-mode ; https://docs.lovable.dev/features/publish ; https://docs.lovable.dev/features/security.

**v0 (Vercel).** Prompt -> production-equivalent preview (full server code and env vars) -> Git (auto branch, auto commits) -> Publish, which is a PR merged into the base branch with a production deploy behind it. The infrastructure change between prototype and product is that Vercel's environment model, env vars and the production checklist apply once it is a Vercel project. Sources: https://v0.app/docs/faqs ; https://vercel.com/docs/production-checklist.

**Bolt.** Plan mode -> build -> version history -> publish to Bolt hosting or Netlify, with GitHub as backup. Documented limit worth noting: Netlify cannot host a database or a traditional backend, so promotion to a backend needs a different host. Sources: https://support.bolt.new/ ; https://support.bolt.new/building/deploy ; https://support.bolt.new/integrations/git (snippet).

**Firebase Studio / AI Studio Build.** Firebase Studio: prototyping agent -> browser preview -> automatic Firestore/Auth -> code editor for custom logic -> publish to App Hosting with observability. AI Studio: prompt -> preview + Code tab -> Firestore/Auth/server-side keys -> Cloud Run, ZIP, or GitHub. Neither names a prototype/production stage, but both put the exit (deploy target) as a separate explicit act. Sources: https://firebase.google.com/docs/studio ; https://ai.google.dev/gemini-api/docs/aistudio-build-mode.

**Claude artifacts / ChatGPT canvas.** These are the pre-POC layer: a rendered page or document that is private, iterable, versioned, then optionally published (artifacts) or shared. No promotion path to a repository or a deployment is documented on those pages. Artifacts add storage, embedded model calls and connectors, which is the first step toward an app. Sources: https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them ; https://help.openai.com/en/articles/9930697 (snippet).

**Kiro.** Not a builder but the clearest staged method: requirements (EARS acceptance criteria) -> design -> tasks, with approval gates and an optional analysis pass, or Quick Spec without gates for well-understood work; optional property-based correctness checking ties requirements to tests; steering files carry standing product/tech/structure knowledge. Sources: https://kiro.dev/docs/specs/feature-specs/ ; https://kiro.dev/docs/specs/correctness/ ; https://kiro.dev/docs/steering/.

**GitHub Spec Kit.** Seven stages with named gates (constitution, specify, clarify, plan, tasks, analyze, implement). The gates that change the quality bar per stage: no unresolved ambiguity and testable, measurable requirements at spec; simplicity, anti-abstraction, integration-first at plan; constitution-compliance check before code; test-first at implement. Source: https://github.com/github/spec-kit/blob/main/spec-driven.md.

**BMAD.** One loop entered at different depths by work size; the docs page I could fetch did not give gate criteria. Source: https://docs.bmad-method.org/.

**Vercel production checklist.** The only launch checklist found: operations, security, reliability, performance, cost. Source: https://vercel.com/docs/production-checklist.

## 3. What a POC -> MVP -> product toolchain needs

Tags: [E] evidenced by a cited product; [I] my inference, not stated by any source.

### Stage 1: POC from an idea
Entry
- One-sentence idea, optionally a screenshot/mock. [E] (Replit, Firebase Studio multimodal prompt; Cursor design from screenshot)
- Optional plan review before any file is written. [E] (Lovable, Replit, Bolt)
Work
- Runs locally and is seen, not just written: preview pane or browser verification. [E] (Lovable, v0, Claude Code Desktop)
- Every step reversible: per-change version or checkpoint. [E] (Lovable, Replit, Bolt)
Artifacts
- The running prototype; a plan document; a screenshot or replay as proof it runs. [E] plan doc (Lovable), replay (Replit); screenshot as evidence artifact [I]
Exit criteria
- It starts, the golden path works in a real browser without console errors. [E] partially (Replit tests UI/functionality; Claude Code auto-verify checks for errors); "golden path" wording [I]
- The person says "keep going" - a human decision, not an automatic promotion. [I]
Deliberately absent at this stage: auth, real DB, deploy, tests. [I] (builders add backends on request, not by default, except Firebase/AI Studio which wire Firestore/Auth when the app needs them)

### Stage 2: MVP
Entry
- POC accepted. Requirements written down as testable statements (what the MVP must do). [E] Kiro EARS requirements; Spec Kit "testable, measurable"; the act of moving POC to requirements [I]
- Repository under version control on a branch, not on main. [E] v0 branch-per-chat, never pushes to main
Work
- Real persistence and sign-in, secrets out of source and prompts. [E] Firebase Studio/AI Studio/Replit/Lovable secrets handling
- Dev and prod data separated. [E] announced by Replit only (not shipped when written)
- Agent-run tests exist and run; failures route back into the loop. [E] Replit testing; Kiro correctness loop; Spec Kit test-first
- A first deploy behind access control, with deployment rollback available. [E] Lovable visibility, Replit rollbacks
Artifacts
- requirements + design + tasks files. [E] Kiro, Spec Kit
- Standing project rules file (stack, structure, conventions). [E] Kiro steering, Spec Kit constitution
- A security-scan result attached to the release candidate. [E] Lovable, Replit
Exit criteria
- Security scan has no critical findings (warn or block by policy). [E] Lovable (warn by default; block is an admin option)
- Requirements each have at least one passing check. [I] built from Kiro traceability + Spec Kit analyze
- A rollback has been proven possible (previous deployment restorable). [E] Replit, Vercel

### Stage 3: structured product
Entry
- MVP in use; a launch decision. [I]
Work (all from the Vercel checklist unless marked)
- Incident/escalation plan and stage-promote-rollback practice. [E]
- Security headers/CSP, deployment protection, rate limiting, access roles, audit logs, lockfiles committed. [E]
- Observability and log persistence; caching; performance budgets (Web Vitals); spend alerts. [E]
- Constitution-style gates on architecture (simplicity, anti-abstraction, integration-first) and an analyze pass before large changes. [E] Spec Kit
- Environment tiers with promotion (preview -> production). [E] Vercel via v0
- Custom domain, org-level controls over who can publish or download source. [E] Replit enterprise controls; Lovable workspace visibility
Artifacts
- A launch checklist with per-item state; a spec set kept current; scan history; deployment history. [E] checklist (Vercel), spec set (Kiro/Spec Kit); "per-item state kept as a record" [I]
Exit criteria
- Checklist items resolved or explicitly waived with a reason. [I] (Vercel lists them; none of the sources define waiving)

### Cross-cutting
- A readiness gate is advisory first, blocking only by admin choice. [E] Lovable, "does not block by default". This matches Agentistics' existing "warn, never block" rule for WIP limits.
- The market does not automate promotion between POC/MVP/product; the human moves it. [I, from absence of any named stage in the builder docs]

## 4. Top 10 gaps (against INVENTORY.md)

Sizes: small = days, medium = 1-3 weeks, giant = a subsystem.

1. **Native preview/verify loop for web output** (dev-server launch config, browser pane or headless screenshot, auto-verify after edit, console + network read). Rows 1-3. Depends on B6.4 (planned) and B9.2 image input. Size: **giant** (spans runtime tool, policy, TUI/web surface).
2. **Whole-state checkpoints beyond edits**: named, auto-created at milestones and before recovery attempts, restoring files + conversation, DB optional. Row 7. Builds on the in-memory checkpoint, sessions, H4. Size: **medium**.
3. **Reviewable plan document**: a versioned artifact between plan mode and build, approval switches the profile. Rows 5-6. B4.7 plan profile + task.plan are the seed. Size: **medium**.
4. **Spec artifacts + gates as a first-class flow** (requirements with acceptance criteria, design, tasks; ambiguity and constitution checks). Rows 22, 24-26. Fits B8 commands/skills + AGENTS.md + the ALM board. Size: **medium** (templates + gate checks), **giant** if it includes property-based tests.
5. **Stage model and readiness checklist** (POC/MVP/product as recorded state on a project or task, with entry/exit items and waivers). Rows 21 and section 3. Nobody ships this; ALM board is a natural home. Size: **medium**.
6. **Pre-publish security/dependency scan as an after-edit or release step** (B8 after-edit steps judged by policy). Rows 14-15. Size: **small** to wire, **medium** if built in-house rather than delegating to a scanner.
7. **Native artifact rendering**: HTML page preview, Mermaid/SVG, docs, in the web Sessions workspace's artifacts aside, with `artifact.attach` as the model-facing tool. Rows 27, 30. Web side is have-adjacent; TUI can only link out. Constraint: no public share link (D10) - export a file instead. Size: **medium**.
8. **Evidence artifacts for verification** (screenshot, test replay, scan report attached to a task criterion). Rows 4, 23, and `artifact.attach` v2. Size: **medium**.
9. **Deployment as an explicit, opt-in adapter** with rollback (static export, container, one hosting target) and PR-gated publish, never pushing to the default branch. Rows 9-13. Must respect "nothing leaves the machine by default". Size: **giant** if hosted; **small** if it stops at "produce a deployable bundle + branch + PR" via H15.
10. **Secrets handling**: intercept keys typed into prompts, keep them out of files and journal, per-environment values, dev/prod split. Rows 16-17. Policy and journal redaction exist as seeds. Size: **medium**.

Not in the top 10 on purpose: managed backend/auth provisioning, custom domains, visibility tiers, autonomy pricing tiers, canvas-style co-editing window (row 29 suggests the market is retreating from it).
