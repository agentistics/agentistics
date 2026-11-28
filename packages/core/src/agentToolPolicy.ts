/**
 * The agent tool POLICY TABLE — what every MCP tool may do, in one Record.
 *
 * Spec: docs/superpowers/specs/2026-09-29-mcp-coverage-design.md §3 (risk classes), §3.14 (never
 * through the MCP) and §4.1 (one table, and the build enforces it). This is P1.1: the table and its
 * lint. NOTHING READS IT AT RUNTIME YET — the gate that enforces a class is P2, so a tool classed
 * `D` here still executes directly today (see `D_DIRECT_UNTIL_P2`).
 *
 * The shape is the `HARNESS_CAPABILITIES` pattern: a `Record` over a closed name list, so a name
 * added to `AGENT_TOOL_NAMES` does not compile until it is classified. The MCP package does not
 * import this module (it is published standalone and this phase changes nothing at runtime), so the
 * other direction — a tool added to the MCP's `TOOLS` array and never listed here — is caught by
 * `packages/mcp/agentToolPolicy.lint.test.ts`, which also checks that every row's `routes` are
 * EXACTLY the routes its handler calls, and that no handler anywhere calls a `NEVER_ROUTES` entry.
 *
 * A class is decided by the WORST thing the call can do (§3):
 *  - `R` read — runs freely;
 *  - `W` reversible write — runs freely and is audited; the owner can undo it with one more call;
 *  - `D` destroys work, spends money, sends data off the machine or widens what an agent may do —
 *    the MCP may only file an intent for it (from P2 on);
 *  - `N` never through the MCP — not a row here at all, but a route in `NEVER_ROUTES`.
 */

export type AgentToolRisk = 'R' | 'W' | 'D'

/**
 * The host-power switches a route can be gated by. The same names as `Capabilities` in
 * `packages/server/server/exposure.ts`, restated because core cannot import the server; the lint
 * cross-checks every row against the server's own `routeCapability`, so the two cannot drift.
 */
export type AgentCapability = 'localShell' | 'localChat' | 'localTranscripts' | 'localProcesses' | 'mcpAdmin'

export interface AgentToolPolicy {
  risk: AgentToolRisk
  /** One line: why this class, and not a milder one. */
  reason: string
  /**
   * `METHOD /path` for every route the handler calls, `:param` for a path segment. Empty for a tool
   * that answers without the server. A list rather than one route because some existing tools
   * multiplex actions (`session_group_edit`) or read-modify-write (`add_component`).
   */
  routes: readonly string[]
  /** The capability `capability-guard.ts` requires for those routes; absent when none does. */
  capability?: AgentCapability
  /** True when a route is registered in `capability-guard.ts`, i.e. it touches the machine itself. */
  host: boolean
  /** The standing allowance (§4.4) that may cover it. Every existing tool: `null`. */
  allowance: 'prompt' | 'spawn' | null
}

