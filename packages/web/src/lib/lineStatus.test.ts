import { expect, test } from 'bun:test'
import { lineStatusKind, lineStatusText, lineStatusWord } from './lineStatus'

test('the kind follows the activity signal first, then the state — the same sources, no new inference', () => {
  expect(lineStatusKind('waiting', 'heavy-lock')).toBe('queue')
  expect(lineStatusKind('waiting', 'tool')).toBe('cmd')
  expect(lineStatusKind('idle', 'heavy-hold')).toBe('cmd')
  expect(lineStatusKind('waiting', 'task')).toBe('task')
  expect(lineStatusKind('waiting', 'output')).toBe('writing')
  expect(lineStatusKind('working', undefined)).toBe('writing')
  expect(lineStatusKind('waiting', null)).toBe('you')
  expect(lineStatusKind('idle', undefined)).toBe('idle')
  // A dialog outranks activity evidence (the `liveAge` precedence).
  expect(lineStatusKind('waiting-approval', 'tool')).toBe('approval')
  // Ended and fallen rows never read as active, whatever a stale signal says.
  expect(lineStatusKind('exited', 'tool')).toBe('ended')
  expect(lineStatusKind('closed', undefined)).toBe('ended')
  expect(lineStatusKind('lost', undefined)).toBe('fell')
  expect(lineStatusKind('exited', undefined, true)).toBe('fell')
})

test('the tooltip says the full sentence in pt and en, never "rodando há agora"', () => {
  expect(lineStatusText('cmd', '1 min', true)).toBe('rodando há 1 min')
  expect(lineStatusText('cmd', '1 min', false)).toBe('running for 1 min')
  expect(lineStatusText('cmd', 'agora', true)).toBe('rodando agora')
  expect(lineStatusText('cmd', 'now', false)).toBe('running now')
  expect(lineStatusText('queue', null, true)).toBe('na fila de trabalho pesado')
  expect(lineStatusText('queue', '4 min', true)).toBe('na fila de trabalho pesado há 4 min')
  expect(lineStatusText('you', '3 h', true)).toBe('esperando você há 3 h')
  expect(lineStatusText('ended', '14:30', true)).toBe('encerrada · 14:30')
  expect(lineStatusText('fell', 'há 3 h', true)).toBe('caiu há 3 h')
  expect(lineStatusText('fell', '3 h ago', false)).toBe('fell 3 h ago')
  for (const k of ['writing', 'cmd', 'task', 'queue', 'approval', 'you', 'idle', 'ended', 'fell'] as const) {
    expect(lineStatusWord(k, true).length).toBeGreaterThan(0)
    expect(lineStatusWord(k, false).length).toBeGreaterThan(0)
    expect(lineStatusWord(k, true)).not.toBe(lineStatusWord(k, false))
  }
})
