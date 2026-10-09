import { describe, expect, it } from 'bun:test'
import { harnessOfPath, noteTranscriptActivity, onTranscriptActivity } from './transcript-activity'

const ROOTS = {
  kimi: '/home/u/.kimi-code/sessions',
  codex: '/home/u/.codex/sessions',
  claude: null,
} as const

describe('harnessOfPath', () => {
  it('names the harness whose session root a written path sits under', () => {
    expect(harnessOfPath('/home/u/.kimi-code/sessions/wd_x/session_1/agents/main/wire.jsonl', ROOTS)).toBe('kimi')
    expect(harnessOfPath('/home/u/.codex/sessions/2026/10/08/rollout-x.jsonl', ROOTS)).toBe('codex')
    expect(harnessOfPath('/home/u/.kimi-code/sessions', ROOTS)).toBe('kimi')
  })

  it('matches on a whole path segment, so a sibling directory with a longer name is not the root', () => {
    expect(harnessOfPath('/home/u/.kimi-code/sessions-old/x', ROOTS)).toBeNull()
    expect(harnessOfPath('/home/u/.kimi-code/logs/kimi-code.log', ROOTS)).toBeNull()
  })
})

describe('the activity channel', () => {
  it('delivers to every listener, survives a throwing one, and stops after unsubscribe', () => {
    const got: string[] = []
    const offBad = onTranscriptActivity(() => { throw new Error('boom') })
    const off = onTranscriptActivity(h => { got.push(h) })
    noteTranscriptActivity('kimi')
    off()
    noteTranscriptActivity('codex')
    offBad()
    expect(got).toEqual(['kimi'])
  })
})
