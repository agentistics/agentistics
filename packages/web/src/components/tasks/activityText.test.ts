import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { TaskStatusDef } from '@agentistics/core'
import { activitySentence } from './activityText'
import { statusViewItems } from './statusDefaults'
import { liveStatusMap } from './board'

/** Every `kind` the server can write into the activity log, read off its own sources. */
function serverEventKinds(): string[] {
  const dir = join(import.meta.dir, '../../../../server/server/sessions')
  const kinds = new Set<string>()
  for (const f of ['task-web.ts', 'task-store.ts']) {
    const src = readFileSync(join(dir, f), 'utf8')
    for (const m of src.matchAll(/\bevent\([^,\n]+,[^\n]*?,\s*'([a-z_-]+)'\s*[,)]/g)) kinds.add(m[1]!)
    for (const m of src.matchAll(/event\([^)]*\),\s*subtaskId\s*\}|\bkind:\s*'([a-z_-]+)',\s*at:/g)) if (m[1]) kinds.add(m[1])
  }
  return [...kinds].sort()
}

describe('activity sentences in pt', () => {
  test('the server really writes the kinds this test expects to cover', () => {
    const k = serverEventKinds()
    for (const want of ['status', 'claim', 'release', 'priority', 'type', 'session', 'move', 'comment', 'step', 'create']) {
      expect(k).toContain(want)
    }
  })
  test('step event is translated', () => {
    expect(activitySentence({ kind: 'step', to: '3', detail: 'passo 3' }, 'pt')).toBe('avançou para o passo 3')
  })
  test('no event kind the server writes ever prints the raw kind in pt', () => {
    for (const kind of serverEventKinds()) {
      const text = activitySentence({ kind, to: 'x', from: 'y', detail: 'z' }, 'pt')
      expect(text).not.toBe(kind)
      expect(text.toLowerCase()).not.toBe(kind.toLowerCase())
      expect(text).not.toMatch(/^(step|type|create|status|claim|release|priority|session|move|comment)$/i)
    }
  })
  test('an unknown future kind gets a generic pt sentence', () => {
    expect(activitySentence({ kind: 'brand_new_kind' }, 'pt')).toBe('atualizou a tarefa')
  })
})

describe('the Visualização popover names statuses in pt', () => {
  const def = (id: string, label: string, order: number) =>
    ({ id, label, color: '#999', order, protected: false } as unknown as TaskStatusDef)
  const LIST = [def('todo', 'To do', 0), def('in_progress', 'In progress', 1), def('blocked', 'Blocked', 2), def('done', 'Done', 3), def('qa', 'Ready for QA', 4)]
  test('protected statuses are translated, an explicit custom name is kept', () => {
    const items = statusViewItems(LIST, 'pt', () => 0)
    expect(items.map(i => i.label)).toEqual(['A fazer', 'Em andamento', 'Bloqueado', 'Concluído', 'Ready for QA'])
  })
  test('en keeps the stored names', () => {
    expect(statusViewItems(LIST, 'en', () => 0).map(i => i.label)).toEqual(['To do', 'In progress', 'Blocked', 'Done', 'Ready for QA'])
  })
  test('the shared status map (chips, headers, WIP rows) agrees', () => {
    expect(liveStatusMap(LIST, 'pt').todo!.label).toBe('A fazer')
  })
})
