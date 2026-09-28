/**
 * tools/gate.ts — the ONLY place a tool executes: parse → subjects → policy → grant → execute →
 * content store → one terminal event. The loop calls `runTool`; nothing else calls `Tool.execute`
 * (`tools-gate.lint.test.ts`).
 *
 * ## The event sequence of one call (acceptance §6.1: one `requested`, exactly one terminal)
 *
 *   requested → [policyRequested → policyDecided] → completed | failed
 *
 * A policy DENIAL is reported through `policyDecided` with a `deny` verdict and is itself the
 * terminal outcome (the emitter writes `policy.denied` + `tool.denied`); no `completed`/`failed`
 * follows it. An input that does not parse never reaches the policy: it fails `invalid-input`.
 *
 * ## Fail closed at the gate, and only here (D-T3 rule 5)
 *
 * A policy that throws is a DENIAL. A tool that throws is `internal`. A subjects() that throws is
 * `internal` and nothing runs — a call whose effects cannot be stated cannot be authorised.
 */

import type {
  ContentSink,
  PersonAsker,
  PolicyVerdict,
  Tool,
  ToolCallInfo,
  ToolContext,
  ToolErrorClass,
  ToolEventSink,
  ToolOutcome,
  ToolPolicy,
} from './contract.ts'
import { mintGrant } from './grant.ts'

export interface GateDeps {
  policy: ToolPolicy
  events: ToolEventSink
  content: ContentSink
  asker?: PersonAsker
}

export interface GateScope {
  workspaceRoot: string
  cwd: string
  signal: AbortSignal
  sessionId?: string
  runId?: string
  agentId?: string
  now?: () => Date
  /** Minted by the caller when it already has one; otherwise the gate mints a `tx_` id. */
  toolExecutionId?: string
}

export interface GateResult {
  toolExecutionId: string
  outcome: ToolOutcome
  /** `denied`: the policy refused and nothing ran. */
  status: 'completed' | 'failed' | 'denied' | 'cancelled'
  verdict?: PolicyVerdict
}

export function mintToolExecutionId(): string {
  return `tx_${crypto.randomUUID().replaceAll('-', '')}`
}

const POLICY_FAILED_SENTENCE =
  'The permission policy could not reach a decision for this call, so it was refused. Nothing ran.'

function fail(cls: ToolErrorClass, sentence: string): ToolOutcome {
  return { ok: false, modelText: sentence, error: { class: cls, detail: sentence } }
}

export async function runTool(tool: Tool<unknown>, rawInput: unknown, scope: GateScope, deps: GateDeps): Promise<GateResult> {
  const now = scope.now ?? (() => new Date())
  const toolExecutionId = scope.toolExecutionId ?? mintToolExecutionId()
  const call: ToolCallInfo = { toolExecutionId, toolName: tool.name }
  const started = performance.now()
  const ctx: ToolContext = {
    workspaceRoot: scope.workspaceRoot,
    cwd: scope.cwd,
    signal: scope.signal,
    toolExecutionId,
    sessionId: scope.sessionId,
    runId: scope.runId,
    agentId: scope.agentId,
    asker: deps.asker,
    now,
  }

  await deps.events.requested({ call, kind: tool.kind, occurredAt: now().toISOString() })

  const finish = async (outcome: ToolOutcome, status: 'completed' | 'failed' | 'cancelled'): Promise<GateResult> => {
    const result = await deps.content.put(outcome.modelText).catch(() => null)
    const durationMs = Math.round(performance.now() - started)
    const occurredAt = now().toISOString()
    if (status === 'completed') {
      await deps.events.completed({ call, facts: outcome.facts ?? {}, durationMs, result, occurredAt })
    } else {
      await deps.events.failed({
        call,
        status,
        errorClass: outcome.error?.class ?? 'internal',
        exitCode: outcome.facts?.exitCode,
        durationMs,
        result,
        occurredAt,
      })
    }
    return { toolExecutionId, outcome, status }
  }

  if (scope.signal.aborted) {
    return finish(fail('killed', 'The run was cancelled before this call started. Nothing ran.'), 'cancelled')
  }

  const parsed = tool.parse(rawInput)
  if (typeof parsed === 'string') return finish(fail('invalid-input', parsed), 'failed')

  let subjects
  try {
    subjects = await tool.subjects(parsed, ctx)
  } catch {
    return finish(fail('internal', `The ${tool.name} tool could not state what this call would touch, so it did not run.`), 'failed')
  }

  await deps.events.policyRequested({ call, occurredAt: now().toISOString() })
  let verdict: PolicyVerdict
  try {
    verdict = await deps.policy.evaluate({
      call,
      kind: tool.kind,
      permission: tool.permission,
      subjects,
      workspaceRoot: scope.workspaceRoot,
      asker: deps.asker,
      signal: scope.signal,
    })
  } catch {
    verdict = { decision: 'deny', by: 'policy', policy: 'gate', code: 'policy.denied.policy-failed', sentence: POLICY_FAILED_SENTENCE }
  }
  await deps.events.policyDecided({ call, verdict, occurredAt: now().toISOString() })

  if (verdict.decision === 'deny') {
    const outcome = fail('denied', verdict.sentence)
    // The refusal text still goes to the content store (it is what the model reads), but no
    // completed/failed event follows: the denial IS the terminal event.
    await deps.content.put(outcome.modelText).catch(() => null)
    return { toolExecutionId, outcome, status: 'denied', verdict }
  }

  const grant = mintGrant(toolExecutionId, subjects)
  let outcome: ToolOutcome
  try {
    outcome = await tool.execute(parsed, ctx, grant)
  } catch {
    outcome = fail('internal', `The ${tool.name} tool failed unexpectedly. The call may have had partial effects.`)
  }
  const cancelled = !outcome.ok && outcome.error?.class === 'killed' && scope.signal.aborted
  const res = await finish(outcome, outcome.ok ? 'completed' : cancelled ? 'cancelled' : 'failed')
  return { ...res, verdict }
}
