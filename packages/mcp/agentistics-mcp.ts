#!/usr/bin/env node
import { liveDeliveryQuery } from "./live-delivery-args";
import { deliveryCalendarQuery } from "./delivery-calendar-args";
import { flowStatusRunId } from './flow-status'
import { sessionRoleBody } from "./session-role-args";
import "./orphan-guard-boot";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AnySession,
  filterSessions,
  sessionHarness,
  sessionMessages,
  sessionTokens,
  startedByFleetPayload,
  deliveredOpenByConversation,
  harnessParam,
  toolsForGate,
} from "./session-tokens.js";
import { createAgentAuditSink } from "./agent-audit.js";
import { taskCommentRequest } from "./task-comment-args.js";
import { sessionProof } from "./session-proof.js";
import { bookTakeoverPayload } from "./book-takeover-payload.js";
import { HARNESS_CAPABILITIES, contextReading, nativeVisibleFrom, projectionSurfaceOn, type RouteKind } from "@agentistics/core";
import { planLimitsTool } from "./plan-limits-tool.js";
import { benchmarkObservedTool, benchmarkQueryFromArgs } from "./benchmark-tool.js";
import { harnessesTool } from "./harnesses-tool.js";
import { vaultStatusTool } from "./vault-tool.js";
import { legacyCosts, legacyHarnesses, legacyProjects, legacyRepos, legacySummary } from "./legacy-analytics.js";
import { PROJECTED_TOOLS, ProjectionUnavailable, type MetricsQueryFn, type ProjectedTool } from "./projected-analytics.js";

const API = process.env.AGENTISTICS_API ?? "http://localhost:47291";

// Multi-harness helpers
// agentistics tracks sessions from every registered harness (Claude Code, Codex CLI, Gemini CLI,
// Copilot CLI, Antigravity CLI, Kimi Code). Sessions carry a `harness` field; legacy/missing defaults to claude.

// Hidden by default: the native harness is experimental, and `ListTools` re-derives this per gate answer.
const HARNESS_PARAM = harnessParam(false);

/** The context gauge's facts for one session, from the SAME rule the screen uses. Absent when the harness has no gauge or nothing was measured. */
function contextFields(s: any): Record<string, unknown> {
  if (!(HARNESS_CAPABILITIES as any)[sessionHarness(s)]?.contextWindow) return {};
  const r = contextReading({ context_tokens: s.context_tokens, context_window: s.context_window, model: s.model });
  if (r.used === null) return {};
  return {
    contextTokens: r.used,
    contextWindow: r.window,
    contextFraction: r.fraction,
    ...(r.window === null ? { contextLimit: "not reported" } : {}),
  };
}

/** The server's gate (`GET /api/engine` → `nativeVisibleFrom`). An unreachable server reads as hidden. */
async function nativeVisibleNow(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/engine`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? nativeVisibleFrom(await res.json()) : false;
  } catch {
    return false;
  }
}

/** Flow tools are offered only when both the official engine and its opt-in flag are visible. */
async function flowsVisibleNow(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/engine`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = await res.json() as { flowsExperimental?: unknown; flows?: unknown };
    return body.flowsExperimental === true && body.flows === true;
  } catch {
    return false;
  }
}

