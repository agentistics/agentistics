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
  /** How the tool behaves against a central: refused there, works on both, or central-only. */
  central: 'refuse' | 'allow' | 'only'
  /** The standing allowance (§4.4) that may cover it. Every existing tool: `null`. */
  allowance: 'prompt' | 'spawn' | null
}

/** Every tool the MCP exposes today — 38 on `origin/dev` (the spec's §1 said 44; P0.3 re-counted). */
export const AGENT_TOOL_NAMES = [
  // ALM (18)
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
  'agentistics_task_edit',
  'agentistics_task_session',
  'agentistics_task_delete',
  // Session groups (3)
  'agentistics_session_groups',
  'agentistics_session_group_create',
  'agentistics_session_group_edit',
  // Session notifications (1)
  'agentistics_session_notify',
  'agentistics_session_message',
  // Metrics (6)
  'agentistics_summary',
  'agentistics_harnesses',
  'agentistics_projects',
  'agentistics_sessions',
  'agentistics_costs',
  'agentistics_repos',
  // Layouts (8)
  'agentistics_component_catalog',
  'agentistics_get_layouts',
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
  // Team (2)
  'agentistics_team_status',
  'agentistics_team_members',
] as const

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

const TASKS = { capability: 'localShell', host: true, central: 'refuse', allowance: null } as const
const GROUPS = TASKS
const DATA = { host: false, central: 'allow', allowance: null } as const
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
  agentistics_task_edit: { ...TASKS, risk: 'W', routes: ['POST /api/tasks/:ref'], reason: 'edits task fields; reversible by another edit' },
  agentistics_task_session: {
    ...TASKS, risk: 'W', routes: ['POST /api/tasks/x/sessions', 'POST /api/tasks/:ref/sessions'],
    reason: 'files or detaches a session under a task; filing is reversible',
  },
  agentistics_task_delete: {
    ...TASKS, risk: 'D', routes: ['DELETE /api/tasks/:ref'],
    reason: 'destroys a task with its history; re-classed D by the spec (§3.5), moves behind an intent in P2.6',
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
  // ------------------------------------------------------------------ Metrics
  agentistics_summary: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed metrics' },
  agentistics_harnesses: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed metrics per harness' },
  agentistics_projects: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed metrics per project' },
  agentistics_sessions: { ...DATA, capability: 'localShell', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/fleet'], reason: 'reads session metadata (first_prompt is untrusted text, §4.8)' },
  agentistics_costs: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed costs' },
  agentistics_repos: { ...DATA, capability: 'localTranscripts', host: true, risk: 'R', routes: ['GET /api/data', 'GET /api/runtime/metrics'], reason: 'reads computed metrics per repository' },
  // ------------------------------------------------------------------ Layouts (custom page, stored in preferences)
  agentistics_component_catalog: { ...DATA, risk: 'R', routes: [], reason: 'returns a static list; calls nothing' },
  agentistics_get_layouts: { ...PREFS, risk: 'R', routes: ['GET /api/preferences'], reason: 'reads the saved layouts' },
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
  // ------------------------------------------------------------------ Team
  agentistics_team_status: { ...PREFS, risk: 'R', routes: ['GET /api/preferences'], reason: 'reads mode and connection endpoints; returns no token' },
  agentistics_team_members: { ...DATA, central: 'only', risk: 'R', routes: ['GET /api/team/members'], reason: 'reads the member list; central only' },
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
  { prefix: '/api/team/connections', methods: WRITES, reason: 'adding a connection carries a credential' },
  { prefix: '/api/team/tokens', reason: 'team credentials' },
  { prefix: '/api/team/repos', methods: WRITES, reason: 'mints a CI credential' },
  { prefix: '/api/iam', methods: WRITES, reason: 'identity and escalation; step-up territory' },
  { prefix: '/api/team/members', methods: WRITES, reason: 'identity and escalation' },
  { prefix: '/api/team/config', methods: WRITES, reason: 'the central\'s own policy' },
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
export const NEVER_PREFERENCE_KEYS: readonly string[] = ['shellEnabled', 'chatEnabled', 'editorEnabled', 'remoteSessions']

/** True when `METHOD path` hits a NEVER route. Pure; the lint and (from P2) the gate share it. */
export function neverRouteFor(method: string, path: string): NeverRoute | null {
  const m = method.toUpperCase()
  for (const r of NEVER_ROUTES) {
    const hit = path === r.prefix || path.startsWith(r.prefix + '/') || path.startsWith(r.prefix + '?')
    if (hit && (!r.methods || r.methods.includes(m))) return r
  }
  return null
}
