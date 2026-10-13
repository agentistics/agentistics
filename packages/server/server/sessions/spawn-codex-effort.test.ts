import { expect, test } from 'bun:test'
import { planSpawn, SPAWN_SPECS } from './spawn-spec'

test('Codex effort follows the verified config key on fresh spawn and fallback resume', () => {
  for (const effort of SPAWN_SPECS.codex!.efforts!) {
    const result = planSpawn({ harness: 'codex', cwd: '/tmp', model: 'gpt-6.1-sol', effort, resumeId: 'thread-1' }, { codexNoDaemon: true })
    expect(result).toEqual({ ok: true, plan: { argv: ['codex', '--no-daemon', 'resume', 'thread-1', '--model', 'gpt-6.1-sol', '-c', `model_reasoning_effort="${effort}"`], conversationId: 'thread-1' } })
  }
  expect(planSpawn({ harness: 'codex', cwd: '/tmp', effort: 'invalid' }).ok).toBe(false)
})

test('Codex without effort retains the exact terminal argv', () => {
  expect(planSpawn({ harness: 'codex', cwd: '/tmp', prompt: 'hello' }, { codexNoDaemon: true })).toEqual({ ok: true, plan: { argv: ['codex', '--no-daemon', 'hello'], initialPrompt: { mode: 'submit' } } })
})

test('older Codex preserves model and effort on fresh spawn and resume without --no-daemon', () => {
  for (const effort of SPAWN_SPECS.codex!.efforts!) {
    for (const resumeId of [undefined, 'thread-1']) {
      const result = planSpawn({ harness: 'codex', cwd: '/tmp', model: 'gpt-6.1-sol', effort, resumeId }, { codexNoDaemon: false })
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.plan.argv).toEqual(['codex', ...(resumeId ? ['resume', resumeId] : []), '--model', 'gpt-6.1-sol', '-c', `model_reasoning_effort="${effort}"`])
    }
  }
})