/** Every tool the MCP exposes today — 38 on `origin/dev` (the spec's §1 said 44; P0.3 re-counted). */
export const AGENT_TOOL_NAMES = [
  // ALM (19)
  'agentistics_tasks',
  'agentistics_task',
  'agentistics_task_create',
  'agentistics_task_status',
  'agentistics_task_statuses',
  'agentistics_task_status_edit',
  'agentistics_task_types',
  'agentistics_task_type_edit',
  'agentistics_task_comment',
  'agentistics_task_subtask',
  'agentistics_task_link',
  'agentistics_task_blocked_by',
  'agentistics_task_next',
  'agentistics_task_claim',
  'agentistics_task_activity',
  'agentistics_live_delivery',
  'agentistics_delivery_calendar',
  'agentistics_task_edit',
  'agentistics_task_session',
  'agentistics_task_delete',
  // FLUXO.ENTREGA-DSL (2)
  'agentistics_task_phase',
  'agentistics_task_stage',
  // ENTREGA.GARANTIDA S1c
  'agentistics_task_evidence',
  // FILA.PRIORIDADE (2)
  'agentistics_task_queue',
  'agentistics_task_queue_answer',
  // Session groups (3)
  'agentistics_session_groups',
  'agentistics_session_group_create',
  'agentistics_session_group_edit',
  // Session notifications (1)
  'agentistics_session_notify',
  'agentistics_session_message',
  'agentistics_wait',
  'agentistics_checkin_report',
  'agentistics_session_role',
  'agentistics_session_leads',
  'agentistics_session_away',
  // DOCKER.AMBIENTES S1 (3)
  'agentistics_env_status',
  'agentistics_env_use',
  'agentistics_env_install_hint',
  'agentistics_session_hold',
  'agentistics_nay_call',
  'agentistics_session_switch_account',
  // Metrics (6)
  'agentistics_summary',
  'agentistics_harnesses',
  'agentistics_plan_limits',
  'agentistics_projects',
  'agentistics_sessions',
  'agentistics_costs',
  'agentistics_repos',
  'agentistics_benchmark_observed',
  // Layouts (8)
  'agentistics_component_catalog',
  'agentistics_get_layouts',
  'agentistics_get_preferences',
  'agentistics_set_preferences',
  'agentistics_create_layout',
  'agentistics_add_component',
  'agentistics_remove_component',
  'agentistics_set_active_layout',
  'agentistics_delete_layout',
  'agentistics_build_layout',
  // PDF export URL (1)
  'agentistics_export_pdf',
  // Tags (2)
  'agentistics_tags',
  'agentistics_tag_detail',
  // Experimental flows (2)
  'agentistics_flow_run',
  'agentistics_flow_status',
  // Hand-off book (1)
  'agentistics_book_takeover',
  // Disk cleanup (2) — DISCO.WORKTREES
  'agentistics_clean',
  'agentistics_clean_apply',
  // Vault (1) — COFRE.DESBLOQUEIO
  'agentistics_vault_status',
  // Browser — NAVEGADOR S1 (status) + S2 (the session's own browser; the lock is S3)
  'agentistics_browser_status',
  'agentistics_browser_navigate',
  'agentistics_browser_back',
  'agentistics_browser_forward',
  'agentistics_browser_reload',
  'agentistics_browser_snapshot',
  'agentistics_browser_click',
  'agentistics_browser_type',
  'agentistics_browser_press',
  'agentistics_browser_select',
  'agentistics_browser_scroll',
  'agentistics_browser_screenshot',
  'agentistics_browser_wait_for',
  'agentistics_browser_evaluate',
  'agentistics_browser_tabs',
  'agentistics_browser_tab_new',
  'agentistics_browser_tab_select',
  'agentistics_browser_tab_close',
  'agentistics_browser_close',
  // NAVEGADOR S3 — the padlock
  'agentistics_browser_wait_unlock',
  'agentistics_browser_lock',
] as const

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

const TASKS = { capability: 'localShell', host: true, allowance: null } as const
const GROUPS = TASKS
const DATA = { host: false, allowance: null } as const
const PREFS = DATA

