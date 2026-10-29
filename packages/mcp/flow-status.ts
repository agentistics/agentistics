import { isFlowRunId } from '@agentistics/core'

export function flowStatusRunId(runId: string): string {
  if (!isFlowRunId(runId)) throw new Error('invalid flow run id')
  return runId
}
