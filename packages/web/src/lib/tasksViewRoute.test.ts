import { expect, test } from 'bun:test'
import { pathOfView, viewOfPath } from './tasksViewRoute'
import { APP_AREAS, areaOfPath } from './appAreas'

test('every view round-trips through its route', () => {
  for (const v of ['overview', 'board', 'table', 'live'] as const) expect(viewOfPath(pathOfView(v))).toBe(v)
  expect(viewOfPath('/tasks')).toBeNull(); expect(viewOfPath('/tasks/t-123')).toBeNull(); expect(viewOfPath('/tasks/live/')).toBe('live')
})

test('the Agentask area lists each real view and highlights the active one', () => {
  const pages = APP_AREAS.find(a => a.id === 'tasks')!.pages
  expect(pages.map(p => p.id)).toEqual(['board', 'metrics', 'table', 'live', 'activity'])
  expect(areaOfPath('/tasks/live')!.page!.id).toBe('live')
  expect(areaOfPath('/tasks/t-123')!.page!.id).toBe('board')
  expect(areaOfPath('/tasks')!.page!.id).toBe('board')
})