export const AGENT_TOOL_POLICY: Record<AgentToolName, AgentToolPolicy> = {
  // ------------------------------------------------------------------ ALM
  agentistics_tasks: { ...TASKS, risk: 'R', routes: ['GET /api/tasks'], reason: 'lists the board; changes nothing' },
  agentistics_task: { ...TASKS, risk: 'R', routes: ['GET /api/tasks/:ref'], reason: 'reads one task (its comments are untrusted text, §4.8)' },
  agentistics_task_create: { ...TASKS, risk: 'W', routes: ['POST /api/tasks'], reason: 'adds a card; undone by closing or deleting it' },
  agentistics_task_status: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref'], reason: 'moves a card between statuses; moved back by the same call' },
  agentistics_task_statuses: { ...TASKS, risk: 'R', routes: ['GET /api/tasks/statuses'], reason: 'reads the status vocabulary' },
  agentistics_task_status_edit: {
    ...TASKS, risk: 'W',
    routes: ['DELETE /api/tasks/statuses/:id', 'POST /api/tasks/statuses/:id', 'POST /api/tasks/statuses'],
    reason: 'status vocabulary is configuration; the server refuses to remove a protected status (§3.5)',
  },
  agentistics_task_types: { ...TASKS, risk: 'R', routes: ['GET /api/tasks/types'], reason: 'reads the type vocabulary' },
  agentistics_task_type_edit: {
    ...TASKS, risk: 'W',
    routes: ['DELETE /api/tasks/types/:id', 'POST /api/tasks/types/:id', 'POST /api/tasks/types'],
    reason: 'type vocabulary is configuration; the server refuses to remove a type still in use',
  },
  agentistics_task_comment: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref/comments'], reason: 'appends a note; additive, destroys nothing' },
  agentistics_task_subtask: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref/subtasks'], reason: 'adds or edits a subtask; reversible by another edit' },
  agentistics_task_link: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref/links'], reason: 'adds or removes a link; reversible by the inverse call' },
  agentistics_task_blocked_by: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref'], reason: 'sets a blocker; cleared by the same call' },
  agentistics_task_next: { ...TASKS, risk: 'R', routes: ['GET /api/tasks/next'], reason: 'asks what is ready; claims nothing' },
  agentistics_task_claim: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref/claim'], reason: 'a lease that expires on its own and can be released' },
  agentistics_task_activity: { ...TASKS, risk: 'R', routes: ['GET /api/tasks/activity'], reason: 'reads the board activity log' },
  agentistics_live_delivery: { ...TASKS, risk: 'R', routes: ['GET /api/tasks/live'], reason: 'reads the live delivery line and the leaders band; changes nothing' },
  agentistics_delivery_calendar: { ...TASKS, risk: 'R', routes: ['GET /api/deliveries/calendar'], reason: 'reads the delivery calendar (dates, versions, ETAs); changes nothing' },
  agentistics_task_edit: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref'], reason: 'edits task fields; reversible by another edit' },
  agentistics_task_session: {
    ...TASKS, risk: 'W', routes: ['POST /api/tasks/x/sessions', 'POST /api/tasks/:ref/sessions'],
    reason: 'files or detaches a session under a task; filing is reversible',
  },
  agentistics_task_delete: {
    ...TASKS, risk: 'D', routes: ['DELETE /api/tasks/:ref'],
    reason: 'destroys a task with its history; re-classed D by the spec (§3.5), moves behind an intent in P2.6',
  },
  // ------------------------------------------------------------------ Disk cleanup (DISCO.WORKTREES)
  agentistics_clean: {
    ...TASKS, risk: 'R', routes: ['GET /api/clean/plan', 'GET /api/clean/disk', 'GET /api/clean/job'],
    reason: 'reads what the safe cleanup would free, the free disk space against its floor, and a running cleanup; removes nothing',
  },
  agentistics_clean_apply: {
    ...TASKS, risk: 'W', routes: ['POST /api/clean/apply'],
    reason: 'removes only what no work depends on, each re-checked first: merged or published-and-patched worktrees (branches stay), reinstallable node_modules, records of missing folders; dirty or in-use trees are refused, and the plan it takes ids from is the same one the person confirms in the dialog',
  },
  agentistics_book_takeover: {
    ...TASKS, risk: 'W', routes: ['POST /api/book/takeover'],
    reason: 'confirms the calling successor session against its durable hand-off bookmark; the server attaches and verifies the session proof',
  },
  // ------------------------------------------------------------------ Session groups
  agentistics_session_groups: { ...GROUPS, risk: 'R', routes: ['GET /api/session-groups'], reason: 'lists the session folders' },
  agentistics_session_group_create: { ...GROUPS, risk: 'W', routes: ['POST /api/session-groups'], reason: 'creates a folder; removed by delete' },
  agentistics_session_group_edit: {
    ...GROUPS, risk: 'W',
    routes: [
      'POST /api/session-groups/:group/sessions',
      'POST /api/session-groups/ungroup',
      'POST /api/session-groups/:group',
      'DELETE /api/session-groups/:group',
    ],
    reason: 'folders are labels: deleting one ungroups its sessions and touches no session (§5 defect 3: W, not D)',
  },
  // ------------------------------------------------------------------ Session notifications
  agentistics_session_notify: {
    ...GROUPS, risk: 'W', routes: ['POST /api/session-notify'],
    reason: 'a per-session on/off switch for delivery; reversible, and the session state is untouched',
  },
  agentistics_session_message: {
    ...GROUPS, risk: 'W', routes: ['POST /api/session-message'],
    reason: 'types a message into another session through the composer path; additive, rate-limited, sender verified',
  },
  agentistics_task_phase: {
    ...TASKS, risk: 'W', routes: ['GET /api/deliveries', 'GET /api/deliveries/:subtask', 'POST /api/deliveries/:subtask', 'POST /api/deliveries/release', 'POST /api/deliveries/reconcile', 'POST /api/deliveries/antigas'],
    reason: 'reads or moves a delivery through the fixed phase table; release declares which pieces a release shipped (leader/owner only; the host still reads the green run and the tag); reconcile backfills merged/released pieces (dry run unless apply, leader/owner only); a skipped phase is refused (422 fase_pulada) and every gate is checked by the host from evidence, never from the caller',
  },
  agentistics_task_stage: {
    ...TASKS, risk: 'W', routes: ['POST /api/deliveries/:subtask'],
    reason: 'writes the pre-dispatch (staged session draft) on a subtask and opens its delivery in the queue; nothing starts until stage-run passes the predispatch and vaga gates',
  },
  agentistics_task_evidence: {
    ...TASKS, risk: 'W', routes: ['GET /api/tasks/:task/evidence', 'POST /api/tasks/:task/evidence', 'DELETE /api/tasks/:task/evidence'],
    reason: 'attaches, lists or removes the evidence a piece needs before review; the server validates the bytes, computes the hash and binds it to the verified HEAD (the caller supplies neither); only the piece\'s own session, the task leader or the owner may attach, and evidence a checkpoint relies on cannot be removed',
  },
  agentistics_task_queue: {
    ...TASKS, risk: 'R', routes: ['GET /api/deliveries/queue/:task'],
    reason: 'reads the delivery queue in leaving order with every fact the Fila tab shows (priority, pre-dispatch, slot verdict, hold, open question, notes); read only',
  },
  agentistics_task_queue_answer: {
    ...TASKS, risk: 'W', routes: ['POST /api/deliveries/:subtask', 'POST /api/deliveries/queue-next'],
    reason: 'answers the queue question (sim opens the session through the same claim-guarded stage run; nao/agendar keep the piece queued with a recorded reason); leader of the task or owner only, every decision is a comment on the subtask',
  },
  agentistics_wait: {
    ...GROUPS, risk: 'W', routes: ['POST /api/flows/wait'],
    reason: 'registers, acknowledges or cancels the calling session\'s OWN durable wait (closed condition set); the wake goes through the composer path; sender verified',
  },
  agentistics_checkin_report: {
    ...GROUPS, risk: 'W', routes: ['POST /api/checkin/report'],
    reason: 'records the calling leader\'s own check-in round; additive, sender verified',
  },
  agentistics_session_role: {
    ...GROUPS, risk: 'W', routes: ['POST /api/session-roles'],
    reason: 'sets a session label (role + title prefix) and types a one-line note; reversible by setting auto; a session may only touch itself or the sessions it started',
  },
  agentistics_session_leads: {
    ...GROUPS, risk: 'W', routes: ['POST /api/session-leads'],
    reason: 'declares which tasks a leader leads besides its own filing (the Live link, never cost); reversible with remove; a session may only change its own, and only a leader, within its own repository',
  },
  agentistics_session_hold: {
    ...GROUPS, risk: 'R', routes: ['GET /api/fleet/holds'],
    reason: 'reads whether something live the engine runs is using a session (yes/no, since when, in the engine own words); changes nothing',
  },
  agentistics_nay_call: {
    ...GROUPS, risk: 'W', routes: ['GET /api/nay-call', 'POST /api/nay-call/start'],
    reason: 'reads the Call Nay button\'s state and asks the owner\'s open dashboard to place the call; refused without an open dashboard or a call surface, and only a verified LEADER session may start one',
  },
  agentistics_env_status: {
    ...GROUPS, risk: 'R', routes: ['GET /api/env/status'],
    reason: 'reads whether Docker is installed/running, which backend a worker\'s environment would use and why; nothing is started or changed',
  },
  agentistics_env_install_hint: {
    ...GROUPS, risk: 'R', routes: ['GET /api/env/install-hint'],
    reason: 'returns the per-system steps, cost and official page for installing Docker; it installs nothing and runs nothing',
  },
  agentistics_env_use: {
    ...GROUPS, risk: 'W', routes: ['POST /api/env/use'],
    reason: 'records which backend (Docker or the isolated namespace) runs a scope\'s environments, for one session, one project or all; reversible with one more call; the server accepts it only from the person or a verified LEADER session',
  },
  agentistics_session_away: {
    ...GROUPS, risk: 'W', routes: ['GET /api/away', 'PUT /api/away', 'PUT /api/away/session', 'POST /api/away/notice'],
    reason: 'reads or switches autonomous mode (what newly started sessions are told about the owner being out) and lets a leader raise a notice in the owner\'s bell; reversible by switching it off; the server accepts writes only from a verified LEADER session',
  },
  agentistics_session_switch_account: {
    ...GROUPS, risk: 'W', routes: ['GET /api/fleet/switch-account', 'POST /api/fleet/switch-account'],
    reason: 'continues a session on another account of the same harness: the conversation is copied (never moved) and resumed under the same id; an agent may only target accounts that are on for agents',
  },
  // ------------------------------------------------------------------ Metrics
  agentistics_summary: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed metrics' },
  agentistics_harnesses: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics', 'GET /api/plan-limits'], reason: 'reads computed metrics per harness and whether each can be spawned' },
  agentistics_plan_limits: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/plan-limits'], reason: 'reads subscription windows and routing guidance; does not start work' },
  agentistics_projects: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed metrics per project' },
  agentistics_sessions: { ...DATA, capability: 'localShell', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/fleet', 'GET /api/flows/delivered-open'], reason: 'reads session metadata (first_prompt is untrusted text, §4.8)' },
  agentistics_costs: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed costs' },
  agentistics_benchmark_observed: { ...DATA, capability: 'localShell', host: true, risk: 'R', routes: ['GET /api/benchmark/observed'], reason: 'reads the observed delivery history (cost, time, QA, throughput) with n, intervals and gaps; no verdict, no writes' },
  agentistics_repos: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed metrics per repository' },
  // ------------------------------------------------------------------ Layouts (custom page, stored in preferences)
  agentistics_component_catalog: { ...DATA, risk: 'R', routes: [], reason: 'returns a static list; calls nothing' },
  agentistics_get_layouts: { ...PREFS, risk: 'R', routes: ['GET /api/preferences'], reason: 'reads the saved layouts' },
  agentistics_get_preferences: { ...PREFS, risk: 'R', routes: ['GET /api/preferences'], reason: 'reads the Nay persona preferences' },
  agentistics_set_preferences: { ...PREFS, risk: 'W', routes: ['GET /api/preferences', 'PUT /api/preferences'], reason: 'updates the Nay persona preferences through the validated preference boundary' },
  agentistics_create_layout: { ...PREFS, risk: 'W', routes: ['GET /api/preferences', 'PUT /api/preferences'], reason: 'adds a layout; removed by delete_layout' },
  agentistics_add_component: { ...PREFS, risk: 'W', routes: ['GET /api/preferences', 'PUT /api/preferences'], reason: 'adds a widget; removed by remove_component' },
  agentistics_remove_component: { ...PREFS, risk: 'W', routes: ['GET /api/preferences', 'PUT /api/preferences'], reason: 'removes a widget; re-added by add_component' },
  agentistics_set_active_layout: { ...PREFS, risk: 'W', routes: ['GET /api/preferences', 'PUT /api/preferences'], reason: 'switches the active layout; switched back by the same call' },
  agentistics_delete_layout: {
    ...PREFS, risk: 'W', routes: ['GET /api/preferences', 'PUT /api/preferences'],
    reason: 'a layout is a saved arrangement of widgets, no data goes with it (§5 defect 3: W, not D)',
  },
  agentistics_build_layout: { ...PREFS, risk: 'W', routes: ['GET /api/preferences', 'PUT /api/preferences'], reason: 'writes a layout; reversible by another build or delete' },
  // ------------------------------------------------------------------ PDF export
  agentistics_export_pdf: { ...DATA, risk: 'R', routes: [], reason: 'composes a local dashboard URL; calls nothing and exports nothing itself' },
  // ------------------------------------------------------------------ Tags
  agentistics_tags: { ...DATA, risk: 'R', routes: ['GET /api/tags'], reason: 'reads aggregate-only tag cards' },
  agentistics_tag_detail: { ...DATA, risk: 'R', routes: ['GET /api/tags', 'GET /api/tags/:id'], reason: 'reads one tag aggregate (counts and sums only)' },
  // ------------------------------------------------------------------ Vault (COFRE.DESBLOQUEIO)
  agentistics_vault_status: {
    ...TASKS, risk: 'R', routes: ['GET /api/vault', 'GET /api/deliveries/integrity'],
    reason: 'reads how the vault is protected (state, ways to confirm in use and offered, password rules) through an allowlist, plus the delivery owner-proof mode and whether the guard files carry their seal; never an item, a key id or a secret',
  },
  // ------------------------------------------------------------------ Browser (NAVEGADOR S1)
  agentistics_browser_status: {
    ...TASKS, risk: 'R', routes: ['GET /api/browser/status'],
    reason: 'reads the browser host state (executable, live browsers, ceilings, memory, recent stops) through an allowlist; starts nothing',
  },
  agentistics_browser_navigate: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/navigate'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_back: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/back'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_forward: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/forward'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_reload: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/reload'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_snapshot: {
    ...TASKS, risk: 'R', routes: ['POST /api/browser/session/snapshot'],
    reason: "reads the session's OWN throwaway browser (page text, picture, tabs or a bounded wait); changes nothing",
  },
  agentistics_browser_click: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/click'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_type: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/type'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_press: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/press'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_select: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/select'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_scroll: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/scroll'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_screenshot: {
    ...TASKS, risk: 'R', routes: ['POST /api/browser/session/screenshot'],
    reason: "reads the session's OWN throwaway browser (page text, picture, tabs or a bounded wait); changes nothing",
  },
  agentistics_browser_wait_for: {
    ...TASKS, risk: 'R', routes: ['POST /api/browser/session/wait_for'],
    reason: "reads the session's OWN throwaway browser (page text, picture, tabs or a bounded wait); changes nothing",
  },
  agentistics_browser_evaluate: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/evaluate'],
    reason: "runs a script inside the session's OWN throwaway browser page (result capped at 20 KB); the page reaches nothing the block rules refuse and nothing the harness could not already fetch",
  },
  agentistics_browser_tabs: {
    ...TASKS, risk: 'R', routes: ['POST /api/browser/session/tabs'],
    reason: "reads the session's OWN throwaway browser (page text, picture, tabs or a bounded wait); changes nothing",
  },
  agentistics_browser_tab_new: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/tab_new'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_tab_select: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/tab_select'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_tab_close: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/tab_close'],
    reason: "drives the session's OWN throwaway browser (profile deleted on close); agentistics' ports, file: and chrome: stay refused, and it reaches nothing the harness could not already fetch",
  },
  agentistics_browser_close: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/session/close'],
    reason: "closes the session's OWN throwaway browser; the next browser call starts a fresh one",
  },
  agentistics_browser_wait_unlock: {
    ...TASKS, risk: 'R', routes: ['POST /api/browser/session/wait_unlock'],
    reason: "waits for the person to hand the session's OWN browser back; reads the padlock, changes nothing and starts no browser",
  },
  agentistics_browser_lock: {
    ...TASKS, risk: 'W', routes: ['POST /api/browser/lock'],
    reason: "the PERSON's padlock on a session's browser; the server refuses it from inside any session (session_cannot_unlock), so a session can never free or take back its own browser",
  },
  // ------------------------------------------------------------------ Experimental flows (read-only host operations)
  agentistics_flow_run: { ...DATA, capability: 'localShell', host: true, risk: 'R', routes: ['POST /api/flows/run'], reason: 'runs only the built-in deterministic flow gates; it deletes nothing' },
  agentistics_flow_status: { ...DATA, capability: 'localShell', host: true, risk: 'R', routes: ['GET /api/flows/status/:runId'], reason: 'reads a durable deterministic flow run' },
}

