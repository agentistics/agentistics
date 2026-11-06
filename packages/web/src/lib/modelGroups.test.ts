import { describe, expect, it } from 'bun:test'
import { groupModels, providerOf, trainsOnData } from './modelGroups'

const o = (id: string) => ({ id, label: id })

describe('groupModels', () => {
  it('stays flat for a single-vendor list', () => {
    expect(groupModels([o('opus'), o('sonnet')])).toBeNull()
    expect(groupModels([o('opencode-go/a'), o('opencode-go/b')])).toBeNull()
  })

  it('groups by provider prefix in first-appearance order', () => {
    const g = groupModels([o('opencode/big-pickle'), o('opencode-go/glm'), o('opencode/x-free'), o('ollama/qwen')])!
    expect(g.map(x => x.provider)).toEqual(['opencode', 'opencode-go', 'ollama'])
    expect(g[0]!.options.map(m => m.id)).toEqual(['opencode/big-pickle', 'opencode/x-free'])
  })

  it('puts a training model last in its group', () => {
    const g = groupModels([o('opencode-go/muse-spark-1.2-contributor'), o('opencode-go/glm'), o('ollama/q')])!
    expect(g[0]!.options.map(m => m.id)).toEqual(['opencode-go/glm', 'opencode-go/muse-spark-1.2-contributor'])
  })
})

describe('providerOf / trainsOnData', () => {
  it('reads the prefix', () => {
    expect(providerOf('opencode-go/glm-5.3-flash')).toBe('opencode-go')
    expect(providerOf('opus')).toBe('')
  })
  it('flags Muse Spark only', () => {
    expect(trainsOnData('opencode-go/muse-spark-1.3-contributor')).toBe(true)
    expect(trainsOnData('opencode-go/glm-5.3-flash')).toBe(false)
  })
})
