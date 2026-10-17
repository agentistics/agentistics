import { expect, test } from 'bun:test'
import { pollVaultUseRequests } from './vaultUsePolling'
import type { Reply, VaultUseRequest } from './vaultApi'

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const request: VaultUseRequest = { id: 'r', sessionTitle: 'Worker', harness: 'codex', name: 'demo', field: 'value', command: null, flags: [], count: 1, expiresAt: 0 }

function fixture() {
  const queue = new Map<number, () => void>()
  let id = 0, calls = 0, refused = 0
  let reply: Reply<{ requests: VaultUseRequest[] }> = { ok: true, requests: [request] }
  let shown: VaultUseRequest[] = []
  const start = (open: boolean) => pollVaultUseRequests({
    open, load: async () => { calls++; return reply },
    onRequests: r => { shown = r }, onRefused: () => { refused++ },
    schedule: fn => { const key = ++id; queue.set(key, fn); return key as unknown as ReturnType<typeof setTimeout> },
    cancel: timer => { queue.delete(timer as unknown as number) },
  })
  const tick = async () => {
    const pending = [...queue.values()]; queue.clear()
    pending.forEach(fn => fn()); await flush()
  }
  return { start, tick, queue, refuse: (status: number) => { reply = { ok: false, status, code: 'locked', sentence: '' } },
    allow: () => { reply = { ok: true, requests: [request] } },
    get calls() { return calls }, get refused() { return refused }, get shown() { return shown } }
}

test('locked/unknown vault makes no use-request calls; unlocking starts polling and locking cancels it', async () => {
  const f = fixture()
  let stop = f.start(false)
  await f.tick(); expect(f.calls).toBe(0)
  stop(); stop = f.start(true)
  await flush(); expect(f.calls).toBe(1); expect(f.shown).toEqual([request])
  await f.tick(); expect(f.calls).toBe(2)
  stop(); stop = f.start(false)
  await f.tick(); expect(f.calls).toBe(2); expect(f.shown).toEqual([])
  stop()
})

for (const status of [401, 403]) test(`${status} parks polling until a new unlocked subscription`, async () => {
  const f = fixture(); f.refuse(status)
  let stop = f.start(true)
  await flush()
  expect(f.refused).toBe(1); expect(f.queue.size).toBe(0)
  await f.tick(); expect(f.calls).toBe(1)
  stop(); stop = f.start(false)
  f.allow(); stop(); stop = f.start(true)
  await flush(); expect(f.calls).toBe(2); expect(f.shown).toEqual([request])
  stop(); expect(f.queue.size).toBe(0)
})

test('locking during an in-flight request discards its result and cannot restart polling', async () => {
  let resolve!: (r: Reply<{ requests: VaultUseRequest[] }>) => void
  let painted = false, scheduled = false
  const stop = pollVaultUseRequests({ open: true,
    load: () => new Promise(r => { resolve = r }),
    onRequests: () => { painted = true }, onRefused: () => {},
    schedule: () => { scheduled = true; return 1 as unknown as ReturnType<typeof setTimeout> },
  })
  stop(); resolve({ ok: true, requests: [request] }); await flush()
  expect(painted).toBe(false); expect(scheduled).toBe(false)
})