/**
 * Tools classed `D` whose handler still calls the action route directly, because the intent route
 * (`POST /api/agent/intents`) does not exist until P2. The lint allows exactly these to break the
 * "a D handler calls only the intent route" rule, and refuses any entry that is not a `D` tool — so
 * this list can only SHRINK, one P2 item at a time.
 */
export const D_DIRECT_UNTIL_P2: readonly AgentToolName[] = ['agentistics_task_delete']

/** The one route a `D` tool may call (P2.1). */
export const AGENT_INTENT_ROUTE = '/api/agent/intents'

export interface NeverRoute {
  /** A path prefix, matched against the path the MCP would call. */
  prefix: string
  /** Absent = every method. Otherwise only these methods are forbidden (a READ may be fine). */
  methods?: readonly string[]
  reason: string
}

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * §3.14 — the routes the MCP must never reach, with the reason. Closed on purpose: a surface joins
 * this list by a spec decision, never by a drive-by.
 */
export const NEVER_ROUTES: readonly NeverRoute[] = [
  { prefix: '/api/exec', reason: 'arbitrary process on the host' },
  { prefix: '/api/chat-tty', reason: 'spawns a model on the host; Nay spawning Nay is a loop with a wallet' },
  { prefix: '/api/claude-chat', reason: 'deleted in P0.1; must never come back through the MCP' },
  { prefix: '/api/fleet/input', reason: 'raw keyboard into a session is unbounded' },
  { prefix: '/api/fleet/attach', reason: 'a raw terminal on a session is unbounded' },
  { prefix: '/api/shell', reason: 'a raw shell on the host is unbounded' },
  { prefix: '/api/fleet/tree', methods: WRITES, reason: 'writing files bypasses the target session\'s own permission prompts' },
  { prefix: '/api/provider', methods: ['PUT', 'DELETE'], reason: 'provider credentials' },
  { prefix: '/api/config', reason: 'the env config holds the gates that constrain the agent' },
  { prefix: '/api/mcp/install', reason: 'installs code' },
  { prefix: '/api/mcp/replace', reason: 'installs code' },
  { prefix: '/api/backup/restore', reason: 'overwrites history' },
]

