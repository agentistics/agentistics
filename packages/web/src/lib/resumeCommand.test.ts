import { test, expect } from 'bun:test'
import { resumeCommand } from './resumeCommand'
import type { SessionMeta, HarnessId } from '@agentistics/core'

function s(harness: HarnessId): SessionMeta {
  return { session_id: 'abc-123', project_path: '/home/u/proj', harness } as SessionMeta
}

test('claude yields cd + claude --resume', () => {
  expect(resumeCommand(s('claude'))).toBe("cd '/home/u/proj' && claude --resume abc-123")
})

test('every harness with a verified resume syntax gets a command', () => {
  // Each of these is taken from the tool's own --help, not guessed.
  expect(resumeCommand(s('antigravity'))).toBe("cd '/home/u/proj' && agy --conversation abc-123")
  expect(resumeCommand(s('codex'))).toBe("cd '/home/u/proj' && codex resume abc-123")
  expect(resumeCommand(s('copilot'))).toBe("cd '/home/u/proj' && copilot --resume abc-123")
  expect(resumeCommand(s('kimi'))).toBe("cd '/home/u/proj' && kimi -S session_abc-123")
})

test('a harness that cannot reopen a session by id yields null', () => {
  // Gemini's --resume takes "latest" or a list index, never a session id, and --session-id starts a
  // NEW session with that id. A wrong-but-plausible command would be worse than admitting it is
  // unavailable.
  expect(resumeCommand(s('gemini'))).toBeNull()
})

test('a session with no id yields null rather than a broken command', () => {
  expect(resumeCommand({ session_id: '', project_path: '/p', harness: 'claude' } as SessionMeta)).toBeNull()
})

test('without project_path the command runs in place, with no cd', () => {
  const noPath = { session_id: 'x', project_path: '', harness: 'claude' } as SessionMeta
  expect(resumeCommand(noPath)).toBe('claude --resume x')
  const agy = { session_id: 'y', project_path: '', harness: 'antigravity' } as SessionMeta
  expect(resumeCommand(agy)).toBe('agy --conversation y')
})
