import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTaskStore } from '../sessions/task-store'
import { createDeliveryStore } from './store'
import { withEvidenceDeletion } from './evidence-delete'
import { withGuardLocks } from './guard-locks'
import { lockFile } from '../sessions/file-lock'

test('injected deletion port runs before mutation under tasks, concurrent writer completes without inversion/deadlock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-delete-concurrent-'))
  const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
  try {
    const store = createTaskStore(paths.tasks)
    const at = new Date().toISOString()
    await store.upsertTask({ id: 't1', title: 'T', status: 'todo', createdAt: at, updatedAt: at } as never)
    let entered!: () => void, proceed!: () => void
    const portEntered = new Promise<void>(r => { entered = r })
    const continueDelete = new Promise<void>(r => { proceed = r })
    let sawTaskBeforeMutation = false
    const deletion = store.removeTask('t1', async (mutate: () => Promise<boolean>, held: { tasks: boolean }) => {
      expect(held).toEqual({ tasks: true }) // uncontended: the store says it really holds tasks
      const probe = await lockFile(paths.tasks, () => Date.now(), 10)
      await probe.release()
      expect(probe.contended).toBe(true) // the injected port is already inside tasks
      sawTaskBeforeMutation = (await store.read()).tasks.some(t => t.id === 't1')
      // This takes only later locks; an inverted/nested tasks acquisition would refuse or deadlock.
      return withEvidenceDeletion({ taskId: 't1' }, async () => {
        entered(); await continueDelete
        return mutate()
      }, held, paths)
    })
    // Also observe early port failures: the old post-write callback receives no mutate function.
    const first = await Promise.race([portEntered.then(() => 'entered'), deletion.then(() => 'deleted', () => 'failed')])
    expect(first).toBe('entered')
    const writer = withGuardLocks(['tasks', 'deliveries', 'guards'], async () => {
      expect((await store.read()).tasks).toHaveLength(0)
      expect((await createDeliveryStore(paths.deliveries).readStrict()).deliveries).toEqual({})
      return 'finished'
    }, { paths, waitMs: 1000 })
    proceed()
    expect(await deletion).toBe(true)
    expect(await writer).toBe('finished')
    expect(sawTaskBeforeMutation).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 4000)