// Static mirror of src/lib/componentCatalog.tsx — keep in sync when adding components
const CATALOG = [
  // KPI cards
  { id: "kpi.messages",        label: "Messages",           category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Total message count in selected period" },
  { id: "kpi.sessions",        label: "Sessions",           category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Session count + avg msgs/session" },
  { id: "kpi.tool-calls",      label: "Tool calls",         category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Total tool execution count" },
  { id: "kpi.cost",            label: "Estimated cost",     category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Estimated USD cost" },
  { id: "kpi.streak",          label: "Streak",             category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Consecutive days streak" },
  { id: "kpi.longest-session", label: "Longest session",    category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Duration of longest session" },
  { id: "kpi.commits",         label: "Commits",            category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Git commits via Claude" },
  { id: "kpi.files",           label: "Files modified",     category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Files modified + line diff" },
  { id: "kpi.input-tokens",    label: "Input tokens",       category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Input tokens sent to model" },
  { id: "kpi.output-tokens",   label: "Output tokens",      category: "kpi",      defaultW: 3,  defaultH: 3, minW: 2, minH: 2, description: "Output tokens generated by model" },
  // Activity
  { id: "activity.chart",          label: "Activity chart (full)",       category: "activity", defaultW: 8,  defaultH: 7, minW: 4, minH: 4, description: "Full activity chart with all metrics" },
  { id: "activity.chart.messages", label: "Activity — Messages only",    category: "activity", defaultW: 6,  defaultH: 6, minW: 3, minH: 3, description: "Daily messages bar chart" },
  { id: "activity.chart.sessions", label: "Activity — Sessions only",    category: "activity", defaultW: 6,  defaultH: 6, minW: 3, minH: 3, description: "Daily sessions bar chart" },
  { id: "activity.chart.tools",    label: "Activity — Tool calls only",  category: "activity", defaultW: 6,  defaultH: 6, minW: 3, minH: 3, description: "Daily tool calls bar chart" },
  { id: "activity.chart.overlay",  label: "Activity — Overlay",          category: "activity", defaultW: 8,  defaultH: 6, minW: 4, minH: 3, description: "Overlay visualization of all metrics" },
  { id: "activity.heatmap",        label: "Activity heatmap",            category: "activity", defaultW: 6,  defaultH: 6, minW: 3, minH: 3, description: "Calendar heatmap of daily activity" },
  { id: "activity.hours",          label: "Usage by hour",               category: "activity", defaultW: 8,  defaultH: 6, minW: 4, minH: 3, description: "Hourly usage breakdown" },
  // Costs
  { id: "costs.models", label: "Model usage",        category: "costs",    defaultW: 12, defaultH: 7, minW: 6, minH: 4, description: "Cost and token breakdown by model" },
  { id: "costs.budget", label: "Budget & forecast",  category: "costs",    defaultW: 6,  defaultH: 7, minW: 4, minH: 4, description: "Monthly budget progress and cost forecast" },
  { id: "costs.cache",  label: "Cache efficiency",   category: "costs",    defaultW: 6,  defaultH: 7, minW: 4, minH: 4, description: "Cache hit rate and savings" },
  // Projects
  { id: "projects.top",       label: "Top projects", category: "projects", defaultW: 7,  defaultH: 7, minW: 4, minH: 4, description: "Most active projects ranked by metrics" },
  { id: "projects.languages", label: "Languages",    category: "projects", defaultW: 5,  defaultH: 6, minW: 3, minH: 3, description: "Language distribution word cloud" },
  // Tools & Agents
  { id: "tools.metrics",        label: "Tool metrics (full)",        category: "tools", defaultW: 12, defaultH: 8, minW: 6, minH: 4, description: "Full breakdown of tool usage by type" },
  { id: "tools.metrics.calls",  label: "Tool metrics — calls only",  category: "tools", defaultW: 8,  defaultH: 7, minW: 4, minH: 4, description: "Tool call counts chart" },
  { id: "tools.metrics.tokens", label: "Tool metrics — tokens only", category: "tools", defaultW: 8,  defaultH: 7, minW: 4, minH: 4, description: "Tokens consumed per tool type" },
  { id: "tools.agents",         label: "Agent metrics",              category: "tools", defaultW: 12, defaultH: 8, minW: 6, minH: 4, description: "Sub-agent invocation metrics, durations, costs" },
  // Sessions
  { id: "sessions.highlights", label: "Highlights",       category: "sessions", defaultW: 12, defaultH: 6, minW: 6, minH: 3, description: "Record-breaking sessions" },
  { id: "sessions.recent",     label: "Recent sessions",  category: "sessions", defaultW: 12, defaultH: 7, minW: 6, minH: 4, description: "List of most recent sessions" },
];

async function apiGetText(path: string) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`agentistics API ${path} → HTTP ${res.status}`);
  return res.text();
}

async function apiGet(path: string) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`agentistics API ${path} → HTTP ${res.status}`);
  return res.json();
}

const LEGACY_TOOLS: Record<ProjectedTool, (data: any, harness?: string) => unknown> = {
  agentistics_summary: legacySummary,
  agentistics_harnesses: (data) => legacyHarnesses(data),
  agentistics_projects: legacyProjects,
  agentistics_costs: legacyCosts,
  agentistics_repos: legacyRepos,
};

/** Where an analytics tool's answer comes from — passed by each handler, so its routes stay in its body. */
interface AnalyticsSources {
  legacy: () => Promise<any>;
  metrics: (query: URLSearchParams) => Promise<Response>;
}

/**
 * One analytics tool's answer. Projected (A4.4) by default (`AGENTISTICS_PROJECTIONS_SURFACES=legacy`
 * is the fallback) whenever the server serves projections — a refusal
 * (the server's `AGENTISTICS_PROJECTIONS` gate off, no reader) answers from `/api/data`.
 */
async function analytics(tool: ProjectedTool, harness: string | undefined, from: AnalyticsSources): Promise<unknown> {
  if (projectionSurfaceOn("mcp")) {
    const query: MetricsQueryFn = async (params) => {
      const res = await from.metrics(params);
      const body = await res.json().catch(() => ({})) as any;
      return res.ok ? { ok: true, body } : { ok: false, status: res.status, error: String(body?.error ?? res.status) };
    };
    try {
      return await PROJECTED_TOOLS[tool](query, harness);
    } catch (err) {
      if (!(err instanceof ProjectionUnavailable)) throw err;
    }
  }
  return LEGACY_TOOLS[tool](await from.legacy(), harness);
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

async function getPrefs() {
  return apiGet("/api/preferences");
}

async function apiSend(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!res.ok) {
    // The BODY, not just the status. A refusal here is usually actionable — "this move needs a
    // reason", "somebody else holds this claim" — and a bare `HTTP 422` teaches the caller nothing
    // it can act on, which turns one refusal into a retry loop.
    const detail = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → HTTP ${res.status}${detail ? ` ${detail.slice(0, 400)}` : ""}`);
  }
  return res.json().catch(() => ({}));
}

async function putPrefs(patch: Record<string, unknown>) {
  const res = await fetch(`${API}/api/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`PUT /api/preferences → HTTP ${res.status}${detail ? ` ${detail.slice(0, 400)}` : ''}`)
  }
  return res.json();
}

function nextId(items: Array<{ i: string }>): string {
  let max = 0;
  for (const item of items) {
    const n = parseInt(item.i, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

// First-fit shelf packing across a 12-column grid.
// Scans every y level from 0 downward and returns the leftmost x where
// an item of width `newW` fits without overlapping existing items.
function autoPosition(
  items: Array<{ x: number; y: number; w: number; h: number }>,
  newW = 3,
  gridW = 12,
): { x: number; y: number } {
  if (items.length === 0) return { x: 0, y: 0 };
  const maxBottom = Math.max(...items.map((i) => i.y + i.h));
  for (let y = 0; y <= maxBottom; y++) {
    // Occupied x-ranges at this y level
    const blocks = items
      .filter((i) => i.y <= y && i.y + i.h > y)
      .map((i) => ({ start: i.x, end: i.x + i.w }))
      .sort((a, b) => a.start - b.start);
    // Find leftmost gap >= newW
    let x = 0;
    for (const block of blocks) {
      if (block.start >= x + newW) break; // gap before this block fits
      if (block.end > x) x = block.end;
    }
    if (x + newW <= gridW) return { x, y };
  }
  // No gap found — place at bottom
  return { x: 0, y: maxBottom };
}

// After packing, extend any item that has empty space to its right
// (no neighbour sharing any row with it on the right side).
// This eliminates orphaned gaps like a w:8 chart next to 4 empty columns.
function fillGaps(
  items: Array<{ x: number; y: number; w: number; h: number }>,
  gridW = 12,
): void {
  for (const item of items) {
    const rightEdge = item.x + item.w;
    if (rightEdge >= gridW) continue;
    const hasRightNeighbour = items.some(
      (other) =>
        other !== item &&
        other.x >= rightEdge &&
        other.y < item.y + item.h &&
        other.y + other.h > item.y,
    );
    if (!hasRightNeighbour) {
      item.w = gridW - item.x;
    }
  }
}

// Server

const server = new Server(
  { name: "agentistics", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const TOOLS: Tool[] = [
  // ---------------------------------------------------------------- the ALM (task board)
  //
  // These let an assistant read and drive the board the way a person does: see what everyone is
  // working on, file its own work under a task, leave a note for the next one, attach the spec it
  // just wrote. Every one of them is a thin call to `/api/tasks` — the arithmetic and the rules
  // live on the server, so the MCP, the CLI and the dashboard can never disagree about a delivery.
  {
    name: "agentistics_tasks",
    description:
      "List every task on the ALM board with its rollup (cost, rounds, sessions used, tokens) plus a board-wide overview: tasks in flight, delivered, average cost per task and per task, top models and harnesses. START HERE to see what work exists and what the other assistants are on.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "agentistics_task",
    description:
      "Open ONE task: its attempts (one per configuration tried), the sessions filed under it with their live state, its comments, subtasks, files, links and full metrics (models, harnesses, agent runs, tokens, delivery time). Comments come twice: `comments` (flat, oldest first, each with `subtaskId` when it was left on a subtask or group) and `commentThreads` — the same comments grouped by their OWN target (`target: {kind: 'task'|'group'|'subtask', id, title}`; the task first, empty targets omitted). `ref` is the task id or its exact title.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "Task id or exact title." } },
      required: ["ref"],
    },
  },
  {
    name: "agentistics_task_create",
    description:
      "Create a task. A title is required; a description is optional. Set `priority` (urgent | high | medium | low — default low, and nobody chose a default) and `type` (an id from agentistics_task_types) when you know them: a board of defaults orders nothing. Creating a title that already exists returns the existing task rather than a duplicate (its priority and type are left alone — use agentistics_task_edit), so this is safe to call before filing work under a name you are not sure exists.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"], description: "Defaults to low. Decides the order of the queue and of the Live delivery line." },
        type: { type: "string", description: "A type id from agentistics_task_types (an unknown one is dropped)." },
      },
      required: ["title"],
    },
  },
  {
    name: "agentistics_task_status",
    description:
      "Move a task to a status. The status VOCABULARY is an editable list now, not a fixed set — call agentistics_task_statuses first if you are unsure what this board currently has; a fresh board starts with exactly `todo`, `in_progress`, `blocked` and `done`. Only `done` stamps a task and closes rounds-to-delivery; `abandoned` (when the board has it) records that the work was given up on, which is a real outcome and not a failure to report — but it is NOT created by default, so use agentistics_task_status_edit to add it (or any other status) first if it is missing. **`blocked` REQUIRES a `reason` or a `blockedBy` list** and is refused (422) without one: it is the status that names a problem somebody has to go and solve, and a blocked card that does not say what it is waiting on cannot be unblocked by anyone but you. **`done` REQUIRES the task to have at least one session filed under it** and is refused (422, `done_needs_session`) without one. A `status` naming nothing this board currently has is refused (400, `unknown_status`). Pass `actor` (who you are) so the move is recorded against you in the activity log.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        status: {
          type: "string",
          description:
            "A status id this board currently has — call agentistics_task_statuses to see the live list. The four every board starts with are todo | in_progress | blocked | done.",
        },
        actor: { type: "string" },
        allowOpenSubtasks: { type: "boolean", description: "Explicitly move a parent to in_review despite open top-level subtasks, after inspecting the open_subtasks refusal. Default false." },
        reason: {
          type: "string",
          description: "Why it is blocked, in your own words. Required by `blocked` unless you pass `blockedBy`.",
        },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must finish first — the other way to answer 'blocked on what'.",
        },
      },
      required: ["ref", "status"],
    },
  },
  {
    name: "agentistics_task_statuses",
    description:
      "List every status this board currently has (id, label, color, and whether it is protected — todo/in_progress/blocked/done can never be deleted or have their id changed, but their label and color can). Call this before agentistics_task_status if you are not sure a status you want to move a task to actually exists.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agentistics_task_types",
    description:
      "List the task TYPE vocabulary (id, label, color, order, usageCount). A type is a second classification beside the status (e.g. CORE); a task may carry one or none. Call this before setting `type` through agentistics_task_edit.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agentistics_task_type_edit",
    description:
      "Add, rename/recolor, or delete a task type. Pass `label` (and optional `color`, a `#rrggbb` hex string) alone to CREATE a type — its id is derived from the label. Pass `id` with `label` and/or `color` to EDIT. Pass `id` with `remove: true` to DELETE: refused (422, `in_use`, with `usageCount`) while any task still carries it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Required to edit or delete; omit to create." },
        label: { type: "string" },
        color: { type: "string", description: "#rrggbb" },
        remove: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "agentistics_task_status_edit",
    description:
      "Add, rename/recolor, or delete a status. Pass `label` (and optional `color`, a `#rrggbb` hex string) alone to CREATE a new, non-protected status — its id is derived from the label and returned. Pass `id` with `label` and/or `color` to EDIT an existing status's label/color — works on a protected one too, only its id can never change. Pass `id` with `remove: true` to DELETE it: refused (422, `protected`) for todo/in_progress/blocked/done regardless of usage, and refused (422, `in_use`, with `usageCount`) for any other status still referenced by at least one task or subtask.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Required to edit or delete; omit to create." },
        label: { type: "string" },
        color: { type: "string", description: "A #rrggbb hex string." },
        remove: { type: "boolean" },
      },
    },
  },
  {
    name: "agentistics_task_comment",
    description:
      "Leave a comment on a task — or on ONE of its subtasks or subtask GROUPS by passing `subtaskId` (a group's own id is allowed; omit it to comment on the task itself). `body` may be empty when `attachments` is given. Comments carry attachments as REFERENCES into the chat's own attachment store (`{name, path}`; agentistics_task returns them on each comment with a `url` that serves the file) — there is no second store. Use it to tell the person and the other assistants what you did, what you found, or what you are blocked on; comment where the work is (the subtask you are on) rather than on the whole task. An unknown, deleted or other task's `subtaskId` is REFUSED with a sentence (422, `no_such_subtask` / `wrong_delivery`) — never silently filed on the task. Threads read downward: a subtask's thread is its own comments, a group's thread is its own plus its members', the task's is everything. The activity log names the target. `author` is free text — say who you are (e.g. 'claude:3f5f'). THREADS: a thread is a topic on the task; post into one with `threadId`, or open one with `threadTitle` (sessions: handbacks and blocks only). A thread is a RECORD, not a chat: a comment there reaches nobody by itself, so never wait for an answer in a thread. When you post in a thread you join it; the person may explicitly SEND a message from it, which arrives in your own chat starting `[Agentask · … · sent by the owner]` — answer there, in your chat, which is where conversations live. If you need something from the person, ask in your own chat as always.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        subtaskId: {
          type: "string",
          description: "Optional target: a subtask or subtask GROUP id of this task (from agentistics_task's `subtasks`). Omit for the task itself.",
        },
        threadId: {
          type: "string",
          description: "Optional: post INTO this thread (an id from agentistics_task's `threads`). Reply in the thread the person or another session already opened about this.",
        },
        threadTitle: {
          type: "string",
          description: "Optional: OPEN a new thread with this title and post the comment as its first message. Sessions may open threads ONLY for a handback or a block (`threadKind`).",
        },
        threadKind: {
          type: "string",
          enum: ["handback", "block"],
          description: "The kind of the thread opened with `threadTitle`. Default handback.",
        },
        kind: {
          type: "string",
          enum: ["handback", "block"],
          description: "Optional tag on THIS comment: a handback (you delivered something) or a block (you are stuck on something). Omit for a plain note.",
        },
        attachments: {
          type: "array",
          description: "Optional files left with the comment, as {name, path} references to files already in agentop's attachments directory (the path the chat upload returns). Paths outside it are dropped. At most 10.",
          items: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } }, required: ["path"] },
        },
      },
      required: ["ref"],
    },
  },
  {
    name: "agentistics_task_subtask",
    description:
      "Joining a staged subtask to a group folds its queued delivery and brief into the group, keeping one queue card and an audit reason. " +
      "Add a subtask, or change one. Pass `title` to add; pass `id` with `done`, `status`, `dueDate`, `startDate`, `blockedBy` or `parentGroupId` to edit one. `startedAt`/`deliveredAt` are system-stamped facts (when real work began / when this piece reached `done`) and are never set through this tool — they are read back on the subtask record. A subtask carries the same columns its parent does; its own cost, tokens, rounds and harness are rolled up from the sessions filed under it — the PARENT task's rollup is the sum of all its subtasks' sessions. A subtask CAN be blocked by another subtask of the SAME parent (pass `blockedBy` as the full list of sibling subtask ids that must be `done` first; a sibling outside this task, or the subtask itself, is dropped rather than accepted) — this is separate from agentistics_task_blocked_by, which blocks a whole TASK on other tasks. **`done` REQUIRES the subtask to have at least one session filed under it** and is refused (422, `done_needs_session`) without one — EXCEPT for a group MEMBER (`parentGroupId` set), which can never hold a session of its own (see below) and therefore reaches `done` through this same edit with no session required; a GROUP itself (`isGroup: true`) and an ordinary loose subtask both still need one. **The moment every one of a task's top-level subtasks (loose subtasks and groups — a group's own members never count separately) reaches `done`, the parent task auto-delivers too.** To put a session ON a subtask use agentistics_task_session with `subtaskId` — a subtask holds ANY NUMBER of sessions, so the link lives on the session, not in a field here. **SUBTASK GROUPS are a real hierarchy level, not a label**: pass `isGroup: true` with `title` to create a GROUP — a peer row that CAN hold a session, exactly like a loose subtask. Pass `id` (a subtask) with `parentGroupId` (a group's own subtask id, from the SAME parent task) to make it a MEMBER of that group — join with the group's id, leave with `parentGroupId: ''`. A refused reference (the id names no subtask, names one that is not `isGroup: true`, names a different task, or the subtask being patched is itself a group) is refused as `invalid_group` (422). **Joining a group is ALSO refused (422, `subtask_has_sessions`) when the subtask already has a session filed on it** — a member gets no rollup bucket of its own, so that session's cost would silently drop out of every visible breakdown while the task's own total kept counting it; detach the session first. **A MEMBER can never hold a session of its own** — filing on one is refused by agentistics_task_session with `subtask_in_group` (422); only the group itself accounts for a session, and a member's own status/dates/comments still exist and feed the group's progress percentage.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        title: { type: "string" },
        id: { type: "string" },
        done: {
          type: "boolean",
          description:
            "Send with `id` to tick (true -> status `done`) or untick (false -> `todo`). Alone it is the fast path; together with named fields (title, dates, status, parentGroupId, …) it is applied in the SAME edit — never dropped. A `status` that contradicts it (done=true with status `in_review`) is refused. With `parentGroupId` the tool joins the group first and then closes. `done` is still refused without a session filed under the subtask (done_needs_session).",
        },
        status: {
          type: "string",
          description:
            "A status id this board currently has — call agentistics_task_statuses for the live list (the vocabulary is editable, so it is NOT fixed here). The four every board starts with are todo | in_progress | blocked | done.",
        },
        dueDate: { type: "string" },
        startDate: { type: "string" },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Full replacement list of SIBLING subtask ids (same parent task) that must be done before this one. Requires `id` — a subtask being created has no siblings to name yet.",
        },
        isGroup: {
          type: "boolean",
          description:
            "Create this subtask as a GROUP instead of an ordinary subtask. Only meaningful together with `title` (creation) — a group's shape cannot be changed afterwards.",
        },
        parentGroupId: {
          type: "string",
          description:
            "Join this subtask (named by `id`) to the group whose id this names — a group of the SAME parent task. Pass an empty string to leave the current group. Refused (422, `invalid_group`) if the id is not an actual group of this task, or if this subtask is itself a group. Refused (422, `subtask_has_sessions`) if this subtask already has a session filed on it — detach it first. **With `done` in the same call the tool joins first and then closes, in order.**",
        },
      },
      required: ["ref"],
    },
  },
  {
    name: "agentistics_task_link",
    description:
      "Attach a link to a task — a pull request, an issue, a document. Pass `url` (http/https only) with an optional `label` and `kind` ('pr', 'issue', …). Pass `remove` with a link id to detach one.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        url: { type: "string" },
        label: { type: "string" },
        kind: { type: "string" },
        remove: { type: "string", description: "Link id to remove instead of adding." },
      },
      required: ["ref"],
    },
  },
  {
    name: "agentistics_task_blocked_by",
    description:
      "Set which tasks must finish before this one can proceed. Pass the full list of blocker task ids (it replaces, it does not append). A task cannot block itself.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, blockedBy: { type: "array", items: { type: "string" } } },
      required: ["ref", "blockedBy"],
    },
  },
  {
    name: "agentistics_task_next",
    description:
      "THE ORCHESTRATION CALL: what you can pick up right now. Returns the tasks that are open, not blocked by unfinished work, and not in another agent's hands — most urgent first, numbered from 1. It also returns `withheld`, every task that is NOT available with the reason (closed / blocked / claimed / status), because an agent told 'nothing' learns nothing; and `progress`, which separates 'it is all done' from 'everything is in somebody's hands right now'. Pass `actor` (who you are) so a task you already hold comes back as available to you rather than as taken.",
    inputSchema: {
      type: "object",
      properties: {
        actor: { type: "string", description: "Who is asking, e.g. 'claude:3f5f'." },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "agentistics_task_claim",
    description:
      "TAKE a task before working on it, so two agents cannot do the same one twice. This is a LEASE, not a lock: it expires (default 30 minutes) and the task returns to the board on its own, so an agent that dies does not hold work forever. Re-claiming as the same `by` REFRESHES the lease — do that while you are still working. Pass `release: true` to give it back when you finish or stop. A refusal names who holds it and until when; `takeover` is for a person overriding a live claim on purpose and an agent should not send it.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        by: { type: "string", description: "Who you are. Free text, e.g. 'claude:3f5f'." },
        release: { type: "boolean" },
        leaseMs: { type: "number", description: "How long the claim lasts. Default 30 minutes." },
        sessionId: { type: "string", description: "The managed session doing the work, if any." },
        note: { type: "string" },
        takeover: { type: "boolean" },
        force: { type: "boolean", description: "Release a claim you do not hold." },
      },
      required: ["ref", "by"],
    },
  },
  {
    name: "agentistics_task_activity",
    description:
      "What has been HAPPENING, newest first — status moves, claims, releases, priority changes, sessions filed. Pass `ref` for one task, or nothing for the whole board. On a board several agents drive this is how you find out what the others did without asking them.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, limit: { type: "number" } },
      required: [],
    },
  },
  {
    name: "agentistics_live_delivery",
    description:
      "What is being DELIVERED right now — the Live Delivery line, the same source as the screen. Use it to answer \"what is running\", \"when does X ship\" and \"is anything stalled\". Returns a `summary` (active deliveries, agents working, stalled, the next delivery with an estimate), the active `deliveries` with their stage (queue, running, qa, adjust, leader, merge, published), the agents on each (harness, model, account, live state), time in the stage and in total, the step inside the stage (`step`, with `stepSource` = `reported` or `signals` and `stepSignal` naming the observed fact — null `step` means nothing is observable, say so; the screen then draws no percent), the ETA with its source and confidence (`kind: none` means there is NO estimate — say so, never invent a time), the last action, and the `leaders` band (each leader's current action, its workers and what waits on a decision — leaders are not deliveries while the task has an open piece of its own; a leader working alone on a task with none gets ONE piece, `leaderPiece: true`, on the leader session's own clock). Each delivery carries its Agentask `priority` (urgent | high | medium | low; a subtask inherits its task's). Filters: `task` (id or part of the title), `stage`, `stalledOnly`, and the screen's own tabs — `tab`: `active` (Em andamento: every stage except queue, published, completed and old — a blocked or adjusting piece with no agent on it is in), `queue` (Na fila), `published` (Publicado) or `all` (Tudo: every piece in its real column, old legacy reviews marked `old`; the default here, while the screen opens on `active`) — and `period`, the Publicado period: `24h` (default), `7d`, `30d` or `all`. The answer's `view` carries `{tab, period, counts, defaulted, capped}`: `tab`/`period` are the EFFECTIVE values (a missing or invalid one falls back to `all` / `24h`, and `defaulted` names which did), `counts` is the count of EVERY tab under the same `task` filter and period, the very numbers the screen's tabs print, and `capped` (`{cap, omitted}`, else null) says the list was cut at 400 pieces per kind and that many older ones are NOT in the answer — then a count is not the total. Plus `sort` (how each stage lists its cards; default `priority`, highest first, ties by longest in the stage). Stage names on screen: queue = Na fila, running = Em desenvolvimento, qa = QA. There is no Histórico column any more: a piece published earlier is in `deliveries` whenever `period` covers it.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "A task id or part of its title." },
        stage: { type: "string", enum: ["queue", "blocked", "running", "qa", "adjust", "leader", "no-leader", "merge", "ci", "completed", "published"] },
        stalledOnly: { type: "boolean", description: "Only deliveries that need a person, lost an agent or are blocked." },
        tab: { type: "string", enum: ["active", "queue", "published", "all"], description: "The screen's tab: active (Em andamento), queue (Na fila), published (Publicado) or all (Tudo). Default all." },
        period: { type: "string", enum: ["24h", "7d", "30d", "all"], description: "How far back Publicado reaches. Default 24h." },
        sort: { type: "string", enum: ["priority", "time-in-stage", "recent"], description: "Order within each stage. Default priority (highest first, ties by longest in the stage)." },
      },
      required: [],
    },
  },
  {
    name: "agentistics_task_edit",
    description:
      "Set a task's fields: `title`, `detail`, `priority` (urgent | high | medium | low), `type` (an id from agentistics_task_types; empty string clears it), `dueDate` / `startDate` (yyyy-mm-dd), `labels`. An absent field is left alone; an EMPTY STRING clears it. `priority` defaults to `low`; a legacy `none` is stored as `low`. `startedAt`/`deliveredAt` are system-stamped facts and are never set through this tool. Pass `actor` so the change is recorded against you in the activity log.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        title: { type: "string" },
        detail: { type: "string" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
        type: { type: "string", description: "A task type id (see agentistics_task_types); empty string clears it." },
        dueDate: { type: "string" },
        startDate: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        actor: { type: "string" },
      },
      required: ["ref"],
    },
  },
  {
    name: "agentistics_task_session",
    description:
      "File a SESSION under a task, which is what makes the task measurable: its cost, tokens, rounds and harness all come from the sessions filed under it. Pass `subtaskId` to file it under one of the task's subtasks (the unit of WORK, for a task broken into steps) — this INCLUDES a subtask GROUP (see agentistics_task_subtask's `isGroup`), which holds a session exactly like any other subtask; omit `subtaskId` to file the session directly on the task itself (the unit of DELIVERY) — **only LEADER sessions may be filed on the task itself; a worker is refused (422, `leader_only`: only leader sessions are filed on the task itself; file this session on a subtask)**, so pass a `subtaskId` for workers. Both can be used on the same task — some sessions direct, some under subtasks — and each subtask's own rollup plus the directly-filed sessions' own rollup are both readable via agentistics_task's `subtaskRollups` (keyed by subtask id, with `id: null` for the direct ones), so the breakdown never disappears. **Filing on a subtask that is a MEMBER of a group (has a `parentGroupId`) is refused (422, `subtask_in_group`)** — a member can never hold a session, only the group itself can; file on the group's own id instead. Use agentistics_task to read the subtasks, or agentistics_task_subtask to create one, then pass `ref` + `sessionId` (a managed session id) + optionally `subtaskId`. Pass `detach` with a session id to unfile one. The task inherits the session's repository when it has none. **HISTORICAL conversations — pass `conversationId` INSTEAD of `sessionId`** to file a conversation that has NO live/registry row: typically a session that was killed and whose row agentop then purged, leaving its subtask `done` with 0 sessions and its cost missing from every rollup. The conversation must still be in the metrics store (its tokens/cost are what get counted); the link is kept on the board, never in the fleet, so nothing appears in the Sessions workspace and there is nothing to open — the row is marked `historical: true` in agentistics_task's `sessions`. Filing is a MOVE: one link per conversation, so filing it elsewhere replaces the old link and the answer reports `movedFrom: {taskId, subtaskId?}` (a plain `sessionId` filing reports `movedFrom` too when it displaced another filing). It counts everywhere a live session does (rollups, `subtaskRollups`, the board headline, `done_needs_session`, the group-join rule). Refusals: `no_such_conversation` (422 — the store has no record of that id; nothing to price, so nothing is filed), `conversation_in_fleet` (422 — a registry row already exists; the answer carries its `sessionId`, so call again with that as `sessionId`), plus the same target refusals as a session (`no_such_task`, `no_such_subtask`, `wrong_delivery`, `blocked`, `subtask_in_group`, `leader_only`). Optional `harness` disambiguates and `note` is kept on the link. To remove a historical link pass `detach` with the conversation id (or the row's `hist:<conversationId>` id).",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        sessionId: { type: "string" },
        conversationId: {
          type: "string",
          description:
            "A HISTORICAL conversation id (in the metrics store, no live/registry row) to file instead of a `sessionId`. Refused `conversation_in_fleet` if a row exists for it — use that row's id as `sessionId`.",
        },
        harness: {
          type: "string",
          description: "Only with `conversationId`: the conversation's harness, to disambiguate. Optional; it is read from the store.",
        },
        note: {
          type: "string",
          description: "Only with `conversationId`: a free-text note kept on the link (why it was filed here).",
        },
        subtaskId: {
          type: "string",
          description:
            "The subtask to file it under. Optional — omit to file the session directly on the task itself.",
        },
        detach: {
          type: "string",
          description: "A session id to unfile — or a historical conversation id (or `hist:<id>`) to drop its link.",
        },
      },
      required: [],
    },
  },
  {
    name: "agentistics_task_delete",
    description:
      "Delete a task and its comments, subtasks, files and links. The SESSIONS filed under it are kept — deleting a board entry never deletes work.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "agentistics_delivery_calendar",
    description:
      "BETA. The DELIVERY CALENDAR — when each piece of work started, when it is expected to ship, which release version it rides and when a version really went out; the same source and rules as the \"Calendário de entregas\" screen (`agentop flow calendario` prints the same). Returns `pieces` (task, subtask, stage, `version`, harness/model, priority, `startedAtMs`, `stageEta` and `publishEta` — `kind: none` means there is NO estimate: say so, never invent a time — `publishedAtMs`, `dueDate`, `confirmed`, `late`), `versions` (each with `state` published|planned, `atMs` = the real publication or the LATEST piece estimate, `basis` published|estimate|partial|none, the pieces and the count per stage) and `marks` (an account's usage window renewing, a task's due day). Times are epoch ms; day arguments are BRT days (America/Sao_Paulo). By default only pieces of tasks being worked on now; pass `all` for the history too. Filters: `task` (id or part of the title), `subtask`, `version` (one or a list), `stage`, `harness`, `priority`, `from`/`to` (yyyy-MM-dd or an ISO instant — keeps what touches the period), `confirmedOnly` (published or a medium/high-confidence estimate). `format: \"ics\"` returns the filtered view as an .ics file instead of JSON.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "A task id or part of its title." },
        subtask: { type: "string", description: "A subtask id." },
        version: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "A release version (2.202.0) or a list." },
        stage: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "queue, blocked, running, qa, adjust, leader, merge, ci, published — one or a list." },
        harness: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        priority: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "urgent, high, medium, low." },
        from: { type: "string", description: "Start of the period: yyyy-MM-dd (BRT) or an ISO instant." },
        to: { type: "string", description: "End of the period (inclusive)." },
        all: { type: "boolean", description: "Include pieces of tasks not being worked on now (history)." },
        confirmedOnly: { type: "boolean", description: "Only published pieces or those with a medium/high-confidence estimate." },
        format: { type: "string", enum: ["json", "ics"] },
      },
      required: [],
    },
  },
  {
    name: "agentistics_task_phase",
    description:
      "FLUXO.CICLO-COMPLETO — the minute `tick` also moves a piece in revisao_lider or pr_merge to ci BY ITSELF once its PR is merged (found from the piece's PR number, branch, the PR containing the sha QA approved, or its author worktree's branch; the merge gates `delecoes` + `mergeado` still run, and a refusal leaves the piece where it is with the reason), publishes ci pieces from the FIRST tag that contains the merge, and reminds the LIVE leader of the task (never the owner) of a piece waiting on them for 30 min, then every 2 h, at most 3 times. `get` with a `subtaskId` returns `tickReason`: why the tick has not moved it. `reconcile` (no `subtaskId`; `apply` true to write) is the one-shot BACKFILL: every piece in revisao_lider/pr_merge/ci matched to its merged PR and the first release tag containing it — a report of what moves and what cannot be proven, with the reason. " +
      "`tick` also enables the mandatory owner-request/placement flows through the official engine switches and reads canonical pedidos; after 10 minutes without any attended link it wakes the current live task leader at most once per pedido, across handoffs and restarts, and never asks the owner. Complete predispatch, a running/closed delivery or a deliberate hold/dequeue counts as attended; failed sends retry after 30 minutes. " +
      "Queue actions: `dequeue` withdraws a queued piece with a required free-text `reason` (task leader or owner only), keeps the draft/history, and refuses dispatch until explicitly restaged; `tick` reconciles stale queued pieces against board review/done/abandoned and records a comment. Vacancy counts live backend processes; lost/exited/closed sessions reserve no slots. " +
      "FLUXO.ENTREGA-DSL — read or move a DELIVERY (one subtask) through its fixed phases: fila → executando → qa → (ajuste ⇄ qa) → revisao_lider → pr_merge → ci → publicado, plus bloqueado (from any phase, back to the stored origin only). Any transition outside that table is REFUSED (422 `fase_pulada`) with a sentence naming what is missing — executando → revisao_lider, ajuste → revisao_lider and every other skip included. The gates each edge needs are run BY THE SERVER from evidence (predispatch, vaga, salvo = sha on origin per ls-remote, qa-modelo = QA model ≠ author model from the registry and never Sonnet over Sonnet, cabeca = the pushed branch is still at the sha QA tested, delecoes = no file deleted outright by the PR, mergeado = gh says the PR is MERGED, the merge commit is on origin/main and the PR head is the sha QA approved — the merge sha is READ FROM THE PR, never from you, release = the batch's version tag exists AND the release.yml run that produced it is green, read in the repository the release recorded); salvo needs every check run on the pushed head to have concluded green (pending or absent refuse); you never pass proof. `action`: `get` (default; omit `subtaskId` to list every delivery) | `phase` (`to` + what that edge reads: `verdict` APROVADO/REPROVADO + `findings` from qa, `reviewedSha` = the sha QA approved for revisao_lider → pr_merge, `detail` for a request for change or a failure reason) | `gate` (`name`: run ONE gate and record its evidence) | `block` (`reason` one of dependencia, pedido_de_bloqueio, limite, maquina, externo, fora_das_autorizacoes; `text`) | `unblock` (`detail`; the leader of the task or the owner — an owner-decision block only the owner) | `step` (`step` 1..9: the step of the current phase, for the Live %. The Live already DERIVES the step from real signals — a session open, a file edit, a test run, a commit, the gates, the PR — so report only when you know better; the card shows the larger of the two and says which it is. Works for a legacy piece with no delivery record too: only the board's `step` event is written, nothing is adopted into the flow) | `configure` (the LEADER of the task or the owner only; `patch`: versionTarget, humanGates [phases needing the owner's approval — skipped and recorded as 'pulado: modo autônomo' while autonomous mode is on], leaderSessionId, pr, tag, allowDeletions {paths, reason}; the QA and author sessions are never settable — the host records them from the sessions it opened and the registry) | `approve` (`phase`, `decision` approve|reject, `note`: answers a human gate the owner was ASKED about; a session identity is deliberately not sent, the owner answers through this same door as the Live card button and `agentop flow approve`) | `stage-run` (predispatch + vaga gates, then start the staged session and move to executando) | `merge` (delecoes gate, squash-merge the PR, move to ci; a failure goes back to revisao_lider) | `release` (the LEADER of the task or the owner DECLARES what a release contains: `version` x.y.z, `mergeSha` = the commit on main carrying it (information only; 40 characters, or a short sha the server resolves), optional `repo` = owner/name (default agentistics/agentistics), `subtaskIds` = every piece in it; no `subtaskId`. Each piece gets its record (a legacy one is adopted), versionTarget/mergeSha/tag/repo, goes to ci and then to publicado as soon as the tag `v<version>` exists and the release.yml run that produced it is green — read by the server from the TAG, not from the sha — with the release's own publish time; a declared piece is never sent back to revisao_lider by the tick (a red tag run keeps it in ci and wakes the leader once); done/abandoned/blocked/unknown/other-task pieces refuse the whole batch, which is written in ONE store write; a second run changes nothing). In autonomous mode nothing here ever asks or waits for the owner.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "phase", "gate", "block", "unblock", "dequeue", "tick", "step", "configure", "approve", "stage-run", "merge", "release", "reconcile", "antigas"] },
        antigasAction: { type: "string", enum: ["publish", "archive", "conclude"], description: "antigas: 'conclude' (the screen's one click) completes the pieces with a session and archives the ones without; add `preview` to read the counts without changing anything. 'publish' marks the old record-less pieces published (optional `version`), 'archive' abandons them with an optional `reason`. Targets: `subtaskIds`, or `all` = every piece the reconcile classifies as antiga. Never deletes; a leader or the owner" },
        preview: { type: "boolean", description: "antigas conclude: only count what the click would do (concluded vs archived); changes nothing" },
        all: { type: "boolean", description: "antigas: act on every old piece in the group \"Antigas sem registro\" (answers from the board at once; a piece the last reconcile proved is left out)" },
        expect: { type: "number", description: "antigas: the size of the group you saw; a different size refuses (409 count_changed) and nothing changes" },
        apply: { type: "boolean", description: "reconcile: write the moves (a leader of the task, or the owner). Absent/false = dry run: the report only" },
        subtaskId: { type: "string" },
        version: { type: "string", description: "release: the version the pieces shipped in, x.y.z" },
        mergeSha: { type: "string", description: "release: the commit on main that carries the release (information only: stored on the record; a short sha is resolved to 40 characters or refused). The publication evidence is the version tag's own green release.yml run" },
        repo: { type: "string", description: "release: the repository owner/name the release belongs to (default agentistics/agentistics); recorded on every piece, the release gate reads it there" },
        subtaskIds: { type: "array", items: { type: "string" }, description: "release: every subtask in the release" },
        to: { type: "string", enum: ["executando", "qa", "ajuste", "revisao_lider", "pr_merge", "ci", "publicado"] },
        verdict: { type: "string", enum: ["APROVADO", "REPROVADO"] },
        findings: { type: "string" },
        reviewedSha: { type: "string" },
        detail: { type: "string" },
        name: { type: "string", enum: ["predispatch", "vaga", "salvo", "qa-modelo", "cabeca", "delecoes", "mergeado", "release"] },
        phase: { type: "string", description: "approve: the phase whose human gate is answered" },
        decision: { type: "string", enum: ["approve", "reject"] },
        note: { type: "string" },
        reason: { type: "string", description: "dequeue: required free-text audit reason (leader only); block: dependencia | pedido_de_bloqueio | limite | maquina | externo | fora_das_autorizacoes; antigas archive: why (kept in the comment)" },
        text: { type: "string" },
        step: { type: "number" },
        patch: { type: "object" },
      },
      required: [],
    },
  },
  {
    name: "agentistics_task_stage",
    description:
      "Placement is deterministic: a queued piece of the same task sharing a file, area tag or UI surface is returned as an `encaixe` warning so you can extend that brief or group the pieces. Withdrawn pieces are excluded. " +
      "FLUXO.ENTREGA-DSL pre-dispatch — write the STAGED SESSION on a subtask (prompt/brief, harness, model, effort, account, cwd) and open its delivery in `fila` (\"Na fila\"). A leader receiving a request from the owner stages it in the SAME turn: the demand flow reminds the leader (never the owner) after 10 minutes of an owner request with no staged subtask. The fields merge over what the subtask already holds, and the predispatch gate is checked right away (the reply says what is still missing). Nothing starts here — `agentistics_task_phase action=stage-run` starts it once the vaga gate passes. `pedidoId` links the owner request this answers.",
    inputSchema: {
      type: "object",
      properties: {
        subtaskId: { type: "string" },
        prompt: { type: "string" },
        harness: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        account: { type: "string" },
        cwd: { type: "string" },
        versionTarget: { type: "string" },
        pedidoId: { type: "string" },
      },
      required: ["subtaskId"],
    },
  },
  {
    name: "agentistics_task_queue",
    description:
      "FILA.PRIORIDADE — read the delivery QUEUE (\"Na fila\") exactly as the task page's Fila tab shows it, from the same source, in the order pieces LEAVE: the task's priority (urgent → low), then arrival. " +
      "Each item: `position` (in its task) and `globalPosition`, `priority`, the subtask/group (with `group.members`), the full PRE-DISPATCH (`predispatch`: harness, model, effort, account and its name, cwd, prompt), the slot gate's last verdict (`slot`; ok=false carries the raw reason such as `no slot: 4 workers running (machine ceiling 4)`), " +
      "`hold` (the leader said `nao <motivo>` or `agendar <ISO> <motivo>`: kind, reason, until, who, `active`), `ask` (the system question to the leader: when, delivered, approved, `expiresAt` = 10 min, `onTimeout` = `sim` with autonomous mode on, `esperar` with it off), the leader, and the subtask's notes (`notes.last` the newest 3, `notes.total`). " +
      "`recent` lists pieces the queue opened in the last 24 h with the session they opened. Pass `taskId` for one task's queue. To change the order, change the TASK's priority with `agentistics_task_edit`; to edit a piece's pre-dispatch use `agentistics_task_stage`; to start now / schedule / answer use `agentistics_task_queue_answer`; to withdraw use `agentistics_task_phase action=dequeue`.",
    inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Only this task's queued pieces. Omit for every task." } }, required: [] },
  },
  {
    name: "agentistics_task_queue_answer",
    description:
      "FILA.PRIORIDADE — answer the queue's SYSTEM QUESTION (the message headed `[from flow fila · confirmar]` that arrives in a leader's composer when a slot opens and its piece is next), or act on a queued piece from the Fila tab. Leader of the task or owner only. " +
      "`answer` is one of: `sim` (open the session now — if no slot is free right now the approval is kept and the next tick starts it; never opens twice), `nao <motivo>` (the piece stays queued with the reason on its card; the flow moves on to the next one), `agendar <ISO> <motivo>` (stays queued, becomes a candidate again only from that FUTURE instant, shown on the card as `começa às HH:MM`). " +
      "A `nao` or `agendar` without a reason, and an `agendar` in the past, are refused with a sentence. Every decision is recorded as a comment on the subtask (who, why, when). With no answer in 10 minutes: autonomous mode ON → the flow carries on as `sim` and records it; OFF → it keeps waiting and reminds you. " +
      "Set `runNow: true` instead of `answer` to run the queue flow once right now (what happens automatically when a worker ends and every minute).",
    inputSchema: {
      type: "object",
      properties: {
        subtaskId: { type: "string" },
        answer: { type: "string", description: "`sim` | `nao <motivo>` | `agendar <ISO> <motivo>`" },
        runNow: { type: "boolean", description: "Run the queue flow now instead of answering." },
      },
      required: [],
    },
  },
  {
    name: "agentistics_session_groups",
    description:
      "List the user's SESSION GROUPS — the named folders in the Sessions sidebar (\"Saved to later\", \"Pelvie\", …) — with the sessions in each. A group is how a person keeps a fleet of assistants organised; every session belongs to at most one. Each member carries its `id` (the managed session id you can pass to the other tools), `title`, `state` and `harness` when the session is on this machine right now, or only its `key` when it is gone. Call this BEFORE creating a group, so you file a session under an existing one instead of making a near-duplicate.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "agentistics_session_group_create",
    description:
      "Create a session group, optionally filing sessions into it in the same call. Use it to keep the assistants you start organised: start a session (for example `agentop session start …`, which prints its id), then create or reuse a group and file it. `sessions` takes session REFERENCES — a managed id (the `agentop-…` id `agentistics_session_groups` and `agentop session ls` print), a conversation id, an exact title, or a unique id prefix; any reference that matches nothing or more than one refuses the WHOLE call (404 / 409) and creates nothing, so a group is never half-filled. Filing moves a session out of any other group and unpins it if it was pinned. Duplicate group names are allowed, but they make later calls ambiguous — check `agentistics_session_groups` first and reuse a group when one fits.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The group's name. Must not be blank." },
        sessions: { type: "array", items: { type: "string" }, description: "Session references to file into the new group." },
      },
      required: ["name"],
    },
  },
  {
    name: "agentistics_session_group_edit",
    description:
      "Change a session group. `action` is one of: `add` — file `session` under `group` (moves it out of any other group, unpins it if pinned); `remove` — take `session` out of whichever group holds it (the session itself is untouched); `rename` — give `group` a new `name`; `delete` — delete `group` (its sessions are NOT deleted, they only leave it). `group` is a group id OR its exact name (case-insensitive); a name shared by two groups answers 409 with the ids, so use the id. `session` is a managed id, a conversation id, an exact title or a unique id prefix. Refusals name what was wrong: 404 for a group or session that matches nothing, 409 for an ambiguous one, 400 for a blank name or a missing argument.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "rename", "delete"] },
        group: { type: "string", description: "A group id or name. Required for add, rename and delete." },
        session: { type: "string", description: "A session reference. Required for add and remove." },
        name: { type: "string", description: "The new name. Required for rename." },
      },
      required: ["action"],
    },
  },
  {
    name: "agentistics_session_notify",
    description:
      "Switch a session's notifications on or off, or read the switch. `ref` is a managed id, a conversation id, an exact title or a unique id prefix. With `notify` ('on' | 'off') it sets the switch; with `ref` alone it reads it. Muting removes the INTERRUPTION only (bell, Nay card, sound, desktop toast, peer message): the session still shows as waiting and its events are still recorded in the inbox. The mute follows the conversation, so it survives a reopen. 404 for a ref that matches nothing, 409 for an ambiguous one.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A session reference." },
        notify: { type: "string", enum: ["on", "off"], description: "Set the switch. Omit to read it." },
      },
      required: ["ref"],
    },
  },
  {
    name: "agentistics_session_message",
    description:
      "Send a message to ANOTHER agentistics session — the standard channel between a session and the one that started it (or the ones it started). `to` is a session reference (managed id, conversation id, exact title or unique id prefix); `kind` is handback (work finished/committed), block (you cannot continue) or question (you need a decision); `body` is the text. It is typed into the target's own conversation through the same path its composer uses, headed `[from session <id> · <kind>]`, and — when YOUR session is filed on a task or subtask — also recorded there as a comment of that kind. Use it to report to the session that started you instead of asking the user; a parent may message its children the same way. Refused for a session that does not exist, for yourself, from a process that is not a verified agentop session, and more than once per 2 seconds to the same session. INTERMEDIATE handback: a handback is read by the runtime as \"I finished everything\" (the product may close you once you are stopped, clean and saved). If you stop on purpose between phases, waiting for a signal, pass `awaiting` (kind=handback only, one line ≤200 chars, e.g. \"engine merged <sha>\"): the runtime then refuses to close you while that is your newest handback. A later handback WITHOUT `awaiting` counts as final again.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The target session reference." },
        kind: { type: "string", enum: ["handback", "block", "question"] },
        body: { type: "string", description: "The message." },
        awaiting: { type: "string", description: "kind=handback only: what you stopped waiting for (marks the handback as intermediate: the worker is not closed, your subtask stays in_progress and the leader's check-in does not list it as delivered). A text that says it is part N of M (\"parte 2 de 5\", \"2/5\", \"seguindo com…\") with no awaiting is read the same way, and the reply tells you so. Omit on the FINAL handback." },
      },
      required: ["to", "kind", "body"],
    },
  },
  {
    name: "agentistics_wait",
    description:
      "EXPERIMENTAL (AGENTISTICS_FLOWS) — a DURABLE wait the SERVER keeps for YOU: instead of polling or running a background command, register what you wait for and a deadline; when the condition is met (or the deadline passes, once) the server types a wake message into your own session, headed `[from flow wait · nudge]`, naming the wait id and generation. Conditions are a closed set: `{kind:'handback', from:<session id>, since?:ISO, match?:text}` (a handback FROM that session; `match` = case-insensitive substring its text must contain, so another subject does not wake you), `{kind:'memory', minAvailableMB}` (free memory, two stable readings), `{kind:'time', at:ISO}`, `{kind:'gate', gate:'sessao-parada'|'arvore-limpa'|'trabalho-salvo', sessionId}`. action=register needs `condition` + `deadlineAt` (ISO UTC, ≤30 days; pass `requestId` to make a retry the same wait); action=ack (`waitId`, `generation`) confirms you RECEIVED the wake — without it the wake is sent again (at most 3 times), so ack every wake, and treat a repeated wake for the same id+generation as already handled; action=cancel (`waitId`) before it fires; action=list your open waits; action=handoff (`from`: the previous leader on the same task) moves its waits to you. A wait is never 'working' nor an approval.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["register", "cancel", "ack", "list", "handoff"] },
        condition: { type: "object", description: "register: the condition (closed set, see the description)." },
        deadlineAt: { type: "string", description: "register: ISO UTC deadline; the wake fires once when it passes without the condition." },
        label: { type: "string", description: "register: one short line shown as 'aguardando <label> até <deadline>'." },
        requestId: { type: "string", description: "register: optional idempotency key; the same key returns the same wait." },
        reopen: { type: "boolean", description: "register: if you have ended when it fires, may the server reopen you (only when the host supports it)? Otherwise your leader is told." },
        waitId: { type: "string", description: "cancel/ack: the wait id." },
        generation: { type: "number", description: "ack: the generation named in the wake message." },
        from: { type: "string", description: "handoff: the previous leader's session id." },
        all: { type: "boolean", description: "list: include finished waits." },
      },
      required: ["action"],
    },
  },
  {
    name: "agentistics_session_role",
    description:
      "Get or set a session's ROLE (leader | worker | auto). With no `ref` it is YOUR OWN session. Setting `leader` stores the role, renames the session to \"[ LEADER ] - <title>\" (\"[ LÍDER ] - …\" in a Portuguese UI) keeping the user's title, and the briefing then tells the model it is a leader; `worker`/`auto` strip the prefix. Use it to declare yourself leader when the work grows to several fronts — do not rename the session by hand. Setting ANOTHER session's role works only for sessions you started yourself. Idempotent. With no `role` it just reports the current one and the role line.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A session reference (managed id, conversation id, exact title or unique id prefix). Omit for your own session." },
        role: { type: "string", enum: ["leader", "worker", "auto"], description: "The role to set. Omit to read it." },
        retirePredecessor: { type: "string", description: "A leader taking over can pass the previous leader on the SAME task (managed id, conversation id, exact title or unique id prefix); the server closes it when it goes quiet. Only for your own session declared leader; otherwise the role still changes and the reply says why the retire was refused." },
      },
      required: [],
    },
  },
  {
    name: "agentistics_session_switch_account",
    description:
      "Continue a session on ANOTHER account — of its own harness or of another harness (multiple accounts must be on). Use it when a session hit its account's usage limit and another account has room. With no `accountId` it lists every account the session can move to, each with its `harness` (its own harness's other accounts first, then every other harness that can start a session here; the recommended one per harness from the plan router) and whether its last turn stopped on a usage limit. With `accountId` and no `harness` (or its own harness) it ends the session, copies its conversation to that account (never moves it) and resumes the SAME conversation there — Claude Code and Codex only. With `harness` set to ANOTHER harness it starts a NEW session there in the same folder, task, subtask and role, briefed with a summary of the conversation, and ends the old one only after the new one is running (a failure leaves the old one untouched). The new id is returned. `resendPending: true` re-sends, once, the message the limit refused. An account that is off for agents, removed or signed out is refused in words.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The session: managed id or conversation id." },
        accountId: { type: "string", description: "The target account id (acc_…). Omit to list the options." },
        harness: { type: "string", description: "The target harness (claude, codex, gemini, copilot, antigravity, kimi, opencode). Omit = the session's own harness." },
        resendPending: { type: "boolean", description: "Re-send the message the usage limit refused, once." },
      },
      required: ["ref"],
    },
  },
  {
    name: "agentistics_session_away",
    description:
      "Read or switch AUTONOMOUS MODE, or send the owner a notice while autonomous — the fleet works on its own, without asking permission or questions (the owner may be asleep or travelling). While it is on, every new session is born in the no-questions approval mode unless its caller names a mode. With no `on` it reports the state (`active`, `until`, what is pre-authorised). With `on: true` it switches it on: `until` is an ISO instant (omit = until the owner says they are back), `authorised` lists what the owner pre-approved (releases = publish releases the leader approved; workers = open worker sessions within the plan limits; merges = merge PRs the leader reviewed), `note` is free text. `schedule` makes it SCHEDULED instead of open-ended: `{enabled:true, days:{mon:{windows:[{from:\"09:00\",to:\"18:00\"}]}, tue:{windows:[],allDay:true}}}` (local clock, weekdays mon…sun, hour windows per day, `allDay` = whole day) — it is on only inside those windows. Omitted `authorised` = all three. `on: false` switches it off. Every session started while it is active is told in its briefing. With `target` (a session's managed id or conversation id) `on` switches THAT session's own autonomous mode instead — it alone is told the owner is out, even with the global switch off, and a running one is told the change; sessions it starts inherit it. Ceilings are per PROVIDER: `topCaps` maps a harness (claude, codex, gemini, copilot, antigravity, kimi, opencode) to how many workers may run on its top model tier at once. Only a LEADER session may switch it; use it when the owner tells you they are leaving or are back.",
    inputSchema: {
      type: "object",
      properties: {
        on: { type: "boolean", description: "true = autonomous mode on, false = off. Omit to read." },
        until: { type: "string", description: "ISO instant the autonomous period ends. Omit for 'until I turn it off'." },
        authorised: { type: "array", items: { type: "string", enum: ["releases", "workers", "merges"] } },
        note: { type: "string", description: "Free text from the owner (max 500 chars)." },
        schedule: { type: "object", description: "Optional agenda: {enabled:true, days:{<mon|tue|wed|thu|fri|sat|sun>:{windows:[{from:'HH:MM',to:'HH:MM'}], allDay?:true}}}. Autonomous mode is on only inside the windows (machine-local time; to<=from crosses midnight). Omit for 'until I turn it off'." },
        maxWorkers: { type: "number", description: "Ceiling of worker sessions at once while autonomous (default 4)." },
        topCaps: { type: "object", additionalProperties: { type: "number" }, description: "Per provider (harness id → number): ceiling of workers on that provider's top model tier at once (Opus, top GPT tier, Gemini Pro, …). A provider with no entry gets 1." },
        target: { type: "string", description: "A session's managed id or conversation id: switch only that session's own autonomous mode (with `on`)." },
        notice: { type: "string", description: "While autonomous: a warning or decision that cannot wait, sent to the owner's bell/Nay as a notice (max 500 chars) instead of a question that blocks your turn. Leaders only; ignores the other fields." },
      },
      required: [],
    },
  },
  {
    name: "agentistics_checkin_report",
    description: "Report the leadership check-in round. The owner reads it and is NOT technical: every field is a short plain-language sentence naming things by what they do — no session ids, commit hashes, PR numbers, ports, limit percentages or internal codenames unless the owner must act on one; a health row only when something needs attention, said in words. Include a concise headline (<=140 chars), delivered items, in-progress items with stage and expected release, next steps, and health rows (sessions/memory, limits, releases, MCP, handoff). Keep summary as the fallback for older/short rounds. The server records the round, updates the agenda, and adds a checkin activity event to the filed task.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["ok", "resolved", "needs_you"] },
        summary: { type: "string" },
        headline: { type: "string", maxLength: 140, description: "One-line headline, at most 140 characters." },
        delivered: { type: "array", items: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" } }, required: ["text"] } },
        inProgress: { type: "array", items: { type: "object", properties: { item: { type: "string" }, stage: { type: "string" }, release: { type: "string" }, session: { type: "string" } }, required: ["item", "stage"] } },
        next: { type: "array", items: { type: "object", properties: { text: { type: "string" }, when: { type: "string" } }, required: ["text"] } },
        health: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, state: { type: "string", enum: ["ok", "warn", "bad"] } }, required: ["label", "value", "state"] } },
        actions: { type: "array", items: { type: "object", properties: { text: { type: "string" }, link: { type: "object" } }, required: ["text"] } },
        needs: { type: "array", items: { type: "object", properties: { subject: { type: "string" }, text: { type: "string" }, critical: { type: "boolean" }, link: { type: "object" } }, required: ["subject", "text"] } },
      },
      required: ["state", "summary"],
    },
  },
  {
    name: "agentistics_summary",
    description:
      "Get an overview of AI coding usage metrics (across all tracked harnesses — Claude Code, Codex, Gemini, Copilot, Antigravity — or scoped to one): total tokens, estimated cost, sessions, streak, most used model, and top project. Good starting point for any metrics question.",
    inputSchema: { type: "object", properties: { harness: HARNESS_PARAM }, required: [] },
  },
  {
    name: "agentistics_harnesses",
    description:
      "Compare the tracked AI coding harnesses side by side. Lists every harness present in the data with its sessions, messages, token usage, estimated cost, and last-active date. Use this to answer 'which harness do I use most / costs most' questions. Rows tagged source \"projections\" (read from the journal) carry personTurns (the person's turns); there `messages` is a deprecated alias of personTurns, and subagent spend is reported apart (subagentTokens, subagentCostUSD).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "agentistics_plan_limits",
    description: "Read this BEFORE opening sessions; follow the recommendation; a plan on hold gets no new worker. Returns subscription budgets, pacing, and a routing recommendation.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["lead", "hard-bug", "design", "spec-impl", "mechanical", "qa", "probe"] },
        authorHarness: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "agentistics_benchmark_observed",
    description:
      "The Benchmark's observed history, read-only and identical to the Benchmark page: cost per delivery, time to publish, active time, deliveries per week, coordination range, QA rejection and rounds, escaped defects and wasted cost, each with n, a 95% interval, the named gaps that kept records out and its origin. Observed and biased, never a verdict; a null value is not measured, not zero. Optional from/to (epoch ms or ISO date) restrict the period by publication/reference date.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: ["string", "number"], description: "Start of the period (ISO date or epoch ms)" },
        to: { type: ["string", "number"], description: "End of the period (ISO date or epoch ms)" },
      },
      required: [],
    },
  },
  {
    name: "agentistics_projects",
    description:
      "List projects with session counts, message counts, token usage, estimated cost, and last active date. Optionally scope to a single harness. Rows tagged source \"projections\" (read from the journal) carry personTurns (the person's turns); there `messages` is a deprecated alias of personTurns, and subagent spend is reported apart (subagentTokens, subagentCostUSD).",
    inputSchema: { type: "object", properties: { harness: HARNESS_PARAM }, required: [] },
  },
  {
    name: "agentistics_sessions",
    description:
      "Get the most recent sessions with harness, project path, duration, message count, token usage, and model. Optionally scope to a single harness. With AGENTISTICS_FLOWS on, a worker that handed back and is still open carries `deliveredStillOpen` ({managedId, handbackAt, lastRun?}): close it with agentistics_flow_run name=fechar-entregue {sessionId: managedId}, which only closes it when stopped, clean and saved.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max sessions to return (default 20, max 50)",
        },
        harness: HARNESS_PARAM,
      },
    },
  },
  {
    name: "agentistics_costs",
    description:
      "Get cost breakdown by model: token counts (input/output/cache read/write) and estimated USD cost per model. Scope to a single harness, or 'all' (default) for the unified breakdown.",
    inputSchema: { type: "object", properties: { harness: HARNESS_PARAM }, required: [] },
  },
  {
    name: "agentistics_component_catalog",
    description:
      "List all components available for the custom layout page, with IDs, categories, descriptions, and default grid sizes. Call this before building or modifying a layout.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Filter by category: kpi, activity, costs, projects, tools, sessions",
        },
      },
    },
  },
  {
    name: "agentistics_get_layouts",
    description:
      "Get all custom layouts: names, components in each, which is active, and each component's instance ID for removal.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "agentistics_get_preferences",
    description: "Read the Nay persona preferences (chatResponder, chatWorkingDir, chatLabel and chatMcpEnabled).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "agentistics_set_preferences",
    description: "Set Nay persona preferences. chatWorkingDir must be an existing absolute directory; the server canonicalises and validates it.",
    inputSchema: {
      type: "object",
      properties: {
        chatResponder: { type: "string", enum: ["analytics", "own-agent"] },
        chatWorkingDir: { type: "string" },
        chatLabel: { type: "string" },
        chatMcpEnabled: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentistics_create_layout",
    description: "Create a new empty named layout on the custom page.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the new layout" },
      },
      required: ["name"],
    },
  },
  {
    name: "agentistics_add_component",
    description:
      "Add a single component to a layout. Use agentistics_component_catalog to get valid componentId values. Positioned automatically at the bottom of the grid unless x/y are given.",
    inputSchema: {
      type: "object",
      properties: {
        layoutName: {
          type: "string",
          description:
            "Target layout name. Omit to use the currently active layout.",
        },
        componentId: {
          type: "string",
          description:
            "Component ID from the catalog (e.g. 'kpi.cost', 'activity.chart')",
        },
        x: {
          type: "number",
          description: "Column (0–11). Optional — auto-placed if omitted.",
        },
        y: {
          type: "number",
          description: "Row. Optional — auto-placed if omitted.",
        },
        w: {
          type: "number",
          description: "Width in grid units (1–12). Optional — uses default.",
        },
        h: {
          type: "number",
          description: "Height in grid units. Optional — uses default.",
        },
      },
      required: ["componentId"],
    },
  },
  {
    name: "agentistics_remove_component",
    description:
      "Remove a component from a layout by its instance ID (the 'instanceId' field from agentistics_get_layouts).",
    inputSchema: {
      type: "object",
      properties: {
        layoutName: {
          type: "string",
          description: "Layout name. Omit to use the active layout.",
        },
        itemId: {
          type: "string",
          description: "Instance ID of the item to remove",
        },
      },
      required: ["itemId"],
    },
  },
  {
    name: "agentistics_set_active_layout",
    description: "Switch the active layout shown on the /custom page.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the layout to activate" },
      },
      required: ["name"],
    },
  },
  {
    name: "agentistics_delete_layout",
    description: "Delete a named layout. Cannot delete the last remaining layout.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the layout to delete" },
      },
      required: ["name"],
    },
  },
  {
    name: "agentistics_export_pdf",
    description:
      "Generate a PDF report of Claude Code usage. Returns a URL that, when opened in a browser, automatically opens the PDF export modal pre-configured with the requested options. The user can review settings and click Download to save the PDF.",
    inputSchema: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["7d", "30d", "90d", "all"],
          description: "Date range for the report (default: all)",
        },
      },
    },
  },
  {
    name: "agentistics_build_layout",
    description:
      "Build a complete layout in one call: creates it, adds all requested components with auto-positioning, and optionally activates it. Ideal for setting up a themed dashboard from scratch.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the layout" },
        componentIds: {
          type: "array",
          items: { type: "string" },
          description: "Ordered array of component IDs to add",
        },
        activate: {
          type: "boolean",
          description:
            "Set as active layout after building (default true)",
        },
      },
      required: ["name", "componentIds"],
    },
  },
  {
    name: "agentistics_tags",
    description:
      "List all tags — saved cross-cutting filters over repos/projects/machines/teams/accounts — with their aggregate sessions, cost, and tokens. Use for 'what tags exist' or 'how much did tag X cost' questions.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "agentistics_vault_status",
    description:
      "How this machine's vault is protected — never what it holds. Returns the state (open/locked/uninitialized…), the ways to confirm it is you already in use (touchid = Touch ID or the Mac password, hello = Windows Hello, password = the vault's own password, fido2 = a security key), the ways this machine offers (a security key only when its tools are present, marked advanced), whether an old app-code record is still on disk (it is no longer asked; it is deleted once a way to confirm is chosen), whether the 24-word recovery key exists, the auto-lock minutes, and the vault-password rules (the same table the page and the server enforce). Setting up, unlocking and confirming are the person's: on the /vault page or with `agentop vault` — never pass a vault password or recovery words through a tool.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "agentistics_tag_detail",
    description:
      "Get full detail for one tag by name or id: aggregate totals plus per-source breakdown and distributions (top projects, models, harnesses, repos), daily activity series, and the active date window. Call agentistics_tags first to find the id/name.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Tag name or id, from agentistics_tags" },
      },
      required: ["tag"],
    },
  },
  {
    name: "agentistics_repos",
    description:
      "List repositories, grouped by normalized git remote (independent of local path or which machine produced the session), with session/message/token/cost totals and last-active date. Sessions with no linked repository are grouped under 'unlinked'. Optionally scope to a single harness. Rows tagged source \"projections\" (read from the journal) carry personTurns (the person's turns); there `messages` is a deprecated alias of personTurns, and subagent spend is reported apart (subagentTokens, subagentCostUSD).",
    inputSchema: { type: "object", properties: { harness: HARNESS_PARAM }, required: [] },
  },
  {
    name: "agentistics_flow_run",
    description: "Run an official deterministic flow. Flows are experimental and read-only host operations; the server refuses when AGENTISTICS_FLOWS is off or the official engine is absent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Built-in flow name, for example worker-checar or limpeza." },
        inputs: { type: "object", description: "Optional flow inputs." },
      },
      required: ["name"],
    },
  },
  {
    name: "agentistics_flow_status",
    description: "Read the durable status of an official deterministic flow run.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", description: "Flow run id returned by agentistics_flow_run." } },
      required: ["runId"],
    },
  },
  {
    name: "agentistics_book_takeover",
    description: "Confirm a real successor's takeover of a task through the hand-off book. The MCP server attaches this session's proof automatically; never provide a token.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task whose passage this successor is confirming." },
        bookmarkHash: { type: "string", description: "Bookmark hash from the successor spawn prompt." },
        lastDeltaHash: { type: "string", description: "Required after the server's 409 challenge." },
      },
      required: ["taskId", "bookmarkHash"],
    },
  },
];