/**
 * The preference keys that are security switches (§3.14): the MCP writes `/api/preferences` for its
 * layouts, so the route itself cannot be a NEVER entry — the KEYS are. The lint refuses any mention
 * of them in the MCP source. The spec's phone-pairing and voice-approval switches join this list the
 * day they exist.
 */
export const NEVER_PREFERENCE_KEYS: readonly string[] = ['shellEnabled', 'chatEnabled', 'editorEnabled', 'browserEnabled']

/** True when `METHOD path` hits a NEVER route. Pure; the lint and (from P2) the gate share it. */
export function neverRouteFor(method: string, path: string): NeverRoute | null {
  const m = method.toUpperCase()
  for (const r of NEVER_ROUTES) {
    const hit = path === r.prefix || path.startsWith(r.prefix + '/') || path.startsWith(r.prefix + '?')
    if (hit && (!r.methods || r.methods.includes(m))) return r
  }
  return null
}

/** The prefix of every tool an ENGINE declares (`EngineManifest.mcpTools`, engine-api 1.30). */
export const ENGINE_TOOL_PREFIX = 'agentistics_x_'

export function isEngineToolName(name: string): boolean {
  return name.startsWith(ENGINE_TOOL_PREFIX)
}

/**
 * The policy of an engine-declared tool, from what the engine DECLARED: R = read, W = reversible write (audited
 * like any other W tool). Engine tools can never be `D` — the declaration has no such value. Both need host power.
 */
export function engineToolPolicy(tool: { risk: 'R' | 'W'; method: string; path: string }): AgentToolPolicy {
  return {
    risk: tool.risk === 'W' ? 'W' : 'R',
    reason: 'declared by the engine in its manifest',
    routes: [`${tool.method} ${tool.path}`],
    capability: 'localShell',
    host: true,
    allowance: null,
  }
}
