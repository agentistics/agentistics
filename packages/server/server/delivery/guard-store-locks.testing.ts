/** Child process for the real-store lock race; the parent supplies only throwaway paths. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTaskStore } from '../sessions/task-store'
import { execGit } from './classify-host'
import { flowContext } from './guard'
import { withGuardTransaction } from './guard-transaction'
import { createDeliveryStore } from './store'
import { createDeliveryService } from './service'
import { unattributedContext } from './guard'

const [root, role] = process.argv.slice(2) as [string, string]
const sessions = JSON.parse(readFileSync(join(root, 'race-sessions.json'), 'utf8'))
const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
const deps = { sessions: async () => sessions, git: execGit }
const tasks = createTaskStore(paths.tasks, { guard: { deps } })
const store = createDeliveryStore(paths.deliveries, { guard: { deps } })
const ctx = flowContext()
const svc = createDeliveryService({ store, classify: deps, facts: { sessions: async () => sessions },
  board: {
    setPhaseStatus: async (id: string) => {
      for (const path of Object.values(paths)) assert(existsSync(path + '.lock'), `board effect escaped ${path}`)
      const sub = (await tasks.read()).subtasks.find(s => s.id === id)!
      await tasks.upsertSubtask({ ...sub, status: 'in_review' }, ctx)
      return { ok: true }
    },
    setCi: async () => {}, logStep: async () => {}, comment: async () => {},
  }, notify: { session: async () => true, owner: async () => {} }, autonomous: async () => true,
  emit: async () => {}, now: Date.now,
} as never)

for (let i = 0; i < 8; i++) await withGuardTransaction(paths, async () => {
  if (role === 'board') {
    const sub = (await tasks.read()).subtasks.find(s => s.id === 'p1')!
    await tasks.upsertSubtask({ ...sub, status: 'in_progress' }, ctx)
    await tasks.upsertSubtask({ ...sub, status: 'in_review' }, ctx)
  } else {
    await store.update(doc => { const r = doc.deliveries.p1!; r.phase = 'qa'; r.authorSessionId = 'worker'; r.qaSessionId = 'qa-race'; r.headSha = r.evidence![0]!.headSha! }, { guard: unattributedContext() })
    const out = await svc.transition('p1', 'revisao_lider', { verdict: 'APROVADO', findings: 'independent QA' }, 'flow:entrega')
    assert(out.ok, JSON.stringify(out))
  }
  const cp = JSON.parse(readFileSync(paths.guards, 'utf8')).checkpoints.p1
  assert.equal(cp.rank, 1)
  assert(cp.auth.some((a: { kind: string }) => a.kind === 'evidence'))
})
console.log(`${role}: 8 real-store iterations, no unguarded write`)
