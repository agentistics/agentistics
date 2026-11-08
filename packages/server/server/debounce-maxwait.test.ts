import { expect, test } from 'bun:test'
import { debounceWithMaxWait } from './debounce-maxwait'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('a burst collapses into one call at the end', async () => {
  let n = 0
  const d = debounceWithMaxWait(() => { n++ }, 30, 1000)
  d(); d(); d()
  await sleep(80)
  expect(n).toBe(1)
})

test('a steady stream still fires every maxWait', async () => {
  let n = 0
  const d = debounceWithMaxWait(() => { n++ }, 50, 120)
  const end = Date.now() + 400
  while (Date.now() < end) { d(); await sleep(10) }
  expect(n).toBeGreaterThanOrEqual(2)
})

test('a task-book write is announced as `book`, never as the data-refetching `change`', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./sse.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('const pushBook'), src.indexOf('onBookWrite('))
  expect(fn).toContain('event: book')
  expect(fn).not.toContain('event: change')
})
