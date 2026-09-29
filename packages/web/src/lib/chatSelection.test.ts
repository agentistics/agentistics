import { expect, test } from 'bun:test'
import { createChatSelectionStore, type ChatSelectionState } from './chatSelection'

const state = (owner: string, count = 1): ChatSelectionState => ({
  owner, count, forward: () => {}, copy: () => {}, cancel: () => {},
})

test('publishes and notifies', () => {
  const s = createChatSelectionStore()
  let hits = 0
  const off = s.subscribe(() => { hits++ })
  s.set(state('a', 2))
  expect(s.get()?.count).toBe(2)
  expect(hits).toBe(1)
  off()
  s.set(state('a', 3))
  expect(hits).toBe(1)
})

test('only the owner clears its own selection', () => {
  const s = createChatSelectionStore()
  s.set(state('newer'))
  s.clear('older')
  expect(s.get()?.owner).toBe('newer')
  s.clear('newer')
  expect(s.get()).toBeNull()
})
