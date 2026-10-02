import { describe, expect, test } from 'bun:test'
import { resolveExperimental } from '@agentistics/core'
import { statusLines } from './cli-experimental'

describe('agentop experimental status wording', () => {
  test('says when an explicit variable overrides the preference', () => {
    const rows = resolveExperimental(true, { AGENTISTICS_JOURNAL: '0' })
    const text = statusLines(true, rows, 'en').join('\n')
    expect(text).toContain('kept off by AGENTISTICS_JOURNAL=0')
    expect(text).toContain('turned on by the preference')
  })
  test('off by default, in Portuguese', () => {
    const text = statusLines(undefined, resolveExperimental(undefined, {}), 'pt').join('\n')
    expect(text).toContain('DESLIGADOS')
    expect(text).toContain('desligado por padrão')
  })
})
