import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskStore } from './task-store'
import { sseClients, sseEncoder } from '../sse'

test('a task-book write pushes a bare `change` event to SSE clients', async () => {
  const got: string[] = []
  const ctrl = { enqueue: (b: Uint8Array) => { got.push(new TextDecoder().decode(b)) } } as unknown as Parameters<typeof sseClients.add>[0]
  sseClients.add(ctrl)
  try {
    const store = createTaskStore(join(mkdtempSync(join(tmpdir(), 'book-')), 'tasks.json'))
    await store.upsertTask({ id: 't1', title: 't1', status: 'todo', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' } as never)
    got.length = 0
    await new Promise(r => setTimeout(r, 300))
    got.length = 0
    expect(await store.patchTask('t1', { status: 'in_review' } as never)).toBe(true)
    await new Promise(r => setTimeout(r, 400))
    expect(got.some(c => c.startsWith('event: change'))).toBe(true)
    expect(sseEncoder).toBeDefined()
  } finally { sseClients.delete(ctrl) }
})