/** Exported for the session-context parity test; the live list remains the single MCP registry. */
export const MCP_TOOL_NAMES = TOOLS.map(tool => tool.name)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = toolsForGate(TOOLS, await nativeVisibleNow());
  const flowsOn = await flowsVisibleNow();
  return { tools: flowsOn ? tools : tools.filter(tool => !tool.name.startsWith("agentistics_flow_")) };
});

// The local agent audit (spec §4.6, P1.2): every W/D call is one line, R calls are counted per
// hour. It records ids and outcome codes only — never an argument value — and a failed write never
// fails the call it describes (`agent-audit.ts`).
const audit = createAgentAuditSink();
process.on("exit", () => audit.flush());
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { audit.flush(); process.exit(0); });
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const result = await callTool(req);
  const first = result.content?.[0];
  audit.recordCall({
    name: req.params.name,
    args: req.params.arguments,
    client: server.getClientVersion(),
    naySession: process.env.AGENTISTICS_NAY_SESSION,
    result: {
      isError: result.isError === true,
      errorText: first && first.type === "text" ? first.text : undefined,
    },
  });
  return result;
});

async function callTool(req: { params: { name: string; arguments?: Record<string, unknown> } }) {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      // ------------------------------------------------------------ the ALM (task board)
      case "agentistics_tasks": {
        const body = await apiGet("/api/tasks");
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task": {
        const ref = String((args as any)?.ref ?? "");
        const body = await apiGet(`/api/tasks/${encodeURIComponent(ref)}`);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_flow_run": {
        const a = args as any;
        const body = await apiSend("POST", "/api/flows/run", {
          name: a?.name,
          session: sessionProof(process.env),
          ...(a?.inputs && typeof a.inputs === "object" ? { inputs: a.inputs } : {}),
        });
        return text(body);
      }
      case "agentistics_flow_status": {
        const runId = String((args as any)?.runId ?? "");
        const body = await apiGet(`/api/flows/status/${flowStatusRunId(runId)}`);
        return text(body);
      }
      case "agentistics_book_takeover": {
        const a = args as any;
        const response = await fetch(`${API}/api/book/takeover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bookTakeoverPayload(a, sessionProof(process.env))),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 409) throw new Error(`POST /api/book/takeover → HTTP ${response.status} ${JSON.stringify(body).slice(0, 400)}`);
        return text(body);
      }
      case "agentistics_task_create": {
        const a = args as any;
        const body = await apiSend("POST", "/api/tasks", {
          title: a?.title,
          detail: a?.detail,
          ...(typeof a?.priority === "string" ? { priority: a.priority } : {}),
          ...(typeof a?.type === "string" ? { type: a.type } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_status": {
        const a = args as any;
        const body = await apiSend("POST", `/api/tasks/${encodeURIComponent(String(a?.ref))}`, {
          status: a?.status,
          ...(a?.allowOpenSubtasks === true ? { allowOpenSubtasks: true } : {}),
          ...(typeof a?.actor === "string" ? { actor: a.actor } : {}),
          ...(typeof a?.reason === "string" ? { reason: a.reason } : {}),
          ...(Array.isArray(a?.blockedBy) ? { blockedBy: a.blockedBy } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_statuses": {
        const body = await apiGet("/api/tasks/statuses");
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_types": {
        const body = await apiGet("/api/tasks/types");
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_type_edit": {
        const a = args as any;
        const id = typeof a?.id === "string" && a.id ? a.id : null;
        if (id && a?.remove === true) {
          const body = await apiSend("DELETE", `/api/tasks/types/${encodeURIComponent(id)}`);
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        const payload = {
          ...(typeof a?.label === "string" ? { label: a.label } : {}),
          ...(typeof a?.color === "string" ? { color: a.color } : {}),
        };
        const body = id
          ? await apiSend("POST", `/api/tasks/types/${encodeURIComponent(id)}`, payload)
          : await apiSend("POST", "/api/tasks/types", payload);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_status_edit": {
        const a = args as any;
        const id = typeof a?.id === "string" && a.id ? a.id : null;
        if (id && a?.remove === true) {
          const body = await apiSend("DELETE", `/api/tasks/statuses/${encodeURIComponent(id)}`);
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        const payload = {
          ...(typeof a?.label === "string" ? { label: a.label } : {}),
          ...(typeof a?.color === "string" ? { color: a.color } : {}),
        };
        const body = id
          ? await apiSend("POST", `/api/tasks/statuses/${encodeURIComponent(id)}`, payload)
          : await apiSend("POST", "/api/tasks/statuses", payload);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_comment": {
        // The route stays LITERAL here: agentToolPolicy.lint reads each handler's routes off this source.
        const body = await apiSend("POST", `/api/tasks/${encodeURIComponent(String((args as any)?.ref))}/comments`,
          taskCommentRequest(args, sessionProof(process.env)).payload);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_subtask": {
        const a = args as any;
        // A bare `{id, done}` is the tick; naming any column makes it an edit. The route keeps
        // `done` and `status` in step, so a caller may send either.
        // `sessionId` is deliberately NOT here: a subtask holds any number of sessions and the
        // link lives on the SESSION (`agentistics_task_session` with `subtaskId`). Editing a
        // one-session field beside that would be a second, unreconciled answer to the same question.
        // `parentGroupId` is here too (§F.1: joining/leaving a group) — it is typed as a plain
        // string in the tool schema, with `""` meaning "leave", so it matches the same
        // `typeof === "string"` filter as every other column and needs no special casing.
        const cols = ["status", "dueDate", "startDate", "title", "parentGroupId"] as const;
        const named = cols.filter(c => typeof a?.[c] === "string");
        // `blockedBy` is an ARRAY, so it never matches the string-valued `cols` filter above and
        // was silently dropped — a subtask genuinely can be blocked by a sibling (`Subtask.blockedBy`,
        // enforced server-side in `patchSubtask`/`task-attach.ts`), this tool just never offered it.
        const blockedBy = Array.isArray(a?.blockedBy) ? { blockedBy: a.blockedBy } : {};
        // `done` beside a named column used to be DROPPED with an ok answer, so a leader that sent
        // `{id, title, done: true}` believed it had closed a piece that stayed in review. The route
        // derives `done` from `status`, so `done` is translated into `status` here: true -> "done",
        // false -> "todo" (the same transition the bare tick makes). A `status` that contradicts it is
        // REFUSED, never half-applied. The route validates group membership against the post-patch state, so
        // `parentGroupId` + done is two writes in order: join first, then close.
        const wantsDone = typeof a?.done === "boolean" ? (a.done as boolean) : undefined;
        const doneStatus = wantsDone === undefined ? undefined : wantsDone ? "done" : "todo";
        if (a?.id !== undefined && doneStatus !== undefined && named.length > 0 && typeof a?.status === "string" && (wantsDone ? a.status !== "done" : a.status === "done")) {
          throw new Error(`agentistics_task_subtask: done=${wantsDone} conflicts with status="${a.status}" — send one of them (status "${doneStatus}" is what done=${wantsDone} means).`);
        }
        const edit = (withStatus: boolean, omit: string[] = []) => ({
          id: a.id,
          ...Object.fromEntries(named.filter(c => !omit.includes(c) && (c !== "status" || withStatus)).map(c => [c, a[c]])),
          ...(withStatus && doneStatus !== undefined && typeof a?.status !== "string" ? { status: doneStatus } : {}),
          ...blockedBy,
        });
        const joining = a?.id !== undefined && doneStatus !== undefined && typeof a?.parentGroupId === "string" && a.parentGroupId !== "";
        if (joining) {
          // Join first (the route checks membership against the post-patch state), then close.
          const path = `/api/tasks/${encodeURIComponent(String(a?.ref))}/subtasks`;
          await apiSend("POST", path, edit(false));
          const body = await apiSend("POST", path, { id: a.id, status: typeof a?.status === "string" ? a.status : doneStatus });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        const payload = a?.id !== undefined
          ? (named.length > 0 || Array.isArray(a?.blockedBy)
            ? edit(true)
            : { id: a.id, done: a?.done === true })
          // `isGroup: true` creates a GROUP (§F.1) instead of an ordinary subtask — creation only,
          // `addSubtask` offers no way to change it afterwards.
          : { title: a?.title, ...(a?.isGroup === true ? { isGroup: true } : {}) };
        const body = await apiSend("POST", `/api/tasks/${encodeURIComponent(String(a?.ref))}/subtasks`, payload);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_link": {
        const a = args as any;
        const payload = a?.remove
          ? { remove: a.remove }
          : { url: a?.url, label: a?.label, kind: a?.kind };
        const body = await apiSend("POST", `/api/tasks/${encodeURIComponent(String(a?.ref))}/links`, payload);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_blocked_by": {
        const a = args as any;
        const body = await apiSend("POST", `/api/tasks/${encodeURIComponent(String(a?.ref))}`, {
          blockedBy: a?.blockedBy ?? [],
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_next": {
        const a = args as any;
        const q = new URLSearchParams();
        if (a?.actor) q.set("actor", String(a.actor));
        if (a?.limit) q.set("limit", String(a.limit));
        const body = await apiGet(`/api/tasks/next${q.toString() ? `?${q}` : ""}`);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_claim": {
        const a = args as any;
        const ref = encodeURIComponent(String(a?.ref ?? ""));
        const body = await apiSend("POST", `/api/tasks/${ref}/claim`, {
          by: a?.by,
          ...(a?.release === true ? { release: true } : {}),
          ...(a?.leaseMs !== undefined ? { leaseMs: a.leaseMs } : {}),
          ...(a?.sessionId ? { sessionId: a.sessionId } : {}),
          ...(a?.note ? { note: a.note } : {}),
          ...(a?.takeover === true ? { takeover: true } : {}),
          ...(a?.force === true ? { force: true } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_activity": {
        const a = args as any;
        const q = new URLSearchParams();
        if (a?.ref) q.set("task", String(a.ref));
        if (a?.limit) q.set("limit", String(a.limit));
        const body = await apiGet(`/api/tasks/activity${q.toString() ? `?${q}` : ""}`);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_live_delivery": {
        const body = await apiGet(`/api/tasks/live${liveDeliveryQuery(args as any)}`);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_edit": {
        const a = args as any;
        const ref = encodeURIComponent(String(a?.ref ?? ""));
        const patch: Record<string, unknown> = {};
        for (const f of ["title", "detail", "priority", "type", "dueDate", "startDate", "actor"]) {
          if (typeof a?.[f] === "string") patch[f] = a[f];
        }
        if (Array.isArray(a?.labels)) patch.labels = a.labels;
        const body = await apiSend("POST", `/api/tasks/${ref}`, patch);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_session": {
        const a = args as any;
        if (a?.detach) {
          // The ref is irrelevant on a detach — a session belongs to at most one task, so naming
          // the session is naming the attribution. `x` is a placeholder the route ignores.
          const body = await apiSend("POST", "/api/tasks/x/sessions", { detach: a.detach });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        const ref = encodeURIComponent(String(a?.ref ?? ""));
        // `subtaskId` is optional: omitted, the server (`task-attach.ts`) files the session
        // directly on the task; named, it files under that subtask. Either way the server decides
        // and refuses what it must (unknown task/subtask, a still-blocked subtask) — this is not a
        // second copy of that rule, just the pass-through.
        const body = await apiSend("POST", `/api/tasks/${ref}/sessions`, {
          // A historical conversation goes by `conversationId` and carries NO `sessionId`: the two
          // are different doors on the server, and sending both is refused there.
          ...(a?.conversationId
            ? {
              conversationId: a.conversationId,
              ...(a?.harness ? { harness: a.harness } : {}),
              ...(a?.note ? { note: a.note } : {}),
            }
            : { sessionId: a?.sessionId }),
          ...(a?.subtaskId ? { subtaskId: a.subtaskId } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_delete": {
        const ref = String((args as any)?.ref ?? "");
        const body = await apiSend("DELETE", `/api/tasks/${encodeURIComponent(ref)}`);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_delivery_calendar": {
        const q = deliveryCalendarQuery(args as any);
        if ((args as any)?.format === "ics") return { content: [{ type: "text", text: await apiGetText(`/api/deliveries/calendar${q}`) }] };
        const body = await apiGet(`/api/deliveries/calendar${q}`);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_phase": {
        const a = (args ?? {}) as any;
        const action = typeof a.action === "string" ? a.action : "get";
        if (action === "get") {
          const body = a.subtaskId
            ? await apiGet(`/api/deliveries/${encodeURIComponent(String(a.subtaskId))}`)
            : await apiGet("/api/deliveries");
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        if (action === "release") {
          // The leader DECLARES what a release contains; the host still reads release.yml and the tag itself.
          const body = await apiSend("POST", "/api/deliveries/release", {
            version: a.version, mergeSha: a.mergeSha, repo: a.repo, subtaskIds: a.subtaskIds, session: sessionProof(process.env),
          });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        if (action === "reconcile") {
          // The backfill: same service as `agentop flow reconcile --release`; dry run unless `apply`.
          const body = await apiSend("POST", "/api/deliveries/reconcile", { apply: a.apply === true, session: sessionProof(process.env) });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        if (action === "antigas") {
          // "Antigas sem registro": `antigasAction` publish|archive over `subtaskIds` (or `all`); never deletes.
          const body = await apiSend("POST", "/api/deliveries/antigas", {
            action: a.antigasAction, ids: a.subtaskIds, all: a.all === true, preview: a.preview === true, expect: a.expect, version: a.version, reason: a.reason, session: sessionProof(process.env),
          });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        if (action !== "tick" && (typeof a.subtaskId !== "string" || !a.subtaskId)) throw new Error("subtaskId is required");
        const { subtaskId: _s, action: _a, ...rest } = a;
        const subtaskId = action === "tick" ? "tick" : a.subtaskId;
        // `approve` is the OWNER's answer to a human gate: no session identity travels with it (the server reads "no session proof" as the owner).
        const body = await apiSend("POST", `/api/deliveries/${encodeURIComponent(subtaskId)}`, { ...rest, action, ...(action === "approve" ? {} : { session: sessionProof(process.env) }) });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_stage": {
        const a = (args ?? {}) as any;
        if (typeof a.subtaskId !== "string" || !a.subtaskId) throw new Error("subtaskId is required");
        const draft: Record<string, unknown> = {};
        for (const k of ["prompt", "harness", "model", "effort", "account", "cwd"]) if (typeof a[k] === "string" && a[k].trim()) draft[k] = a[k];
        const body = await apiSend("POST", `/api/deliveries/${encodeURIComponent(a.subtaskId)}`, {
          action: "stage", draft, session: sessionProof(process.env),
          ...(typeof a.versionTarget === "string" ? { versionTarget: a.versionTarget } : {}),
          ...(typeof a.pedidoId === "string" ? { pedidoId: a.pedidoId } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_queue": {
        const a = (args ?? {}) as any;
        // `queue/` with no task = every task's queue (the route reads an empty task as "all").
        const body = await apiGet(`/api/deliveries/queue/${encodeURIComponent(typeof a.taskId === "string" ? a.taskId : "")}`);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_task_queue_answer": {
        const a = (args ?? {}) as any;
        if (a.runNow === true) {
          const body = await apiSend("POST", "/api/deliveries/queue-next", { session: sessionProof(process.env) });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        if (typeof a.subtaskId !== "string" || !a.subtaskId) throw new Error("subtaskId is required");
        if (typeof a.answer !== "string" || !a.answer.trim()) throw new Error("answer is required: sim | nao <motivo> | agendar <ISO> <motivo>");
        const body = await apiSend("POST", `/api/deliveries/${encodeURIComponent(a.subtaskId)}`, { action: "queue-answer", answer: a.answer, session: sessionProof(process.env) });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_groups": {
        const body = await apiGet("/api/session-groups");
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_group_create": {
        const a = args as any;
        const body = await apiSend("POST", "/api/session-groups", {
          name: a?.name,
          ...(Array.isArray(a?.sessions) ? { sessions: a.sessions } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_group_edit": {
        const a = args as any;
        const group = encodeURIComponent(String(a?.group ?? ""));
        let body: unknown;
        switch (a?.action) {
          case "add":
            body = await apiSend("POST", `/api/session-groups/${group}/sessions`, { session: a?.session });
            break;
          case "remove":
            body = await apiSend("POST", "/api/session-groups/ungroup", { session: a?.session });
            break;
          case "rename":
            body = await apiSend("POST", `/api/session-groups/${group}`, { name: a?.name });
            break;
          case "delete":
            body = await apiSend("DELETE", `/api/session-groups/${group}`);
            break;
          default:
            throw new Error("agentistics_session_group_edit: `action` must be add, remove, rename or delete");
        }
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_notify": {
        const a = args as any;
        const body = await apiSend("POST", "/api/session-notify", {
          ref: a?.ref,
          ...(a?.notify !== undefined ? { notify: a.notify } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_role": {
        const a = args as any;
        const body = await apiSend("POST", "/api/session-roles", sessionRoleBody(a, sessionProof(process.env)));
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_switch_account": {
        const a = args as any;
        if (typeof a?.accountId !== "string" || !a.accountId) {
          const body = await apiGet(`/api/fleet/switch-account?id=${encodeURIComponent(String(a?.ref ?? ""))}`);
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        const body = await apiSend("POST", "/api/fleet/switch-account", {
          id: a.ref, accountId: a.accountId, resendPending: a.resendPending === true,
          ...(typeof a.harness === "string" && a.harness ? { harness: a.harness } : {}),
          session: sessionProof(process.env) ?? null,
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_away": {
        const a = args as any;
        if (typeof a?.notice === "string") {
          const body = await apiSend("POST", "/api/away/notice", { text: a.notice, session: sessionProof(process.env) });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        if (typeof a?.on !== "boolean") {
          const body = await apiGet("/api/away");
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        if (typeof a.target === "string" && a.target.trim() !== "") {
          const body = await apiSend("PUT", "/api/away/session", { target: a.target, on: a.on, session: sessionProof(process.env) });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        }
        const body = await apiSend("PUT", "/api/away", {
          on: a.on,
          ...(a.until !== undefined ? { until: a.until } : {}),
          ...(a.schedule !== undefined ? { schedule: a.schedule } : {}),
          ...(a.authorised !== undefined ? { authorised: a.authorised } : {}),
          ...(a.note !== undefined ? { note: a.note } : {}),
          ...(a.maxWorkers !== undefined ? { maxWorkers: a.maxWorkers } : {}),
          ...(a.topCaps !== undefined ? { topCaps: a.topCaps } : {}),
          session: sessionProof(process.env),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_session_message": {
        const a = args as any;
        const body = await apiSend("POST", "/api/session-message", {
          to: a?.to,
          kind: a?.kind,
          body: a?.body,
          awaiting: a?.awaiting,
          session: sessionProof(process.env),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_wait": {
        const a = args as any;
        const body = await apiSend("POST", "/api/flows/wait", {
          action: a?.action, condition: a?.condition, deadlineAt: a?.deadlineAt, label: a?.label, requestId: a?.requestId,
          reopen: a?.reopen, waitId: a?.waitId, generation: a?.generation, from: a?.from, all: a?.all,
          session: sessionProof(process.env),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_checkin_report": {
        const a = args as any;
        const body = await apiSend("POST", "/api/checkin/report", {
          state: a?.state, summary: a?.summary, headline: a?.headline, delivered: a?.delivered, inProgress: a?.inProgress, next: a?.next, health: a?.health, actions: a?.actions, needs: a?.needs,
          session: sessionProof(process.env),
        });
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      }
      case "agentistics_summary": {
        const harness = (args as any)?.harness as string | undefined;
        return text(await analytics("agentistics_summary", harness, {
          legacy: () => apiGet("/api/data"),
          metrics: (q) => fetch(`${API}/api/runtime/metrics?${q}`),
        }));
      }

      case "agentistics_harnesses": {
        const [rows, availability] = await Promise.all([analytics("agentistics_harnesses", undefined, {
          legacy: () => apiGet("/api/data"),
          metrics: (q) => fetch(`${API}/api/runtime/metrics?${q}`),
        }), apiGet("/api/plan-limits")]);
        return text(harnessesTool(rows, availability));
      }

      case "agentistics_plan_limits": {
        return text(planLimitsTool((args ?? {}) as { kind?: RouteKind; authorHarness?: string }, await apiGet("/api/plan-limits") as { budgets?: any[]; now?: number }));
      }

      case "agentistics_benchmark_observed": {
        const body = await apiGet(`/api/benchmark/observed${benchmarkQueryFromArgs(args as { from?: unknown; to?: unknown } | undefined)}`);
        return text(benchmarkObservedTool(body));
      }

      case "agentistics_projects": {
        const harness = (args as any)?.harness as string | undefined;
        return text(await analytics("agentistics_projects", harness, {
          legacy: () => apiGet("/api/data"),
          metrics: (q) => fetch(`${API}/api/runtime/metrics?${q}`),
        }));
      }

      case "agentistics_sessions": {
        const limit = Math.min((args as any)?.limit ?? 20, 50);
        const harness = (args as any)?.harness as string | undefined;
        const data = await apiGet("/api/data");
        // Who started each session — read off the fleet (best effort: a server with no
        // host power has no fleet and the field is simply absent).
        const startedBy = await apiGet("/api/fleet?format=links-v1").then((f: any) => startedByFleetPayload(f ?? {})).catch(() => new Map<string, { id: string; title?: string }>());
        // SESSÕES.FECHAR: delivered workers still open (flows off / older server = none).
        const delivered = await apiGet("/api/flows/delivered-open").then((d: any) => deliveredOpenByConversation(d)).catch(() => new Map<string, Record<string, unknown>>());
        const rows = filterSessions((data.sessions ?? []) as AnySession[], harness)
          .slice(0, limit)
          .map((s: any) => {
            const { input, output, cacheRead, cacheWrite, cost, unpriced } = sessionTokens(s);
            return {
              id: s.session_id,
              harness: sessionHarness(s),
              project: s.project_path,
              startedAt: s.start_time,
              durationMinutes: s.duration_minutes,
              messages: sessionMessages(s),
              ...(s.tokens_unavailable ? {} : {
                inputTokens: input,
                outputTokens: output,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                totalTokens: input + output + cacheRead + cacheWrite,
              }),
              // PRICE.UNKNOWN: null (not 0, not a guess) when none of the session's tokens could be priced.
              ...(s.tokens_unavailable ? {} : { estimatedCostUSD: unpriced > 0 && unpriced === input + output + cacheRead + cacheWrite ? null : Math.round(cost * 10000) / 10000 }),
              ...(unpriced > 0 ? { unpricedTokens: unpriced } : {}),
              model: s.model ?? null,
              // Same reading as the sessions screen (`contextReading`): the window is what the harness declared,
              // then the verified table. A route nobody states a window for reports the tokens and a null window.
              ...contextFields(s),
              ...(s.tokens_unavailable ? { usageNote: 'usage not reported' } : {}),
              ...(Object.values(s.model_usage ?? {}).some((u: any) => u.costSource === 'harness') ? { costSource: 'harness', costNote: 'declared by the harness' } : {}),
              ...(startedBy.get(s.session_id) ? { startedBy: startedBy.get(s.session_id) } : {}),
              ...(delivered.get(s.session_id) ? { deliveredStillOpen: delivered.get(s.session_id) } : {}),
            };
          });
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }

      case "agentistics_costs": {
        const harness = (args as any)?.harness as string | undefined;
        return text(await analytics("agentistics_costs", harness, {
          legacy: () => apiGet("/api/data"),
          metrics: (q) => fetch(`${API}/api/runtime/metrics?${q}`),
        }));
      }

      case "agentistics_component_catalog": {
        const category = (args as any)?.category as string | undefined;
        const items = category
          ? CATALOG.filter((c) => c.category === category)
          : CATALOG;
        return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
      }

      case "agentistics_get_layouts": {
        const prefs = await getPrefs();
        const layouts = (prefs.layouts ?? {}) as Record<string, Array<any>>;
        const active = (prefs.activeLayout ?? "") as string;
        const summary = Object.entries(layouts).map(([layoutName, items]) => ({
          name: layoutName,
          isActive: layoutName === active,
          componentCount: items.length,
          components: items.map((item: any) => ({
            instanceId: item.i,
            componentId: item.componentId,
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          })),
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ activeLayout: active, layouts: summary }, null, 2),
          }],
        };
      }

      case "agentistics_get_preferences": {
        const prefs = await getPrefs();
        return text({
          chatResponder: prefs.chatResponder ?? 'analytics',
          chatWorkingDir: prefs.chatWorkingDir ?? null,
          chatLabel: prefs.chatLabel ?? 'Nay',
          chatMcpEnabled: prefs.chatMcpEnabled === true,
        });
      }

      case "agentistics_set_preferences": {
        const a = (args ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const key of ['chatResponder', 'chatWorkingDir', 'chatLabel', 'chatMcpEnabled']) {
          if (a[key] !== undefined) patch[key] = a[key];
        }
        await putPrefs(patch);
        return text(await (async () => {
          const prefs = await getPrefs();
          return {
            chatResponder: prefs.chatResponder ?? 'analytics',
            chatWorkingDir: prefs.chatWorkingDir ?? null,
            chatLabel: prefs.chatLabel ?? 'Nay',
            chatMcpEnabled: prefs.chatMcpEnabled === true,
          };
        })());
      }

      case "agentistics_create_layout": {
        const layoutName = (args as any).name as string;
        const prefs = await getPrefs();
        const layouts = { ...(prefs.layouts ?? {}) } as Record<string, Array<any>>;
        if (layouts[layoutName]) {
          return { content: [{ type: "text", text: `Layout "${layoutName}" already exists.` }] };
        }
        layouts[layoutName] = [];
        await putPrefs({ layouts, activeLayout: prefs.activeLayout });
        return { content: [{ type: "text", text: `Layout "${layoutName}" created.` }] };
      }

      case "agentistics_add_component": {
        const a = args as any;
        const prefs = await getPrefs();
        const layouts = { ...(prefs.layouts ?? {}) } as Record<string, Array<any>>;
        const targetName = (a.layoutName ?? prefs.activeLayout ?? "") as string;

        if (!targetName) throw new Error("No active layout. Create one first with agentistics_create_layout.");
        if (!layouts[targetName]) throw new Error(`Layout "${targetName}" not found.`);

        const catalogItem = CATALOG.find((c) => c.id === a.componentId);
        if (!catalogItem) throw new Error(`Unknown componentId "${a.componentId}". Use agentistics_component_catalog to list valid IDs.`);

        const current = layouts[targetName];
        const pos =
          a.x !== undefined && a.y !== undefined
            ? { x: a.x as number, y: a.y as number }
            : autoPosition(current, (a.w as number | undefined) ?? catalogItem.defaultW);

        const newItem = {
          i: nextId(current),
          componentId: a.componentId,
          x: pos.x,
          y: pos.y,
          w: (a.w as number | undefined) ?? catalogItem.defaultW,
          h: (a.h as number | undefined) ?? catalogItem.defaultH,
          minW: catalogItem.minW,
          minH: catalogItem.minH,
        };

        layouts[targetName] = [...current, newItem];
        await putPrefs({ layouts });
        return {
          content: [{
            type: "text",
            text: `Added "${a.componentId}" to layout "${targetName}" at (${newItem.x}, ${newItem.y}), size ${newItem.w}×${newItem.h}. Instance ID: ${newItem.i}`,
          }],
        };
      }

      case "agentistics_remove_component": {
        const a = args as any;
        const prefs = await getPrefs();
        const layouts = { ...(prefs.layouts ?? {}) } as Record<string, Array<any>>;
        const targetName = (a.layoutName ?? prefs.activeLayout ?? "") as string;

        if (!targetName || !layouts[targetName]) throw new Error(`Layout "${targetName}" not found.`);

        const before = layouts[targetName].length;
        layouts[targetName] = layouts[targetName].filter((item: any) => item.i !== a.itemId);

        if (layouts[targetName].length === before) {
          return { content: [{ type: "text", text: `Item "${a.itemId}" not found in layout "${targetName}".` }] };
        }

        await putPrefs({ layouts });
        return { content: [{ type: "text", text: `Removed item "${a.itemId}" from layout "${targetName}".` }] };
      }

      case "agentistics_set_active_layout": {
        const layoutName = (args as any).name as string;
        const prefs = await getPrefs();
        const layouts = (prefs.layouts ?? {}) as Record<string, unknown>;
        if (!layouts[layoutName]) {
          throw new Error(`Layout "${layoutName}" not found. Available: ${Object.keys(layouts).join(", ")}`);
        }
        await putPrefs({ activeLayout: layoutName });
        return { content: [{ type: "text", text: `Active layout set to "${layoutName}".` }] };
      }

      case "agentistics_delete_layout": {
        const layoutName = (args as any).name as string;
        const prefs = await getPrefs();
        const layouts = { ...(prefs.layouts ?? {}) } as Record<string, Array<any>>;

        if (!layouts[layoutName]) throw new Error(`Layout "${layoutName}" not found.`);
        if (Object.keys(layouts).length === 1) throw new Error("Cannot delete the last remaining layout.");

        delete layouts[layoutName];
        let active = (prefs.activeLayout ?? "") as string;
        if (active === layoutName) active = Object.keys(layouts)[0] ?? "";
        await putPrefs({ layouts, activeLayout: active });
        return {
          content: [{
            type: "text",
            text: `Deleted layout "${layoutName}". Active layout is now "${active}".`,
          }],
        };
      }

      case "agentistics_export_pdf": {
        const a = args as any;
        const range = (a?.range as string | undefined) ?? "all";
        const uiBase = API.replace(/:\d+$/, ":47292");
        const params = new URLSearchParams({ export: "pdf" });
        if (range !== "all") params.set("range", range);
        const url = `${uiBase}/?${params.toString()}`;
        const rangeLabel = range === "all" ? "all-time" : `last ${range}`;
        return {
          content: [{
            type: "text",
            text: `[⬇ Download PDF — ${rangeLabel}](pdf:${url})`,
          }],
        };
      }

      case "agentistics_build_layout": {
        const a = args as any;
        const layoutName = a.name as string;
        const componentIds = a.componentIds as string[];
        const activate = (a.activate as boolean | undefined) !== false;

        for (const id of componentIds) {
          if (!CATALOG.find((c) => c.id === id)) {
            throw new Error(`Unknown componentId "${id}". Use agentistics_component_catalog to list valid IDs.`);
          }
        }

        const prefs = await getPrefs();
        const layouts = { ...(prefs.layouts ?? {}) } as Record<string, Array<any>>;

        const items: Array<any> = [];
        for (const componentId of componentIds) {
          const cat = CATALOG.find((c) => c.id === componentId)!;
          const pos = autoPosition(items, cat.defaultW);
          items.push({
            i: nextId(items),
            componentId,
            x: pos.x,
            y: pos.y,
            w: cat.defaultW,
            h: cat.defaultH,
            minW: cat.minW,
            minH: cat.minH,
          });
        }
        fillGaps(items);

        layouts[layoutName] = items;
        const patch: Record<string, unknown> = { layouts };
        if (activate) patch.activeLayout = layoutName;
        await putPrefs(patch);

        return {
          content: [{
            type: "text",
            text: `Layout "${layoutName}" built with ${items.length} components: ${componentIds.join(", ")}${activate ? ". Now active." : "."}`,
          }],
        };
      }

      case "agentistics_tags": {
        const data = await apiGet("/api/tags");
        const tags = ((data as any).tags ?? []) as Array<any>;
        const rows = tags.map((t) => ({
          id: t._id,
          name: t.name,
          color: t.color ?? null,
          sessions: t.aggregate?.sessions ?? 0,
          estimatedCostUSD: Math.round((t.aggregate?.costUSD ?? 0) * 10000) / 10000,
          inputTokens: t.aggregate?.inputTokens ?? 0,
          outputTokens: t.aggregate?.outputTokens ?? 0,
          topProject: t.aggregate?.topProject ?? null,
          topModel: t.aggregate?.topModel ?? null,
          topHarness: t.aggregate?.topHarness ?? null,
          window: t.window ?? null,
        }));
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }

      case "agentistics_vault_status": {
        // Raw fetch, not apiGet: an open vault whose list owes a proof answers 401 WITH its view, and
        // that view is exactly what this tool reduces. Anything else non-2xx is an error.
        const res = await fetch(`${API}/api/vault`);
        const body = await res.json().catch(() => ({})) as any;
        if (!res.ok && !(body && typeof body === "object" && body.view)) throw new Error(`GET /api/vault → HTTP ${res.status}`);
        return text(vaultStatusTool(body));
      }

      case "agentistics_tag_detail": {
        const wanted = ((args as any)?.tag as string ?? "").trim();
        if (!wanted) throw new Error("tag is required — pass a name or id from agentistics_tags.");
        const list = await apiGet("/api/tags");
        const tags = ((list as any).tags ?? []) as Array<any>;
        const match = tags.find((t) => t._id === wanted)
          ?? tags.find((t) => (t.name as string)?.toLowerCase() === wanted.toLowerCase());
        if (!match) throw new Error(`No tag matching "${wanted}". Available: ${tags.map((t) => t.name).join(", ") || "(none)"}`);
        const detail = await apiGet(`/api/tags/${encodeURIComponent(match._id)}`);
        const d = detail as any;
        const bucketTop = (b: Array<{ key: string; sessions: number; costUSD: number }> | undefined, n = 5) =>
          (b ?? []).slice(0, n).map((x) => ({ key: x.key, sessions: x.sessions, estimatedCostUSD: Math.round((x.costUSD ?? 0) * 10000) / 10000 }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: d.tag?._id,
              name: d.tag?.name,
              color: d.tag?.color ?? null,
              window: d.tag?.window ?? null,
              sources: d.tag?.sources ?? [],
              aggregate: {
                sessions: d.tag?.aggregate?.sessions ?? 0,
                estimatedCostUSD: Math.round((d.tag?.aggregate?.costUSD ?? 0) * 10000) / 10000,
                inputTokens: d.tag?.aggregate?.inputTokens ?? 0,
                outputTokens: d.tag?.aggregate?.outputTokens ?? 0,
              },
              topProjects: bucketTop(d.stats?.projects),
              topModels: bucketTop(d.stats?.models),
              topHarnesses: bucketTop(d.stats?.harnesses),
              topRepos: bucketTop(d.stats?.repos),
              firstSessionDate: d.stats?.firstSessionDate ?? null,
              lastSessionDate: d.stats?.lastSessionDate ?? null,
            }, null, 2),
          }],
        };
      }

      case "agentistics_repos": {
        const harness = (args as any)?.harness as string | undefined;
        return text(await analytics("agentistics_repos", harness, {
          legacy: () => apiGet("/api/data"),
          metrics: (q) => fetch(`${API}/api/runtime/metrics?${q}`),
        }));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
