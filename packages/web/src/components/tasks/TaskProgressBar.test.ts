import { describe, expect, it } from 'bun:test'
import { progressTooltipModel } from './TaskProgressBar'

const statuses = [
  { id: 'todo', label: 'To do', color: '#111111', protected: true, order: 0 },
  { id: 'in_progress', label: 'Em andamento', color: '#f97316', protected: true, order: 1 },
  { id: 'in_review', label: 'Em revisão', color: '#8b5cf6', protected: false, order: 2 },
  { id: 'done', label: 'Concluído', color: '#22c55e', protected: true, order: 3 },
]

describe('progressTooltipModel', () => {
  it('orders statuses by the board vocabulary and keeps their colours', () => {
    const model = progressTooltipModel(2, 4, 50, { done: 2, in_review: 1, todo: 1 }, statuses, 'pt')
    expect(model.statuses.map(s => s.id)).toEqual(['todo', 'in_review', 'done'])
    expect(model.statuses.map(s => s.color)).toEqual(['#111111', '#8b5cf6', '#22c55e'])
  })

  it('builds the localized breakdown and caps group titles at eight', () => {
    const model = progressTooltipModel(12, 13, 92, { in_review: 12, todo: 1 }, statuses, 'pt', Array.from({ length: 14 }, (_, i) => `M${i}`))
    expect(model.summary).toBe('12 de 13 concluídas (92%)')
    expect(model.statuses.map(s => `${s.label} ${s.count}`)).toEqual(['A fazer 1', 'Em revisão 12'])
    expect(model.titles).toHaveLength(8)
    expect(model.moreTitles).toBe(6)
  })
})
