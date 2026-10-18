import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchRoutes } from 'react-router-dom'

test('activity and Actions routes resolve alongside the existing task and repository URLs', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'AppRouter.tsx'), 'utf8')
  const routes = [...source.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map(match => ({ path: match[1]! }))
    .filter(route => /^(tasks|repositories|repo)(\/|$)/.test(route.path))
  const resolved = (url: string) => matchRoutes(routes, url)?.at(-1)?.route.path

  expect(resolved('/tasks/activity')).toBe('tasks/activity')
  expect(resolved('/tasks/t-xxx')).toBe('tasks/:id')
  expect(resolved('/tasks')).toBe('tasks')
  expect(resolved('/repositories/actions')).toBe('repositories/actions')
  expect(resolved('/repositories')).toBe('repositories')
  expect(resolved('/repo/github.com%2Fteam%2Frepo')).toBe('repo/:id')
  expect(source.indexOf('<Route path="tasks/activity"')).toBeLessThan(source.indexOf('<Route path="tasks/:id"'))
})
