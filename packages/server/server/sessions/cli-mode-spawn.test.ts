import { afterEach, describe, expect, test } from 'bun:test'
import { batch, start, runSession } from './cli-session'
import { parseSessionArgs } from './cli-parse'
import { addSession, readRegistry } from './registry'
import { __setSessionBackendForTest } from './index'
import { exactLinksOnDisk } from './reopen-link'
import { routeSpawn } from './structured-route'
import type { ManagedSession, SessionBackend, StructuredIntent } from './types'

const savedCaller = process.env.AGENTOP_MANAGED_ID
afterEach(() => {
  __setSessionBackendForTest(null)
  if (savedCaller === undefined) delete process.env.AGENTOP_MANAGED_ID
  else process.env.AGENTOP_MANAGED_ID = savedCaller
})

function recorder() {
  const seen: Array<{ argv: string[]; row?: ManagedSession; structured?: StructuredIntent }> = []
  const backend = {
    id: 'tmux', unavailable: async () => undefined, list: async () => [], capture: async () => [], kill: async () => {},
    spawn: async (req: { id: string; argv: string[]; structured?: StructuredIntent }) => {
      seen.push({ argv: req.argv, structured: req.structured, row: (await readRegistry()).find(r => r.id === req.id) })
      throw new Error('fixture: no process is launched')
    },
  } as unknown as SessionBackend
  return { seen, backend }
}

async function quietly(f: () => Promise<unknown>) {
  const log = console.log, error = console.error
  console.log = () => {}; console.error = () => {}
  try { await f() } finally { console.log = log; console.error = error }
}

describe('ORQ.FORA CLI modes reach the process boundary', () => {
  test('start forwards --mode to argv and records it before launch', async () => {
    delete process.env.AGENTOP_MANAGED_ID
    const cmd = parseSessionArgs(['claude', '--bg', '--force', '--shared-cwd', '--mode', 'no-questions'])
    if (cmd.kind !== 'start') throw new Error('expected start')
    const { seen, backend } = recorder()
    await quietly(() => start(cmd, backend, { settleMs: 0 }))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.argv).toContain('--dangerously-skip-permissions')
    expect(seen[0]!.row?.mode).toBe('no-questions')
    expect(seen[0]!.structured).toMatchObject({ harness: 'claude', origin: 'background', mode: 'no-questions' })
    expect(seen[0]!.structured?.instructions?.text).toContain('agentistics')
    expect(seen[0]!.structured?.mcp?.[0]?.name).toBe('agentistics')
  })
  test('batch forwards each mode and completes board filing before launch', async () => {
    delete process.env.AGENTOP_MANAGED_ID
    const cmd = parseSessionArgs(['batch', '--task', 'ORQ mode boundary fixture', '--force', '--shared-cwd', '--mode', 'accept-edits', '--session', 'claude: x'])
    if (cmd.kind !== 'batch') throw new Error('expected batch')
    const { seen, backend } = recorder()
    await quietly(() => batch(cmd, backend))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.argv).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']))
    expect(seen[0]!.row?.mode).toBe('accept-edits')
    expect(seen[0]!.structured).toMatchObject({ origin: 'background', mode: 'accept-edits', prompt: 'x' })
    expect(seen[0]!.row?.taskId).toBeDefined()
    expect(seen[0]!.row?.spawnConfiguration).toMatchObject({ ready: true, applied: ['filing'] })
  })
})


test('ORQ.FORA CLI session open sends a background structured resume and keeps its row before launch', async () => {
  delete process.env.AGENTOP_MANAGED_ID
  const old: ManagedSession = { id: 'orq-open-old', harness: 'claude', cwd: process.cwd(), createdAt: '2026-10-01T00:00:00Z', task: 'ORQ structured open fixture', conversationId: 'orq-open-conversation', mode: 'no-questions' }
  await addSession(old)
  // Establish an exact transcript link using the resolver seam; no harness or transcript is launched.
  await exactLinksOnDisk([old], [], Date.now(), async () => '/fixture/transcript.jsonl')
  const { seen, backend } = recorder()
  __setSessionBackendForTest(backend)
  await quietly(() => runSession(['open', 'ORQ structured open fixture', '--json', '--force']))
  expect(seen).toHaveLength(1)
  expect(seen[0]!.row?.mode).toBe('no-questions')
  expect(seen[0]!.structured).toMatchObject({ origin: 'background', resumeId: 'orq-open-conversation', mode: 'no-questions' })
  expect(seen[0]!.structured?.instructions).toBeUndefined()
  expect(routeSpawn({ flagOn: true, harness: 'claude', driver: 'claude-stream-json', origin: seen[0]!.structured?.origin, mode: 'no-questions', startModes: ['no-questions'], acpDriven: false, acpOptIn: [] })).toBe('structured')
})
