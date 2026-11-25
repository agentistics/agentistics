/**
 * QA 2.229 M5: `liveDeliveries` (the route behind GET /api/tasks/live and the MCP `agentistics_live_delivery`) once
 * copied each fleet row field by field and dropped `activeSignal`, so a worker queued on the heavy lock read "idle" on
 * the Live board and the leaders' lane while the sidebar said "na fila". `live-activity.test.ts` pins `liveRowOf`
 * itself; a route that stopped CALLING it survived every test. This drives the real route with only the fleet
 * injected, so the mapping inside the route is what is under test.
 *
 * Under `bun test` AGENTISTICS_DATA_DIR is a fresh temporary directory (data-dir.ts), never the owner's store.
 */
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ControlSession } from '@agentistics/tui/control'
import { AGENTISTICS_DATA_DIR } from '../config'
import { SESSION_ROLES_FILE } from './session-roles'
import { liveDeliveries } from './task-web'

const row = (over: Record<string, unknown>) =>
  ({ title: String(over.id), harness: 'claude', state: 'waiting', ...over }) as unknown as ControlSession

test('the Live route carries activeSignal: a heavy-lock worker is "queued", leader and lane alike', async () => {
  mkdirSync(AGENTISTICS_DATA_DIR, { recursive: true })
  writeFileSync(join(AGENTISTICS_DATA_DIR, SESSION_ROLES_FILE), JSON.stringify({ version: 1, migrated: true, roles: { L: 'leader' } }))
  const fleet = [
    row({ id: 'L', state: 'waiting', activeSignal: 'heavy-lock' }),
    row({ id: 'q', state: 'waiting', activeSignal: 'heavy-lock', parentSessionId: 'L' }),
    row({ id: 'r', state: 'working', activeSignal: 'output', parentSessionId: 'L' }),
    row({ id: 'i', state: 'waiting', parentSessionId: 'L' }),
  ]
  const view = await liveDeliveries({}, { readFleet: async () => fleet })
  const leader = view.leaders.find(l => l.id === 'L')
  expect(leader).toBeDefined()
  expect(leader!.state).toBe('working')
  expect(leader!.queued).toBe(true)
  const word = Object.fromEntries(leader!.workers.map(w => [w.id, w.word]))
  expect(word).toEqual({ q: 'queued', r: 'working', i: 'idle' })
})
