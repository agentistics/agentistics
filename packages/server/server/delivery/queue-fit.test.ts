import { expect, test } from 'bun:test'
import { sharedQueueArea } from './queue-fit'

test('placement uses explicit files, area tags and the same UI surface, never generic prose', () => {
  expect(sharedQueueArea('Fix packages/web/src/A.tsx', 'Extend packages/web/src/A.tsx.')).toEqual(['file:packages/web/src/a.tsx'])
  expect(sharedQueueArea('area: sidebar, sessions', 'surface: sessions')).toEqual(['area:sessions'])
  expect(sharedQueueArea('Fix Histórico', 'History column size')).toEqual(['surface:history'])
  expect(sharedQueueArea('Fix tests', 'Fix unrelated tests')).toEqual([])
  expect(sharedQueueArea('Fix packages/web/src/A.tsx', 'Fix packages/web/src/B.tsx')).toEqual([])
})
