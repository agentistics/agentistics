import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registryUnreadable } from './registry'
import { rolesDocUnreadable } from './session-roles'
import { describeLive } from './task-live-view'
import type { LiveDelivery, LiveReply } from './task-live'

const dirs: string[] = []
const review = (): LiveDelivery => ({ key: 't/s', taskId: 't', taskTitle: 'Task', subtaskId: 's', title: 'Review', status: 'in_review', stage: 'leader', stageSinceMs: 0, startedAtMs: 0, sessionIds: [], harnesses: [], models: [], eta: { kind: 'none', reason: 'no-history' }, lastAction: null, blockedReason: null, deliveredAtMs: null, priority: 'high', workMs: null, efforts: [], trail: [], stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' }, block: null, ci: null, step: null })
const reply: LiveReply = { generatedAt: 'x', deliveries: [review()], samples: 0, hidden: [], sessionTasks: {} }

afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }) })

test('corrupt session-roles makes leader availability unknown, while missing files are empty', async () => {
  const roles = await mkdtemp(join(tmpdir(), 'agentistics-roles-')); dirs.push(roles)
  const registry = await mkdtemp(join(tmpdir(), 'agentistics-registry-')); dirs.push(registry)
  expect(await rolesDocUnreadable(roles)).toBe(false)
  expect(await registryUnreadable(join(registry, 'managed-sessions.json'))).toBe(false)
  await writeFile(join(roles, 'session-roles.json'), '{broken', 'utf8')
  expect(await rolesDocUnreadable(roles)).toBe(true)
  const view = describeLive({ reply, rows: [], leaderIds: new Set(), fleetRead: 'unknown', nowMs: 1 })
  expect(view.deliveries[0]).toMatchObject({ leaderAvailability: 'unknown', leaderAvailabilityReasonCode: 'fleet-unreadable' })
  expect(view.deliveries[0]!.leaderAvailability).not.toBe('absent')
})

test('corrupt managed-sessions is unreadable and also cannot become absent', async () => {
  const registry = await mkdtemp(join(tmpdir(), 'agentistics-registry-')); dirs.push(registry)
  const file = join(registry, 'managed-sessions.json')
  await writeFile(file, '{broken', 'utf8')
  expect(await registryUnreadable(file)).toBe(true)
  const view = describeLive({ reply, rows: [], leaderIds: new Set(), fleetRead: 'unknown', nowMs: 1 })
  expect(view.deliveries[0]).toMatchObject({ leaderAvailability: 'unknown', leaderAvailabilityReasonCode: 'fleet-unreadable' })
  expect(view.deliveries[0]!.leaderAvailability).not.toBe('absent')
})
