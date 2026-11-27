import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionJsonl } from './jsonl'

/**
 * `daily[day].messages` must count what `user_message_count + assistant_message_count` counts —
 * a PERSON's turn plus each assistant line — and never a tool result fed back under the user's
 * role, nor an entry the harness injected (`isMeta`, `isCompactSummary`). Measured on a real store
 * (2026-11-27): Σ daily.messages was 153 % of the lifetime messages, because every tool_result line
 * was a "message" on its day, so every date-filtered "Messages" card read ~50 % high.
 */
test('daily messages add up to the lifetime user + assistant counters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-msgs-'))
  try {
    const at = (t: string) => `2026-11-0${t}`
    const lines = [
      { type: 'user', timestamp: at('2T10:00:00Z'), message: { role: 'user', content: 'do it' } },
      { type: 'assistant', timestamp: at('2T10:00:01Z'), message: { id: 'a1', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', timestamp: at('2T10:00:02Z'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'user', timestamp: at('2T10:00:03Z'), isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } },
      { type: 'assistant', timestamp: at('2T10:00:04Z'), message: { id: 'a2', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', timestamp: at('3T10:00:00Z'), isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } },
      { type: 'user', timestamp: at('3T10:00:05Z'), message: { role: 'user', content: 'again' } },
      { type: 'assistant', timestamp: at('3T10:00:06Z'), message: { id: 'a3', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: at('3T10:00:07Z'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    ]
    const file = join(dir, 's.jsonl')
    writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const s = await parseSessionJsonl(file, 's', '/repo', 'jsonl')
    const life = s.user_message_count + s.assistant_message_count
    expect(life).toBe(5)
    const perDay = Object.values(s.daily ?? {}).reduce((a, d) => a + d.messages, 0)
    expect(perDay).toBe(life)
    const days = Object.keys(s.daily ?? {}).sort()
    expect(days.length).toBe(2)
    // The DIVISION matters, not only the sum: the person's turn is filed on the day it happened
    // (02: prompt + 2 assistant lines = 3; 03: prompt + 1 assistant line = 2). The compact summary
    // that opens day 03 is not a message and must not move it.
    expect(s.daily![days[0]!]!.messages).toBe(3)
    expect(s.daily![days[1]!]!.messages).toBe(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
