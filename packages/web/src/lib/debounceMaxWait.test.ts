import { expect, test } from 'bun:test'
import { debounceWithMaxWait } from './debounceMaxWait'

function fakeClock() {
  let now = 0, id = 0
  const q = new Map<number, { at: number; fn: () => void }>()
  const timers = {
    set: (fn: () => void, ms: number) => { q.set(++id, { at: now + ms, fn }); return id },
    clear: (h: number) => { q.delete(h) },
  }
  const advance = (to: number) => {
    for (;;) {
      const next = [...q.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at; q.delete(next[0]); next[1].fn()
    }
    now = to
  }
  return { timers, advance }
}

test('a steady stream 200 ms apart still fires at the ceiling', () => {
  const c = fakeClock(); const fires: number[] = []
  let t = 0
  const d = debounceWithMaxWait(() => fires.push(t), 500, 2000, c.timers)
  for (t = 0; t <= 7000; t += 200) { c.advance(t); d() }
  expect(fires.length).toBeGreaterThanOrEqual(3)
  expect(fires[0]!).toBeLessThanOrEqual(2000)
})

test('cancel drops a pending call', () => {
  const c = fakeClock(); let n = 0
  const d = debounceWithMaxWait(() => n++, 100, 500, c.timers)
  d(); d.cancel(); c.advance(1000)
  expect(n).toBe(0)
})
