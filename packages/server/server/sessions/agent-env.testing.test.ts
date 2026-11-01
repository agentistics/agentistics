import { expect, test } from 'bun:test'
import { isolate, snapshotAgentEnv } from './agent-env.testing'

test('isolate clears the agent family the test does not define, keeps locations, and restores exactly', () => {
  const env: NodeJS.ProcessEnv = { AGENTOP_MANAGED_ID: 'm-1', AGENTISTICS_FLOWS: '1', AGENTISTICS_DIR: '/tmp/iso', AGENTISTICS_TASKS_FILE: '/tmp/t.json', PATH: '/bin', HOME: '/h' }
  const restore = isolate({ AGENTISTICS_MULTI_ACCOUNT: '1' }, env)
  expect(env).toEqual({ AGENTISTICS_DIR: '/tmp/iso', AGENTISTICS_TASKS_FILE: '/tmp/t.json', AGENTISTICS_MULTI_ACCOUNT: '1', PATH: '/bin', HOME: '/h' })
  env.AGENTOP_MANAGED_ID = 'set-by-the-test'; env.AGENTISTICS_EXTRA = 'x' // what a test may do
  restore()
  expect(env).toEqual({ AGENTOP_MANAGED_ID: 'm-1', AGENTISTICS_FLOWS: '1', AGENTISTICS_DIR: '/tmp/iso', AGENTISTICS_TASKS_FILE: '/tmp/t.json', PATH: '/bin', HOME: '/h' })
})

test('a variable the test defines as undefined is removed; snapshot ignores everything outside the family', () => {
  const env: NodeJS.ProcessEnv = { AGENTOP_MANAGED_ID: 'm-1', OTHER: 'y' }
  expect(snapshotAgentEnv(env)).toEqual({ AGENTOP_MANAGED_ID: 'm-1' })
  const restore = isolate({ AGENTOP_MANAGED_ID: undefined }, env)
  expect(env).toEqual({ OTHER: 'y' })
  restore()
  expect(env).toEqual({ AGENTOP_MANAGED_ID: 'm-1', OTHER: 'y' })
})
