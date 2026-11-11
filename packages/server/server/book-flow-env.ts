/** Environment fields admitted to the server-side flow transport. */
export const FLOW_OP_ENV_FIELDS = [
  'taskId', 'fromSession', 'runId', 'phase', 'harness', 'model', 'account',
  'outcome', 'reason', 'pageId', 'q',
] as const

export function buildFlowOpEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(FLOW_OP_ENV_FIELDS.map(name => [name, env[name]]))
}
