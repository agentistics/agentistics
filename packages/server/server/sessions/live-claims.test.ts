import { describe, expect, test } from 'bun:test'
import { processClaims } from './live-claims'

describe('processClaims', () => {
  const SES = 'ses_e7030a1bbffeIklK1ILCtj7v2H'
  test('a process the scan linked by itself (opencode log, argv, open file) holds its conversation', () => {
    const out = processClaims([{ harness: 'opencode', cwd: '/p', pid: 7, sessionId: SES }], () => undefined)
    expect(out).toEqual([{ id: `external:opencode:${SES}`, kind: 'process', pid: 7, alive: true, conversationId: SES, label: '/p' }])
  })
  test('the harness\'s own record for the pid wins over the scan', () => {
    const out = processClaims([{ harness: 'claude', cwd: '/p', pid: 7, sessionId: 'from-argv' }], () => 'from-record')
    expect(out[0]!.conversationId).toBe('from-record')
  })
  test('a process that names no conversation claims nothing', () => {
    expect(processClaims([{ harness: 'codex', cwd: '/p', pid: 7 }], () => undefined)).toEqual([])
  })
})
