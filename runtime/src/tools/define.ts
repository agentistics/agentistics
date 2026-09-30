/**
 * tools/define.ts — the one way a tool is built. The tool's own `run` is closed over here and never
 * exposed, so the only door into it is `execute`, and `execute` refuses without a live grant for
 * exactly the subjects this input has (`./grant.ts`). That is what makes "every write and every
 * shell command goes through the policy" structural rather than a convention a caller can forget.
 */

import type { ToolKind } from '@agentistics/core'
import type { PolicySubject, Tool, ToolContext, ToolOutcome, ToolPermission } from './contract.ts'
import { spendGrant } from './grant.ts'

export interface ToolDefinition<I> {
  name: string
  description: string
  kind: ToolKind
  permission: ToolPermission
  inputSchema: Record<string, unknown>
  parse(input: unknown): I | string
  subjects(input: I, ctx: ToolContext): Promise<readonly PolicySubject[]>
  /** Runs AFTER the policy allowed exactly `subjects`. Should not throw; if it does, the gate
   *  reports `internal`. */
  run(input: I, ctx: ToolContext): Promise<ToolOutcome>
}

/** The sentence a tool answers with when called without a grant. Also a test needle. */
export const NO_GRANT_SENTENCE =
  'This tool call was not authorised by the policy, so it did not run.'

export function defineTool<I>(def: ToolDefinition<I>): Tool<I> {
  const { run, ...rest } = def
  return Object.freeze({
    ...rest,
    async execute(input: I, ctx: ToolContext, grant: unknown): Promise<ToolOutcome> {
      // Re-derive: the grant must cover what THIS input would touch now, not what it touched once.
      const subjects = await def.subjects(input, ctx)
      if (!spendGrant(grant, ctx.toolExecutionId, subjects)) {
        return { ok: false, modelText: NO_GRANT_SENTENCE, error: { class: 'denied', detail: NO_GRANT_SENTENCE } }
      }
      return run(input, ctx)
    },
  })
}
