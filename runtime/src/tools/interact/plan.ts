/**
 * tools/interact/plan.ts — `task.plan`: the model's OWN checklist (spec
 * docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md §3, §6).
 *
 * ## Kept IN-RUN, and deliberately not journaled to the ALM board
 *
 * The catalogue's table (§3) lists `alm.*` under this tool's Events column, but the ALM board
 * (`Task`/`Subtask`, `packages/server/server/sessions/task-*.ts`) lives in `packages/server`, which
 * this package may never import (`@agentistics/runtime` is compiled into the single binary AND
 * published standalone — see `src/index.ts`'s own header). Writing to the board from here would
 * mean either importing server code (forbidden) or re-implementing the board's write path a second
 * time (the exact duplication `task-reopen.ts` exists to have fixed once). So `task.plan` stays a
 * pure in-run checklist: `plan()` exposes the current state for a HOST to draw in its own header or
 * UI, and the gate's own `tool.requested`/`tool.completed` events (emitted by `runTool`, not by this
 * module) already record that the call happened. Journaling a plan update as an `alm.*` event needs
 * a host seam this package does not have — a later item wires one in, this one does not invent it.
 *
 * ## The one rule worth stating: at most one step `in_progress`
 *
 * A checklist with two steps "in progress" says nothing about what the model is doing right now, so
 * that shape is refused outright (`invalid-input`) rather than silently taking the last one — the
 * same principle `task-model.ts`'s `blocked_needs_reason` applies to a status change with no reason.
 */

import type { PolicySubject, Tool } from '../contract.ts'
import { defineTool } from '../define.ts'

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanStep {
  readonly text: string
  readonly status: PlanStepStatus
}

export interface PlanToolHandle {
  readonly tool: Tool<{ steps: PlanStep[] }>
  /** The plan as of the last ALLOWED, valid call. A denied or invalid-input call leaves it as it was. */
  plan(): readonly PlanStep[]
}

const MAX_STEPS = 50
const MAX_TEXT_LEN = 500

/** `task.plan` touches nothing outside the run — one fixed subject, never derived from the input. */
const PLAN_SUBJECTS: readonly PolicySubject[] = [{ action: 'plan' }]

function marker(status: PlanStepStatus): string {
  return status === 'completed' ? 'x' : status === 'in_progress' ? '~' : ' '
}

/** Compact, with counts — a host or a person skimming the model's own text sees the shape at a glance. */
function formatPlan(steps: readonly PlanStep[]): string {
  if (steps.length === 0) return 'Plan cleared — no steps.'
  const counts = { pending: 0, in_progress: 0, completed: 0 }
  for (const s of steps) counts[s.status]++
  const summary =
    `Plan (${steps.length} step${steps.length === 1 ? '' : 's'}: ` +
    `${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed):`
  const lines = steps.map((s, i) => `${i + 1}. [${marker(s.status)}] ${s.text}`)
  return [summary, ...lines].join('\n')
}

export function createPlanTool(): PlanToolHandle {
  let current: readonly PlanStep[] = []

  const tool = defineTool<{ steps: PlanStep[] }>({
    name: 'task.plan',
    description:
      'Replace your own checklist for this task with a new list of steps, in order. This REPLACES the ' +
      'whole plan — send every step, not only the ones that changed. At most one step may be ' +
      "in_progress at a time. It is your own working notes, not a report to anyone else.",
    kind: 'other',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          maxItems: MAX_STEPS,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', maxLength: MAX_TEXT_LEN },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['text', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    parse(input) {
      if (typeof input !== 'object' || input === null) {
        return 'task.plan expects an object with a `steps` array.'
      }
      const raw = (input as { steps?: unknown }).steps
      if (!Array.isArray(raw)) return 'task.plan expects `steps` to be an array.'
      if (raw.length > MAX_STEPS) {
        return `task.plan accepts at most ${MAX_STEPS} steps; this call named ${raw.length}.`
      }
      const steps: PlanStep[] = []
      let inProgressCount = 0
      for (const [i, item] of raw.entries()) {
        if (typeof item !== 'object' || item === null) return `Step ${i + 1} is not an object.`
        const text = (item as { text?: unknown }).text
        const status = (item as { status?: unknown }).status
        if (typeof text !== 'string' || text.length === 0) return `Step ${i + 1} needs non-empty text.`
        if (text.length > MAX_TEXT_LEN) {
          return `Step ${i + 1}'s text is longer than the ${MAX_TEXT_LEN}-character limit.`
        }
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          return `Step ${i + 1} has an unrecognised status "${String(status)}"; use pending, in_progress or completed.`
        }
        if (status === 'in_progress') inProgressCount++
        steps.push({ text, status })
      }
      if (inProgressCount > 1) {
        return `At most one step may be in_progress at a time; this plan named ${inProgressCount}.`
      }
      return { steps }
    },
    subjects: async () => PLAN_SUBJECTS,
    run: async (input) => {
      current = input.steps
      return { ok: true, modelText: formatPlan(current) }
    },
  })

  return { tool, plan: () => current }
}
