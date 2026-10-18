import { expect, test } from 'bun:test'
import { emptyClaudeParse, foldClaudeParse } from './jsonl'

test('Claude activity and replacement usage stay on the local BRT day after UTC midnight', () => {
  // bun test runs in UTC without setting TZ, so `delete` would fall back to the host zone
  const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  process.env.TZ = 'America/Sao_Paulo'
  try {
    const state = emptyClaudeParse()
    const turn = (timestamp: string, output: number) => JSON.stringify({
      type: 'assistant', timestamp, cwd: '/repo',
      message: { id: 'response', model: 'claude-opus-5', content: [], usage: {
        input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      } },
    })
    foldClaudeParse(state, [turn('2026-10-18T01:00:00Z', 1), turn('2026-10-18T02:59:00Z', 20)])
    expect([...state.daily.keys()]).toEqual(['2026-10-17'])
    expect(state.daily.get('2026-10-17')!.output_tokens).toBe(20)
    expect(state.daily.has('2026-10-18')).toBe(false)
  } finally {
    process.env.TZ = previous
  }
})
