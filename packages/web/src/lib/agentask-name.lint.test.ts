import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The task board's product name is Agentask. "Entregas" / "Deliveries" must not come back as a
 * user-visible label: nav, page titles, notification categories, board copy.
 */
const root = join(import.meta.dir, '..')
const FILES = [
  'App.tsx', 'pages/TasksPage.tsx', 'lib/notificationCategories.ts', 'components/tasks/copy.ts',
  'components/tasks/SessionTasksTab.tsx',
]
const OLD = /['"`>]\s*(Entregas|Deliveries)\s*['"`<]/

test('the old product label does not appear in user-visible strings', () => {
  for (const f of FILES) {
    const hits = readFileSync(join(root, f), 'utf8').split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && OLD.test(l))
    expect({ f, hits }).toEqual({ f, hits: [] })
  }
})

test('every tasks component keeps the old label out of its strings', () => {
  const dir = join(root, 'components/tasks')
  for (const f of readdirSync(dir).filter(n => /\.tsx?$/.test(n) && !n.includes('.test.'))) {
    const hits = readFileSync(join(dir, f), 'utf8').split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && OLD.test(l))
    expect({ f, hits }).toEqual({ f, hits: [] })
  }
})
