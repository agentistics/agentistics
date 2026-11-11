import { expect, test } from 'bun:test'
import { buildFlowOpEnv } from './book-flow-env'

test('flow-op environment is server-derived and ignores request-controlled fields', () => {
  const env = buildFlowOpEnv({ taskId: 'server-task', SECRET: 'never', env: 'forged' })
  expect(env.taskId).toBe('server-task')
  expect(env.SECRET).toBeUndefined()
  expect((env as Record<string, unknown>).env).toBeUndefined()
})
