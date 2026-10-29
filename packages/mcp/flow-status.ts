import { isFlowRunId } from '@agentistics/core'

export function flowStatusPath(runId: string): string {
  if (!isFlowRunId(runId)) throw new Error('invalid flow run id')
  return `/api/flows/status/${runId}`
}
